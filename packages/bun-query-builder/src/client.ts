/* eslint-disable regexp/no-super-linear-backtracking */

/* eslint-disable no-useless-catch */
import type { SchemaMeta } from './meta'
import type { ResolvedPivot } from './pivot'
import type { DatabaseSchema, AnyDatabaseSchema } from './schema'
import type { QueryBuilderOptions, QueryHooks, SupportedDialect} from './types'
import { config, getPlaceholder, getPlaceholders, isMysqlLike, setConfig } from './config'
import type { DriverConnection } from './db'
import { bunSql, getOrCreateBunSql, resetConnection } from './db'
import { resolvePivot } from './pivot'
import { singularizerFor } from './inflect'
import type { WhereTerm } from './sql-fragments'
import { FALSE_PREDICATE, renderInPredicate, renderWhereTerms } from './sql-fragments'

export { resetConnection }

// Type guard for raw SQL expressions
interface RawExpression {
  raw: string
}

function isRawExpression(expr: unknown): expr is RawExpression {
  return typeof expr === 'object' && expr !== null && 'raw' in expr && typeof (expr as RawExpression).raw === 'string'
}

interface BoundSqlExpression {
  sql: string
  parameters?: readonly unknown[]
}

/**
 * Render one `{ column: value }` entry of an object-form where() as a
 * predicate, appending its bound parameters to `params`.
 *
 * An array value means IN. The select builder has read it that way since
 * #1013/#1083; the write builders bound the whole array to a single
 * placeholder, so `where({ id: [3, 2] })` selected two rows on a SELECT and
 * matched nothing on an UPDATE or a DELETE — silently, reporting success. The
 * bulk delete of a set of ids is exactly the call people write it for.
 *
 * An empty array renders as `1 = 0` rather than disappearing, which is what
 * the select builder does and the only safe reading on a write: a filter the
 * caller supplied must never widen to "every row".
 *
 * Shared by all three write paths so they cannot drift apart again — the
 * divergence, not any one branch, is what kept producing these. See #1114.
 */
function renderColumnCondition(column: string, value: unknown, params: unknown[]): string {
  if (Array.isArray(value)) {
    const placeholders = getPlaceholders(value.length, params.length + 1)
    const clause = renderInPredicate(column, value, false, placeholders)
    params.push(...value)
    return clause
  }
  const clause = `${column} = ${getPlaceholder(params.length + 1)}`
  params.push(value)
  return clause
}

function isBoundSqlExpression(expr: unknown): expr is BoundSqlExpression {
  return typeof expr === 'object'
    && expr !== null
    && 'sql' in expr
    && typeof (expr as BoundSqlExpression).sql === 'string'
    && (!('parameters' in expr) || Array.isArray((expr as BoundSqlExpression).parameters))
}

/**
 * Render a parameterized SQL expression at its current position in a query.
 *
 * SQLite and MySQL use `?` placeholders as emitted. PostgreSQL placeholders
 * are positional, so rewrite only as many markers as the fragment has bound
 * parameters and start after the query parameters already collected.
 */
function renderBoundSqlExpression(expression: BoundSqlExpression, startIndex: number): { text: string, parameters: readonly unknown[] } {
  const parameters = expression.parameters ?? []
  if (config.dialect !== 'postgres' || parameters.length === 0)
    return { text: expression.sql, parameters }

  let parameterIndex = 0
  const text = expression.sql.replace(/\?/g, (placeholder) => {
    if (parameterIndex >= parameters.length)
      return placeholder
    return getPlaceholder(startIndex + parameterIndex++)
  })

  if (parameterIndex !== parameters.length) {
    throw new TypeError(
      `[query-builder] SQL expression declares ${parameters.length} parameters but contains only ${parameterIndex} placeholders`,
    )
  }

  return { text, parameters }
}

/**
 * # `raw`
 *
 * Build a raw SQL fragment for the `*Raw` builder methods (`whereRaw`,
 * `selectRaw`, `orderByRaw`, `groupByRaw`, `havingRaw`) and `select()`.
 *
 * Use this INSTEAD of a Bun `sql\`...\`` tag: a Bun query object cannot be
 * converted back to SQL text (it stringifies to "[object Promise]"), so it
 * silently corrupts the generated SQL. `raw` returns a `{ raw: string }`
 * fragment that the builder renders correctly and that satisfies the
 * `SqlFragment` type (so it passes the bare-string injection guard).
 *
 * Interpolated values in the tagged-template form are SQL-escaped (strings
 * single-quote-doubled, dates → ISO, numbers/booleans/null inlined) — the
 * same escaping the relation-subquery builders use. For user input that must
 * be parameterised, prefer the typed `where(...)` methods over `raw`.
 *
 * @example
 * ```ts
 * import { raw } from 'bun-query-builder'
 * db.selectFrom('users').selectRaw(raw`count(*) as c`)
 * db.selectFrom('users').whereRaw(raw('age > 18'))
 * db.selectFrom('users').orderByRaw(raw`created_at desc`)
 * db.selectFrom('orders').whereRaw(raw`status = ${userStatus}`) // value escaped
 * ```
 */
export function raw(strings: TemplateStringsArray | string, ...values: unknown[]): RawExpression {
  if (typeof strings === 'string')
    return { raw: strings }
  let out = strings[0]
  for (let i = 0; i < values.length; i++)
    out += formatSubqueryValue(values[i]) + strings[i + 1]
  return { raw: out }
}

/** Dialect-aware identifier quoting for the explicit INSERT builders (#1052). */
function quoteInsertIdent(id: string): string {
  return isMysqlLike(config.dialect)
    ? `\`${id.replace(/`/g, '``')}\``
    : `"${id.replace(/"/g, '""')}"`
}

/**
 * Build the `(c1, c2) VALUES (?, ?), (?, ?)` fragment + flattened params for an
 * INSERT, with dialect-aware placeholders. Used by upsert/insertOrIgnore/
 * insertGetId/updateOrInsert, which previously relied on Bun's
 * `${sql(table)} ${sql(values)}` helper composition — broken on every dialect
 * (Postgres "Cannot INSERT with no columns" + no sqlite values-helper). See
 * stacksjs/bun-query-builder#1052.
 */
function buildInsertClause(rows: Record<string, any>[], startIndex = 1): { colsSql: string, valuesSql: string, params: any[], nextIndex: number } {
  const cols = Object.keys(rows[0] ?? {})
  const params: any[] = []
  let idx = startIndex
  const tuples = rows.map((row) => {
    const phs = cols.map((c) => {
      params.push(row[c])
      return getPlaceholder(idx++)
    })
    return `(${phs.join(', ')})`
  })
  return {
    colsSql: cols.map(quoteInsertIdent).join(', '),
    valuesSql: tuples.join(', '),
    params,
    nextIndex: idx,
  }
}

/** Options shared by the generalized window functions (#1050). */
interface WindowOpts {
  partitionBy?: string | string[]
  orderBy?: [string, 'asc' | 'desc'][]
  /** Output column alias (each window helper has a sensible default). */
  alias?: string
}

/**
 * Whether slow-query reporting is active, so the prepared-statement fast paths
 * (which otherwise bypass runWithHooks) still route through it to measure
 * duration. See stacksjs/bun-query-builder#1045.
 */
function hasSlowQueryHook(h: any): boolean {
  return Boolean(h && (h.onSlowQuery || (h.slowQueryThresholdMs != null && h.slowQueryThresholdMs >= 0)))
}

/**
 * Render a SELECT-list entry to its SQL text, unwrapping SQL fragments instead
 * of letting them stringify to "[object Object]" (stacksjs/bun-query-builder#1016).
 *
 * Handles every fragment shape in play:
 *   - plain column string                       → as-is
 *   - RawExpression `{ raw: string }`           → `.raw` (sql.raw(...) markers)
 *   - tagged-template builder `{ raw(): string }`→ `raw()`
 *   - `{ sql: string, parameters }` fragment    → `.sql` (the shape a `sql`…``
 *                                                  tagged template emits)
 *   - anything else with a useful `toString`    → `String(col)`
 * Text-only, mirroring `selectRaw` — bound parameters inside a select-list
 * fragment are not threaded (the documented use is literal expressions like
 * `count(*) as c`).
 */
/**
 * A plain identifier, quoted for MySQL. Anything else is left exactly as written.
 *
 * MySQL reserves words this schema uses as ordinary column names - `condition`,
 * `uses`, `key`, `groups`, `rank` - and an unquoted one is a syntax error at
 * that point in the statement, not a bad-column error. ReviewOS met it as a
 * `SELECT` of a workflow job's columns failing 167 times in one run: the
 * columns are perfectly legal, and only the spelling was wrong.
 *
 * Only a bare `name` or a qualified `table.name` is quoted. An expression, an
 * alias, a `count(*)`, a `*`, anything already quoted: untouched, because
 * quoting those would break them.
 *
 * MySQL only, deliberately. On Postgres a quoted identifier becomes
 * case-*sensitive*, so quoting `createdAt` would stop it matching the
 * `createdat` the server actually stored - a fix that breaks a working query.
 * MySQL's identifiers are case-insensitive on every platform this runs on, so
 * the quoting changes nothing but the parse.
 */
export function quoteColumnForDialect(name: string, dialect = config.dialect): string {
  if (!isMysqlLike(dialect))
    return name

  /*
   * `column`, `table.column`, and either of those with an `AS alias`. The alias
   * is quoted too: `... AS condition` is the same reserved word in the same
   * statement, and a select list of `t.condition as condition` was the second
   * shape of this bug, found after the first fix went out.
   */
  const parsed = /^([A-Z_][\w$]*)(?:\.([A-Z_][\w$]*))?(?:\s+as\s+([A-Z_][\w$]*))?$/i.exec(name.trim())

  if (!parsed)
    return name

  const [, first, second, alias] = parsed
  const column = second ? `\`${first}\`.\`${second}\`` : `\`${first}\``

  return alias ? `${column} AS \`${alias}\`` : column
}

/**
 * A date, in the literal shape the dialect will accept.
 *
 * `new Date().toISOString()` is `2026-08-19T04:37:11.396Z`, which Postgres
 * takes and MySQL refuses outright - "Incorrect datetime value" - because the
 * `T`, the fraction and the `Z` are all outside what a `DATETIME` literal may
 * contain. So an application that writes the obvious thing is correct until the
 * engine changes under it, and then it is not, at the point of the write.
 *
 * Naive UTC, deliberately: a `DATETIME` stores no zone, and reading one back as
 * though it were local is the other half of the same bug.
 */
export function temporalLiteral(value: unknown, dialect = config.dialect): unknown {
  if (!isMysqlLike(dialect) || value === null || value === undefined)
    return value

  /*
   * A string is reshaped as text, never through `new Date()`. Parsing
   * `2026-08-19T04:37:11` - an ISO string with no zone - reads it as *local*
   * time, and `toISOString()` then shifts the digits by the host's offset: the
   * value arrives seven hours out on a machine seven hours behind UTC, having
   * been "fixed". The digits are what a naive column stores, so the digits are
   * what is kept.
   */
  if (typeof value === 'string') {
    const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value)

    if (!iso)
      return value

    const [, day, time] = iso

    return `${day} ${time!.length === 5 ? `${time}:00` : time}`
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    return value

  return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function renderSelectColumn(col: unknown): string {
  if (typeof col === 'string')
    return quoteColumnForDialect(col)
  if (isRawExpression(col))
    return col.raw
  if (col && typeof col === 'object') {
    const anyCol = col as { raw?: unknown, sql?: unknown }
    if (typeof anyCol.raw === 'function')
      return String((anyCol.raw as () => unknown)())
    if (typeof anyCol.sql === 'string')
      return anyCol.sql
    const str = String(col)
    if (str !== '[object Object]')
      return str
  }
  throw new TypeError(
    `[query-builder] select(): unsupported column ${String(col)} — pass a column name, a string[], or a SQL fragment (e.g. sql\`count(*) as c\`)`,
  )
}

/**
 * Does this SQL have an `ORDER BY` of its own, at paren depth 0?
 *
 * Depth-aware because a subquery in the FROM list or an `IN (SELECT … ORDER BY
 * …)` carries its own, and matching that one would reject a query whose outer
 * SELECT is unordered.
 */
function hasTopLevelOrderBy(s: string): boolean {
  const re = /\(|\)|\bORDER\s+BY\b/gi
  let depth = 0
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(s))) {
    if (m[0] === '(') { depth++ }
    else if (m[0] === ')') { depth = Math.max(0, depth - 1) }
    else if (depth === 0) { return true }
  }
  return false
}

// Pre-compiled regex patterns for performance
const SQL_PATTERNS = {
  SELECT_STAR: /^SELECT\s+\*/i,
  SELECT: /^SELECT\s+/i,
  SELECT_FROM: /^SELECT\s+(.+?)\s+FROM/i,
  WHERE: /\bWHERE\b/i,
  ORDER_BY: /\bORDER\s+BY\b/i,
  GROUP_BY: /\bGROUP\s+BY\b/i,
  // LIMIT/OFFSET regexes deliberately match a trailing-clause shape so
  // `replace(LIMIT, ` LIMIT N`)` swaps the entire existing clause without
  // also corrupting any LIMIT mentioned inside a subquery earlier in the
  // SQL (subqueries are wrapped in parens).
  LIMIT: /\sLIMIT\s+\d+/i,
  OFFSET: /\sOFFSET\s+\d+/i,
  IDENTIFIER: /^[A-Z_][\w.]*$/i,
  DELETED_AT: /\bdeleted_at\b/i,
} as const

// Allow-list of SQL comparison operators that can be safely
// interpolated into a query fragment. Anything outside this set
// is rejected at the boundary so a caller can't smuggle
// `= 1 OR 1=1 --` through the `op` slot of a relationship-subquery
// callback. See stacksjs/stacks#1858 Q-1 / Q-4 / Q-5 / Q-6.
//
// Module-level constant: the set never varies, so we allocate it
// once rather than rebuilding it inside every makeSelect closure.
const SAFE_WHERE_OPERATORS = new Set([
  '=', '!=', '<>', '<', '<=', '>', '>=',
  'like', 'not like', 'ilike', 'not ilike',
  'in', 'not in', 'is', 'is not', 'between', 'not between',
])

// Validate a SQL identifier (table/column name) before interpolation.
// Module-level so it is reachable from every helper in createQueryBuilder
// — notably applyCondition(), which previously referenced a copy scoped
// inside makeSelect() and would throw a ReferenceError on the array-form
// `.where([col, op, val])` path. Depends only on SQL_PATTERNS.
function validateIdentifier(name: string, context?: string): void {
  if (!SQL_PATTERNS.IDENTIFIER.test(name)) {
    const contextMsg = context ? ` in ${context}` : ''
    throw new Error(`[query-builder] Invalid identifier${contextMsg}: '${name}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
  }
}

// The helpers below are module-level on purpose: they are stateless, and
// declaring them inside makeSelect() allocated a fresh closure for each of
// them on EVERY selectFrom() call — pure per-query overhead.

function assertSafeWhereOperator(op: unknown, context: string): string {
  if (typeof op !== 'string')
    throw new TypeError(`[query-builder] ${context}: operator must be a string, got ${typeof op}`)
  const lower = op.toLowerCase()
  if (!SAFE_WHERE_OPERATORS.has(lower))
    throw new TypeError(`[query-builder] ${context}: refusing to use '${op}' as a SQL operator — not in the allowed set (${[...SAFE_WHERE_OPERATORS].join(', ')})`)
  return op
}

/**
 * Like `validateIdentifier`, but allows one optional `table.`
 * prefix so qualified column references (`users.id`, `posts.title`)
 * pass through. Each segment must independently match the strict
 * identifier shape — `users.id; --` is still rejected.
 */
function validateQualifiedIdentifier(value: unknown, context: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`[query-builder] ${context}: identifier must be a non-empty string, got ${typeof value}`)
  if (value.length > 129) // 64 + '.' + 64
    throw new TypeError(`[query-builder] ${context}: identifier '${value}' too long`)
  const parts = value.split('.')
  if (parts.length > 2)
    throw new TypeError(`[query-builder] ${context}: identifier '${value}' has more than one dot — only \`table.column\` is allowed`)
  for (const part of parts) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(part))
      throw new TypeError(`[query-builder] ${context}: identifier segment '${part}' contains characters outside [A-Za-z0-9_]`)
  }
}

/**
 * Render a `*Raw` fragment to SQL text.
 *
 * The TS signature is `SqlFragment = object` so a bare string `whereRaw('foo')`
 * fails to compile, but bare strings are still accepted at runtime (with a
 * once-per-process warning) for `as any` callers and compile-time-known
 * constants. See stacksjs/stacks#1858 Q-3.
 *
 * Critically, this throws a CLEAR error for a fragment that can't be rendered
 * — notably a Bun `sql\`...\`` query object, which stringifies to
 * "[object Promise]". Previously every *Raw method did a bare `String(fragment)`,
 * so following the documented `sql\`...\`` path silently emitted
 * "[object Promise]" into the SQL and failed at execution. Use the exported
 * `raw` helper instead (it produces a `{ raw }` fragment).
 */
function renderRawFragment(fragment: unknown, context: string): string {
  if (typeof fragment === 'string') {
    warnOnceBareSqlFragment(context)
    return fragment
  }
  if (fragment === null || fragment === undefined)
    throw new TypeError(`[query-builder] ${context}: fragment must be a SqlFragment, got ${fragment}`)
  if (isRawExpression(fragment))
    return fragment.raw
  if (typeof fragment === 'object') {
    const f = fragment as { raw?: unknown, sql?: unknown }
    if (typeof f.raw === 'string')
      return f.raw
    if (typeof f.raw === 'function') {
      const r = (f.raw as () => unknown)()
      if (typeof r === 'string')
        return r
    }
    if (typeof f.sql === 'string')
      return f.sql
    const s = String(fragment)
    if (s !== '[object Object]' && s !== '[object Promise]')
      return s
  }
  throw new TypeError(
    `[query-builder] ${context}: cannot render this value as a SQL fragment. `
    + `A Bun \`sql\`...\`\` query object cannot be converted to SQL text — pass a `
    + `string, or use the exported \`raw\` helper: raw\`count(*) as c\` / raw('age > 18').`,
  )
}

// Module-scoped Set so we warn at most once per call site per process
// lifetime (previously this lived inside makeSelect, so it actually
// warned once per BUILDER — i.e. on every query).
const warnedSqlFragmentContexts = new Set<string>()
function warnOnceBareSqlFragment(context: string): void {
  if (warnedSqlFragmentContexts.has(context)) return
  warnedSqlFragmentContexts.add(context)
  console.warn(
    `[query-builder] ${context}: bare string passed to a *Raw method. `
    + `Prefer the \`raw\`...\`\` tagged template, which escapes interpolated `
    + `values for the configured dialect — concatenating request input into SQL `
    + `is an injection vector. This will become a hard error in a future release.`,
  )
}

/**
 * Format a value for safe interpolation into a relationship-subquery
 * fragment. Numbers / booleans / null pass through; everything else is
 * rejected.
 *
 * **Strings are escaped for the configured dialect, not just for ANSI.**
 * Doubling the single quote is correct on Postgres and SQLite and is not
 * sufficient on the MySQL family, where a backslash is itself an escape
 * character unless NO_BACKSLASH_ESCAPES is set. Doubling alone lets
 * `x\'; DROP TABLE t; --` through: it becomes `'x\''; DROP TABLE t; --'`,
 * MySQL reads `\'` as a literal quote inside the string, the next quote closes
 * it, and the remainder executes as its own statement.
 *
 * So on a MySQL-like dialect the backslash is doubled first. Order matters:
 * escaping quotes first and backslashes second would re-escape the backslash
 * this function had just introduced.
 */
export function escapeStringLiteral(value: string, dialect: SupportedDialect = config.dialect): string {
  return isMysqlLike(dialect)
    ? value.replace(/\\/g, '\\\\').replace(/'/g, '\'\'')
    : value.replace(/'/g, '\'\'')
}

function formatSubqueryValue(val: unknown): string {
  if (val === null) return 'NULL'
  if (typeof val === 'number' && Number.isFinite(val)) return String(val)
  if (typeof val === 'boolean') return val ? '1' : '0'
  if (typeof val === 'string') return `'${escapeStringLiteral(val)}'`
  // Dates are common in relation/`with()` constraints — emit an escaped ISO
  // literal rather than rejecting the value.
  if (val instanceof Date) return `'${val.toISOString()}'`
  throw new TypeError(`[query-builder] subquery condition: refusing to interpolate value of type ${typeof val}`)
}

// Shared OVER (...) builder for the window functions (rowNumber/rank/... and
// lag/lead/sumOver/...). Stateless — see the note above on module-level helpers.
function buildOverClause(partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]): string {
  const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
  const parts: string[] = []
  if (cols.length)
    parts.push(`PARTITION BY ${cols.join(', ')}`)
  if (orderBy && orderBy.length)
    parts.push(`ORDER BY ${orderBy.map(([c, d]) => `${c} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`)
  return parts.length ? `OVER (${parts.join(' ')})` : 'OVER ()'
}

// Simple query cache with TTL support
interface CacheEntry {
  data: any
  expiresAt: number
}

class QueryCache {
  private cache = new Map<string, CacheEntry>()
  private maxSize = 100

  get<T = unknown>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry)
      return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    // True LRU: a Map iterates in insertion order, so re-inserting on every
    // hit keeps the least-recently-USED entry first. The previous version
    // skipped this step, which made eviction FIFO — hot entries were evicted
    // as readily as cold ones once the cache filled.
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.data
  }

  set(key: string, data: unknown, ttlMs: number): void {
    // Re-inserted keys must move to the back or they'd be evicted as if old.
    if (this.cache.has(key))
      this.cache.delete(key)

    if (this.cache.size >= this.maxSize) {
      // Prefer dropping expired entries over live ones; entries are checked
      // in least-recently-used order so the scan usually ends immediately.
      const now = Date.now()
      let evicted = false
      for (const [k, v] of this.cache) {
        if (now > v.expiresAt) {
          this.cache.delete(k)
          evicted = true
          if (this.cache.size < this.maxSize)
            break
        }
      }
      if (!evicted) {
        // No expired entries — evict the least recently used (first) one.
        const lruKey = this.cache.keys().next().value
        if (lruKey !== undefined)
          this.cache.delete(lruKey)
      }
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }

  setMaxSize(size: number): void {
    this.maxSize = Math.max(0, Math.floor(size))
    // Lowering the cap has to take effect NOW. Previously the cache kept every
    // entry it already held and only started evicting on the next `set()`, so
    // shrinking the cache to bound memory left the old entries resident
    // indefinitely if no further queries were cached.
    while (this.cache.size > this.maxSize) {
      const lruKey = this.cache.keys().next().value
      if (lruKey === undefined) break
      this.cache.delete(lruKey)
    }
  }
}

const queryCache = new QueryCache()

// Where condition helpers
type Primitive = string | number | boolean | bigint | Date | null | undefined
type ValueOrRef = Primitive

export type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in' | 'is' | 'is not'

export interface WhereRaw {
  raw: SqlFragment
}

/**
 * Brand for SQL fragments produced by Bun's `sql\`...\`` tagged-template
 * (or any equivalent helper). Typed as `object` so the *Raw methods
 * (`whereRaw`, `selectRaw`, `groupByRaw`, `havingRaw`, `orderByRaw`)
 * refuse to compile when passed a bare string — concatenated user
 * input (`whereRaw(\`status = '${req.body.s}'\`)`) was the canonical
 * SQL-injection vector flagged by the audit as Q-3.
 *
 * Callers who legitimately need raw SQL use `sql\`...\`` which
 * separates the SQL fragment from parameter values:
 *
 * ```ts
 * import { sql } from 'bun'
 * db.selectFrom('users').whereRaw(sql\`lower(name) = lower(${input})\`)
 * ```
 *
 * The runtime guard in each *Raw method also rejects bare strings as
 * a defense-in-depth backstop for `as any` casts.
 *
 * See stacksjs/stacks#1858 Q-3.
 */
export type SqlFragment = object

type WhereValue<T> = T | T[] | SqlFragment

export type WhereExpression<TableColumns> =
  | Partial<{ [K in keyof TableColumns & string]: WhereValue<TableColumns[K]> }>
  | { [K in keyof TableColumns & string]: [key: K, op: WhereOperator, value: WhereValue<TableColumns[K]>] }[keyof TableColumns & string]
  | WhereRaw

export type QueryResult = unknown

/**
 * # `SortDirection`
 *
 * The direction used when ordering query results.
 */
export type SortDirection = 'asc' | 'desc'

/**
 * # `ColumnName<DB, TTable>`
 *
 * Helper type extracting a string union of column names for a given table.
 */
export type ColumnName<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> = keyof DB[TTable]['columns'] & string
// Named row alias to improve IDE hover readability
export type SelectedRow<
  DB extends AnyDatabaseSchema,
  _TTable extends keyof DB & string,
  TSelected,
> = Readonly<TSelected>

type PrimaryKeyValue<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> =
  DB[TTable]['primaryKey'] extends keyof DB[TTable]['columns']
    ? DB[TTable]['columns'][DB[TTable]['primaryKey']]
    : unknown

type NumericColumnName<Columns> = {
  [K in keyof Columns & string]: unknown extends Columns[K]
    ? K
    : Exclude<Columns[K], null | undefined> extends number ? K : never
}[keyof Columns & string]

type JoinColumn<DB extends AnyDatabaseSchema, TTables extends string> = TTables extends any
  ? `${TTables}.${keyof DB[TTables]['columns'] & string}`
  : never

/**
 * # `TableRelationName<DB, TTable>`
 *
 * The relation names declared for a table, read from the type-level
 * `relations` map that `DatabaseSchema` carries. Falls back to `string`
 * for hand-written schema types that don't declare relation metadata
 * (inferred `R` is `unknown` when the property is absent), so existing
 * untyped schemas keep compiling. A table that declares ZERO relations
 * yields `never` — every relation name is rejected.
 */
export type TableRelationName<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> =
  DB[TTable] extends { relations?: infer R }
    ? unknown extends R ? string : keyof NonNullable<R> & string
    : string

type RelatedTableName<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TRelation extends TableRelationName<DB, TTable>,
> = DB[TTable] extends { relations?: infer Relations }
  ? TRelation extends keyof NonNullable<Relations>
    ? Extract<NonNullable<Relations>[TRelation], keyof DB & string>
    : keyof DB & string
  : keyof DB & string

type RelationQueryBuilder<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TRelation extends TableRelationName<DB, TTable>,
> = SelectQueryBuilder<
  DB,
  RelatedTableName<DB, TTable, TRelation>,
  DB[RelatedTableName<DB, TTable, TRelation>]['columns']
>

type RelationConstraintRecord<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> = {
  [R in TableRelationName<DB, TTable>]: Partial<Record<R, (qb: RelationQueryBuilder<DB, TTable, R>) => unknown>>
}[TableRelationName<DB, TTable>]

/**
 * # `WithRelationArg<DB, TTable>`
 *
 * Argument accepted by `.with()`: a declared relation name, a dotted nested
 * path rooted at a declared relation (`'posts.comments'`), or a record
 * mapping relation names to constraint callbacks. A table with zero declared
 * relations accepts nothing (the bare `Partial<Record<never, ...>>` would be
 * `{}`, which strings are assignable to — hence the explicit never guard).
 */
export type WithRelationArg<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> =
  [TableRelationName<DB, TTable>] extends [never]
    ? never
    :
      | TableRelationName<DB, TTable>
      | `${TableRelationName<DB, TTable>}.${string}`
      | RelationConstraintRecord<DB, TTable>

// Convert snake_case to PascalCase at the type level (e.g. created_at -> CreatedAt)
type SnakeToPascal<S extends string> = S extends `${infer H}_${infer T}`
  ? `${Capitalize<H>}${SnakeToPascal<T>}`
  : Capitalize<S>

// Typed SQL builder (type-level only). We piggy-back on the runtime builder but
// thread a phantom TSql string through method signatures so hovers can show the
// composed SQL at compile-time for common operations.
type _TypedDynamicWhereMethods<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string,
  TSql extends string,
> = {
  [K in keyof DB[TTable]['columns'] & string as `where${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} = ?`>
} & {
  [K in keyof DB[TTable]['columns'] & string as `orWhere${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} = ?`>
} & {
  [K in keyof DB[TTable]['columns'] & string as `andWhere${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} = ?`>
}

// NOTE: TypedSelectQueryBuilder must NOT also intersect DynamicWhereMethods —
// _TypedDynamicWhereMethods declares the same `where<Column>` keys, and the
// untyped variant (returning a plain SelectQueryBuilder) would win overload
// resolution, silently downgrading `toSQL()` from the composed literal SQL
// type back to `string` after any dynamic-where call.
export type TypedSelectQueryBuilder<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
  TSql extends string = `SELECT * FROM ${TTable}`,
> = Omit<
  BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined>,
  'toSQL' | 'where' | 'andWhere' | 'orWhere' | 'orderBy' | 'limit'
> & _TypedDynamicWhereMethods<DB, TTable, TSelected, TJoined, TSql>
& {
  toSQL: () => TSql
  where: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, WhereValue<DB[TTable]['columns'][K]>],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][keyof DB[TTable]['columns'] & string]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${string}`>)
  andWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, WhereValue<DB[TTable]['columns'][K]>],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][keyof DB[TTable]['columns'] & string]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${string}`>)
  orWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, WhereValue<DB[TTable]['columns'][K]>],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][keyof DB[TTable]['columns'] & string]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${string}`>)
  orderBy: <C extends keyof DB[TTable]['columns'] & string, D extends 'asc' | 'desc' = 'asc'>(
    column: C,
    direction?: D,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} ORDER BY ${C} ${D}`>
  limit: <N extends number>(n: N) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} LIMIT ${N}`>
}

type DynamicWhereMethods<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = {
  [K in keyof DB[TTable]['columns'] & string as `where${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
} & {
  [K in keyof DB[TTable]['columns'] & string as `orWhere${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
} & {
  [K in keyof DB[TTable]['columns'] & string as `andWhere${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
}

export interface BaseSelectQueryBuilder<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> {
  // modifiers
  /**
   * # `distinct`
   *
   * Applies a DISTINCT modifier to the select list.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').distinct().get()
   * const sql = db.selectFrom('users').distinct().toSQL()
   * ```
   */
  distinct: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `distinctOn`
   *
   * Applies a DISTINCT ON clause (PostgreSQL).
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').distinctOn('email').get()
   * const sql = db.selectFrom('users').distinctOn('email', 'name').toSQL()
   * ```
   */
  distinctOn: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `selectRaw`
   *
   * Appends a raw fragment to the SELECT list.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').selectRaw(sql`count(*) as c`).get()
   * const sqlText = db.selectFrom('users').selectRaw(sql`now() as ts`).toSQL()
   * ```
   */
  selectRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `where`
   *
   * Adds a WHERE clause using an object, tuple, or raw fragment.
   *
   * @example
   * ```ts
   * const users = await db.selectFrom('users').where({ id: 1, active: true }).get()
   * const newer = await db.selectFrom('users').where(['created_at', '>', '2024-01-01']).get()
   * const sqlText = db.selectFrom('users').where({ id: 1 }).toSQL()
   * ```
   */
  where: <K extends keyof DB[TTable]['columns'] & string>(
    expr: WhereExpression<DB[TTable]['columns']> | K,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][K]>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereRaw`
   *
   * Adds a raw WHERE fragment.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereRaw(sql`lower(name) = lower(${ 'Alice' })`).get()
   * const sqlText = db.selectFrom('users').whereRaw(sql`custom_condition`).toSQL()
   * ```
   */
  whereRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereColumn`
   *
   * Compares one column to another column.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereColumn('created_at', '>=', 'updated_at').get()
   * const sqlText = db.selectFrom('users').whereColumn('a', '=', 'b').toSQL()
   * ```
   */
  whereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereColumn`
   *
   * Adds an OR column-to-column comparison.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereColumn('last_login', '<', 'created_at').get()
   * const sqlText = db.selectFrom('users').orWhereColumn('a', '!=', 'b').toSQL()
   * ```
   */
  orWhereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereIn`
   *
   * Filters rows where a column is IN a list or subquery.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereIn('id', [1, 2, 3]).get()
   * const sqlText = db.selectFrom('users').whereIn('id', db.selectFrom('admins').selectRaw(sql`id`)).toSQL()
   * ```
   */
  whereIn: <K extends keyof DB[TTable]['columns'] & string>(column: K, values: DB[TTable]['columns'][K][] | { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereIn`
   *
   * Adds an OR IN filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereIn('role', ['admin', 'owner']).get()
   * const sqlText = db.selectFrom('users').orWhereIn('id', [1, 2]).toSQL()
   * ```
   */
  orWhereIn: <K extends keyof DB[TTable]['columns'] & string>(column: K, values: DB[TTable]['columns'][K][] | { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotIn`
   *
   * Filters rows where a column is NOT IN a list or subquery.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotIn('id', [1, 2, 3]).get()
   * const sqlText = db.selectFrom('users').whereNotIn('id', [4, 5]).toSQL()
   * ```
   */
  whereNotIn: <K extends keyof DB[TTable]['columns'] & string>(column: K, values: DB[TTable]['columns'][K][] | { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNotIn`
   *
   * Adds an OR NOT IN filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereNotIn('id', [1, 2]).get()
   * const sqlText = db.selectFrom('users').orWhereNotIn('role', ['banned']).toSQL()
   * ```
   */
  orWhereNotIn: <K extends keyof DB[TTable]['columns'] & string>(column: K, values: DB[TTable]['columns'][K][] | { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // convenience like wrappers
  /**
   * # `whereLike`
   *
   * Adds a LIKE filter for a column (case-insensitive by default).
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereLike('name', '%ali%').get()
   * const rowsCs = await db.selectFrom('users').whereLike('name', '%Ali%', true).get()
   * ```
   */
  whereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Case-insensitive LIKE using native ILIKE on PostgreSQL, fallback LOWER() elsewhere. */
  whereILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereLike`
   *
   * Adds an OR LIKE filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereLike('email', '%@example.com').get()
   * const sqlText = db.selectFrom('users').orWhereLike('name', 'a%').toSQL()
   * ```
   */
  orWhereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotLike`
   *
   * Adds a NOT LIKE filter for a column.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotLike('name', 'admin%').get()
   * const sqlText = db.selectFrom('users').whereNotLike('email', '%spam%').toSQL()
   * ```
   */
  whereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNotLike`
   *
   * Adds an OR NOT LIKE filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereNotLike('name', '%test%').get()
   * const sqlText = db.selectFrom('users').orWhereNotLike('name', '%bot%').toSQL()
   * ```
   */
  orWhereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereNotILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereGroup`
   *
   * A parenthesised group of conditions, ANDed onto the query.
   *
   * A chained `orWhere` groups with the term immediately before it, so
   * `.where(a).where(b).orWhere(c)` means `a AND (b OR c)`. This is the escape
   * hatch for the other reading — `(a AND b) OR c` — which chaining alone can
   * no longer express. Throws if the callback adds no conditions, rather than
   * leaving the query unfiltered.
   *
   * @example
   * ```ts
   * // (status = 'live' AND role = 'admin') OR owner_id = 7
   * db.selectFrom('users')
   *   .whereGroup(b => b.where('status', '=', 'live').where('role', '=', 'admin'))
   *   .orWhere('owner_id', '=', 7)
   * ```
   */
  whereGroup: (callback: (builder: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereGroup`
   *
   * A parenthesised group of conditions, ORed onto the query.
   */
  orWhereGroup: (callback: (builder: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** OR-connected counterpart of `whereNull`. */
  orWhereNull: (column: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** OR-connected counterpart of `whereNotNull`. */
  orWhereNotNull: (column: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** OR-connected counterpart of `whereBetween`. */
  orWhereBetween: <K extends keyof DB[TTable]['columns'] & string>(column: K, start: DB[TTable]['columns'][K], end: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** OR-connected counterpart of `whereExists`. */
  orWhereExists: (subquery: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * OR-connected counterpart of `whereRaw`.
   *
   * A raw fragment is one term and is not auto-parenthesised — if it contains a
   * top-level `OR`, bracket it yourself.
   */
  orWhereRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // where any/all/none on list of columns
  /**
   * # `whereAny`
   *
   * Matches when any of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereAny(['first_name', 'last_name'], 'like', '%ali%').get()
   * const sqlText = db.selectFrom('users').whereAny(['email', 'username'], 'like', 'a%').toSQL()
   * ```
   */
  whereAny: <K extends keyof DB[TTable]['columns'] & string>(columns: K[], op: WhereOperator, value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereAll`
   *
   * Matches when all of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereAll(['active', 'email_verified'], 'is', true).get()
   * const sqlText = db.selectFrom('users').whereAll(['a', 'b'], '=', 1).toSQL()
   * ```
   */
  whereAll: <K extends keyof DB[TTable]['columns'] & string>(columns: K[], op: WhereOperator, value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNone`
   *
   * Matches when none of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNone(['role', 'status'], 'in', ['banned']).get()
   * const sqlText = db.selectFrom('users').whereNone(['a'], '!=', 1).toSQL()
   * ```
   */
  whereNone: <K extends keyof DB[TTable]['columns'] & string>(columns: K[], op: WhereOperator, value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNested`
   *
   * Wraps a subquery or fragment in parentheses and applies it with WHERE.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').whereLike('name', 'a%')
   * const rows = await db.selectFrom('users').whereNested(sub).get()
   * const sqlText = db.selectFrom('users').whereNested(sub).toSQL()
   * ```
   */
  whereNested: (fragment: { toSQL: () => string } | SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNested`
   *
   * Adds an OR-wrapped nested condition.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').where({ active: true })
   * const rows = await db.selectFrom('users').orWhereNested(sub).get()
   * const sqlText = db.selectFrom('users').orWhereNested(sub).toSQL()
   * ```
   */
  orWhereNested: (fragment: { toSQL: () => string } | SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // date/json helpers (basic variants)
  /**
   * # `whereDate`
   *
   * Compares a column to a date value using the given operator.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereDate('created_at', '>=', '2024-01-01').get()
   * const sqlText = db.selectFrom('users').whereDate('created_at', '<', new Date()).toSQL()
   * ```
   */
  whereDate: (column: string, op: WhereOperator, date: string | Date) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereBetween`
   *
   * Filters rows where a column is within the given inclusive range.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereBetween('id', 10, 20).get()
   * const sqlText = db.selectFrom('users').whereBetween('created_at', '2024-01-01', '2024-12-31').toSQL()
   * ```
   */
  whereBetween: <K extends keyof DB[TTable]['columns'] & string>(column: K, start: DB[TTable]['columns'][K], end: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotBetween`
   *
   * Filters rows where a column is outside the given inclusive range.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotBetween('id', 10, 20).get()
   * const sqlText = db.selectFrom('users').whereNotBetween('created_at', '2024-01-01', '2024-12-31').toSQL()
   * ```
   */
  whereNotBetween: <K extends keyof DB[TTable]['columns'] & string>(column: K, start: DB[TTable]['columns'][K], end: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonContains`
   *
   * Filters rows where a JSON column contains the given JSON value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonContains('tags', ['bun']).get()
   * const sqlText = db.selectFrom('posts').whereJsonContains('meta', { published: true }).toSQL()
   * ```
   */
  whereJsonContains: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** JSON path comparison across dialects */
  whereJsonPath?: (path: string, op: WhereOperator, value: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `andWhere`
   *
   * Adds an AND condition using the flexible expression format.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).andWhere(['id', '>', 100]).get()
   * const sqlText = db.selectFrom('users').where({ active: true }).andWhere({ email_verified: true }).toSQL()
   * ```
   */
  andWhere: <K extends keyof DB[TTable]['columns'] & string>(
    expr: WhereExpression<DB[TTable]['columns']> | K,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][K]>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhere`
   *
   * Adds an OR condition using the flexible expression format.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhere({ admin: true }).get()
   * const sqlText = db.selectFrom('users').orWhere(['id', 'in', [1,2,3]]).toSQL()
   * ```
   */
  orWhere: <K extends keyof DB[TTable]['columns'] & string>(
    expr: WhereExpression<DB[TTable]['columns']> | K,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][K]>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orderBy`
   *
   * Orders the result by a column in ascending or descending order.
   *
   * @param column The column to order by (strongly typed to the table's columns)
   * @param direction Optional direction (asc | desc). Defaults to asc.
   *
   * @example
   * ```ts
   * // Setup
   * const models = defineModels({ User })
   * const schema = buildDatabaseSchema(models)
   * const meta = buildSchemaMeta(models)
   * const db = createQueryBuilder<typeof schema>({ schema, meta })
   *
   * // Usage
   * const rows = await db.selectFrom('users').orderBy('created_at', 'desc').get()
   * const sql = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  orderBy: (column: ColumnName<DB, TTable>, direction?: SortDirection) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `orderByDesc`
   *
   * Convenience for ordering by a column in descending order.
   *
   * @param column The column to order by (strongly typed to the table's columns)
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').orderByDesc('id').get()
   * const sql = db.selectFrom('users').orderByDesc('id').toSQL()
   * ```
   */
  orderByDesc: (column: ColumnName<DB, TTable>) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `inRandomOrder`
   *
   * Orders results randomly using the configured SQL dialect function.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').inRandomOrder().limit(5).get()
   * const sql = db.selectFrom('users').inRandomOrder().toSQL()
   * ```
   */
  inRandomOrder: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `reorder`
   *
   * Replaces any existing ORDER BY clause.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').orderBy('id').reorder('created_at', 'desc').toSQL()
   * const rows = await db.selectFrom('users').reorder('name', 'asc').get()
   * ```
   */
  reorder: (column: string, direction?: 'asc' | 'desc') => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `latest`
   *
   * Orders by the given column (or default timestamp) descending.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').latest().get()
   * const sql = db.selectFrom('users').latest('created_at').toSQL()
   * ```
   */
  latest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `oldest`
   *
   * Orders by the given column (or default timestamp) ascending.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').oldest().get()
   * const sql = db.selectFrom('users').oldest('created_at').toSQL()
   * ```
   */
  oldest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `limit`
   *
   * Limits the number of rows returned.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').limit(10).get()
   * const sql = db.selectFrom('users').limit(5).toSQL()
   * ```
   */
  limit: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `offset`
   *
   * Offsets the starting row.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').limit(10).offset(10).get()
   * const sql = db.selectFrom('users').offset(20).toSQL()
   * ```
   */
  offset: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  /** Apply a timeout (ms) for this query (cancel on expiration). */
  withTimeout?: (ms: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Attach an AbortSignal to cancel this query when aborted. */
  abort?: (signal: AbortSignal) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // Joins
  join: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  joinSub: (sub: { toSQL: () => string }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  innerJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  leftJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  leftJoinSub: (sub: { toSQL: () => string }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  rightJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoin: <T2 extends keyof DB & string>(table: T2) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoinSub: (sub: { toSQL: () => string }, alias: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `groupBy`
   *
   * Adds a GROUP BY clause.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').toSQL()
   * const rows = await db.selectFrom('users').groupBy('role', 'status').get()
   * ```
   */
  groupBy: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `groupByRaw`
   *
   * Adds a raw GROUP BY fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupByRaw(sql`date_trunc('day', created_at)`).toSQL()
   * const rows = await db.selectFrom('users').groupByRaw(sql`1`).get()
   * ```
   */
  groupByRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `having`
   *
   * Adds a HAVING clause using the flexible expression format.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').having(['count', '>', 10]).toSQL()
   * const rows = await db.selectFrom('users').having({ active: true }).get()
   * ```
   */
  having: (expr: WhereExpression<TSelected>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `havingRaw`
   *
   * Adds a raw HAVING fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').havingRaw(sql`count(*) > 10`).toSQL()
   * const rows = await db.selectFrom('users').havingRaw(sql`count(*) > 0`).get()
   * ```
   */
  havingRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `addSelect`
   *
   * Adds additional columns to the SELECT list.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').addSelect('id', 'name').toSQL()
   * const rows = await db.selectFrom('users').addSelect('email').get()
   * ```
   */
  addSelect: (...columns: ((keyof DB[TTable]['columns'] & string) | string | SqlFragment)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  select?: {
    /**
     * # `select(columns)`
     *
     * Restrict the SELECT list to the given columns. When every entry is a
     * plain column name the result row type narrows to exactly those
     * columns — `get()`, `first()`, `value()`, `pluck()` all follow.
     */
    <K extends keyof DB[TTable]['columns'] & string>(columns: K[]): SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>, TJoined>
    /** Raw/aliased select lists keep the current row type. */
    (columns: string | SqlFragment | (string | SqlFragment)[]): SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  }
  selectAll?: () => SelectQueryBuilder<DB, TTable, DB[TTable]['columns'], TJoined>
  /**
   * # `orderByRaw`
   *
   * Adds a raw ORDER BY fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').orderByRaw(sql`random()`).toSQL()
   * const rows = await db.selectFrom('users').orderByRaw(sql`1`).get()
   * ```
   */
  orderByRaw: (fragment: SqlFragment) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `$call`
   *
   * Applies a callback to this query and returns the query, so a filter that
   * only sometimes applies can be written without breaking the chain.
   *
   * The callback's return value is ignored: this builder mutates and returns
   * itself, so returning the query and not returning it mean the same thing.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users')
   *   .$call(q => (wanted ? q.where({ active: true }) : q))
   *   .get()
   * ```
   */
  $call: (callback: (query: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `union`
   *
   * Unions another query.
   *
   * @example
   * ```ts
   * const a = db.selectFrom('users').where({ active: true })
   * const b = db.selectFrom('users').where({ admin: true })
   * const rows = await a.union(b).get()
   * const sql = a.union(b).toSQL()
   * ```
   */
  union: (other: { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `unionAll`
   *
   * Unions another query including duplicates.
   *
   * @example
   * ```ts
   * const a = db.selectFrom('users').where({ active: true })
   * const b = db.selectFrom('users').where({ admin: true })
   * const rows = await a.unionAll(b).get()
   * const sql = a.unionAll(b).toSQL()
   * ```
   */
  unionAll: (other: { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `forPage`
   *
   * Applies limit/offset based on page size and page number.
   *
   * @example
   * ```ts
   * const page = await db.selectFrom('users').forPage(2, 10).get()
   * const sql = db.selectFrom('users').forPage(3, 20).toSQL()
   * ```
   */
  forPage: (page: number, perPage: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectAllRelations?: () => SelectQueryBuilder<DB, TTable, TSelected & Record<string, unknown>, TJoined>
  // where helpers
  /**
   * # `whereNull`
   *
   * Filters rows where a column is NULL.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNull('deleted_at').get()
   * const sql = db.selectFrom('users').whereNull('deleted_at').toSQL()
   * ```
   */
  whereNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotNull`
   *
   * Filters rows where a column is NOT NULL.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotNull('deleted_at').get()
   * const sql = db.selectFrom('users').whereNotNull('deleted_at').toSQL()
   * ```
   */
  whereNotNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // whereBetween intentionally omitted here because it is declared above as required
  /**
   * # `whereExists`
   *
   * Filters rows where the subquery returns at least one row.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('posts').whereColumn('posts.user_id', '=', 'users.id')
   * const rows = await db.selectFrom('users').whereExists(sub).get()
   * const sql = db.selectFrom('users').whereExists(sub).toSQL()
   * ```
   */
  whereExists?: (subquery: { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonDoesntContain`
   *
   * Filters rows where a JSON column does not contain the given JSON value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonDoesntContain('tags', ['spam']).get()
   * const sql = db.selectFrom('posts').whereJsonDoesntContain('tags', ['spam']).toSQL()
   * ```
   */
  whereJsonDoesntContain?: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonContainsKey`
   *
   * Filters rows where a JSON path contains the given key.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonContainsKey('meta.published').get()
   * const sql = db.selectFrom('posts').whereJsonContainsKey('meta.tags').toSQL()
   * ```
   */
  whereJsonContainsKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonDoesntContainKey`
   *
   * Filters rows where a JSON path does not contain the given key.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonDoesntContainKey('meta.archived').get()
   * const sql = db.selectFrom('posts').whereJsonDoesntContainKey('meta.archived').toSQL()
   * ```
   */
  whereJsonDoesntContainKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonLength`
   *
   * Filters rows by the length of a JSON array at the given path.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonLength('tags', '>=', 2).get()
   * const sql = db.selectFrom('posts').whereJsonLength('tags', 0).toSQL()
   * ```
   */
  whereJsonLength?: (path: string, opOrLen: WhereOperator | number, len?: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // relations
  /**
   * # `with`
   *
   * Auto-joins related tables inferred from schema metadata.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').with('posts', 'profiles').get()
   * const sql = db.selectFrom('users').with('posts').toSQL()
   * ```
   */
  with?: (...relations: WithRelationArg<DB, TTable>[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereHas`
   *
   * Filter records that have at least one related record, with an optional
   * constraint callback applied to the related table.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereHas('posts').get()
   * const active = await db.selectFrom('users').whereHas('posts', qb => qb.where('published', '=', true)).get()
   * ```
   */
  whereHas?: <R extends TableRelationName<DB, TTable>>(relation: R, callback?: (qb: RelationQueryBuilder<DB, TTable, R>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereDoesntHave`
   *
   * Filter records that have no related records, with an optional constraint
   * callback applied to the related table.
   */
  whereDoesntHave?: <R extends TableRelationName<DB, TTable>>(relation: R, callback?: (qb: RelationQueryBuilder<DB, TTable, R>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `has`
   *
   * Shorthand for `whereHas(relation)` without a constraint callback.
   */
  has?: (relation: TableRelationName<DB, TTable>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `doesntHave`
   *
   * Shorthand for `whereDoesntHave(relation)` without a constraint callback.
   */
  doesntHave?: (relation: TableRelationName<DB, TTable>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `withCount`
   *
   * Select a correlated count of related records as `${relation}_count`.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').withCount('posts').get()
   * ```
   */
  withCount?: <R extends TableRelationName<DB, TTable>>(...relations: R[]) => SelectQueryBuilder<DB, TTable, TSelected & { [K in `${R}_count`]: number }, TJoined>
  /** Select a correlated SUM of a related column as `${relation}_sum_${column}`. */
  withSum?: <R extends TableRelationName<DB, TTable>, K extends keyof DB[RelatedTableName<DB, TTable, R>]['columns'] & string>(relation: R, column: K) => SelectQueryBuilder<DB, TTable, TSelected & { [P in `${R}_sum_${K}`]: number }, TJoined>
  /** Select a correlated AVG of a related column as `${relation}_avg_${column}`. */
  withAvg?: <R extends TableRelationName<DB, TTable>, K extends keyof DB[RelatedTableName<DB, TTable, R>]['columns'] & string>(relation: R, column: K) => SelectQueryBuilder<DB, TTable, TSelected & { [P in `${R}_avg_${K}`]: number }, TJoined>
  /** Select a correlated MAX of a related column as `${relation}_max_${column}`. */
  withMax?: <R extends TableRelationName<DB, TTable>, K extends keyof DB[RelatedTableName<DB, TTable, R>]['columns'] & string>(relation: R, column: K) => SelectQueryBuilder<DB, TTable, TSelected & { [P in `${R}_max_${K}`]: DB[RelatedTableName<DB, TTable, R>]['columns'][K] | null }, TJoined>
  /** Select a correlated MIN of a related column as `${relation}_min_${column}`. */
  withMin?: <R extends TableRelationName<DB, TTable>, K extends keyof DB[RelatedTableName<DB, TTable, R>]['columns'] & string>(relation: R, column: K) => SelectQueryBuilder<DB, TTable, TSelected & { [P in `${R}_min_${K}`]: DB[RelatedTableName<DB, TTable, R>]['columns'][K] | null }, TJoined>
  /**
   * # `withPivot`
   *
   * Include pivot table columns when eager loading belongsToMany relationships.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').with('tags').withPivot('tags', 'created_at', 'role').get()
   * ```
   */
  withPivot?: (relation: TableRelationName<DB, TTable>, ...columns: string[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `wherePivot`
   *
   * Filter a `belongsToMany` query by a column on the pivot table. Auto-joins
   * the pivot if not already in the FROM. Mirrors Laravel's `wherePivot`.
   *
   * @example
   * ```ts
   * await db.selectFrom('coaches').with('athletes').wherePivot('athletes', 'role', 'primary').get()
   * await db.selectFrom('coaches').with('athletes').wherePivot('athletes', 'status', '!=', 'archived').get()
   * ```
   */
  wherePivot?: (relation: TableRelationName<DB, TTable>, column: string, opOrValue: unknown, value?: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `wherePivotIn`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being in a list.
   */
  wherePivotIn?: (relation: TableRelationName<DB, TTable>, column: string, values: unknown[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `wherePivotNotIn`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being not in a list.
   */
  wherePivotNotIn?: (relation: TableRelationName<DB, TTable>, column: string, values: unknown[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `wherePivotNull`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being NULL.
   */
  wherePivotNull?: (relation: TableRelationName<DB, TTable>, column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `wherePivotNotNull`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being NOT NULL.
   */
  wherePivotNotNull?: (relation: TableRelationName<DB, TTable>, column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `applyPivotColumns`
   *
   * Apply pivot columns to the SELECT clause.
   */
  applyPivotColumns?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // locks
  /**
   * # `lockForUpdate`
   *
   * Applies a FOR UPDATE row lock to the query.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ id: 1 }).lockForUpdate().get()
   * const sql = db.selectFrom('users').lockForUpdate().toSQL()
   * ```
   */
  lockForUpdate: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `sharedLock`
   *
   * Applies a shared lock syntax depending on the dialect configuration.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ id: 1 }).sharedLock().get()
   * const sql = db.selectFrom('users').sharedLock().toSQL()
   * ```
   */
  sharedLock: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // ctes
  /**
   * # `withCTE`
   *
   * Adds a non-recursive Common Table Expression (CTE).
   *
   * @example
   * ```ts
   * const recent = db.selectFrom('users').whereDate('created_at', '>=', '2024-01-01')
   * const rows = await db.selectFrom('users').withCTE('recent_users', recent).get()
   * const sql = db.selectFrom('users').withCTE('recent_users', recent).toSQL()
   * ```
   */
  withCTE: (name: string, sub: { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `withRecursive`
   *
   * Adds a recursive Common Table Expression (CTE).
   *
   * @example
   * ```ts
   * const tree = db.selectFrom('categories') // build recursive CTE
   * const rows = await db.selectFrom('categories').withRecursive('tree', tree).get()
   * const sql = db.selectFrom('categories').withRecursive('tree', tree).toSQL()
   * ```
   */
  withRecursive: (name: string, sub: { toSQL: () => string }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // results helpers
  /**
   * # `value`
   *
   * Returns a single column value from the first row.
   *
   * @example
   * ```ts
   * const name = await db.selectFrom('users').whereId(1).value('name')
   * const createdAt = await db.selectFrom('users').orderBy('id', 'desc').value('created_at')
   * ```
   */
  value: <K extends keyof TSelected & string>(column: K) => Promise<SelectedRow<DB, TTable, TSelected>[K]>
  pluck: {
    /**
     * # `pluck(column)`
     *
     * Returns an array of values for a single column.
     *
     * @example
     * ```ts
     * const names = await db.selectFrom('users').pluck('name')
     * const ids = await db.selectFrom('users').orderBy('id').pluck('id')
     * ```
     */
    <K extends keyof TSelected & string>(column: K): Promise<SelectedRow<DB, TTable, TSelected>[K][]>
    /**
     * # `pluck(column, key)`
     *
     * Returns an object keyed by the given key column.
     *
     * @example
     * ```ts
     * const byId = await db.selectFrom('users').pluck('email', 'id')
     * const map = await db.selectFrom('users').pluck('name', 'email')
     * ```
     */
    <K extends keyof TSelected & string, K2 extends keyof TSelected & string>(column: K, key: K2): Promise<Record<string, SelectedRow<DB, TTable, TSelected>[K]>>
  }
  /**
   * # `exists`
   *
   * Returns true if the query returns at least one row.
   *
   * @example
   * ```ts
   * const hasUsers = await db.selectFrom('users').exists()
   * const hasAdmins = await db.selectFrom('users').where({ admin: true }).exists()
   * ```
   */
  exists: () => Promise<boolean>
  /**
   * # `doesntExist`
   *
   * Returns true if the query returns no rows.
   *
   * @example
   * ```ts
   * const noUsers = await db.selectFrom('users').where({ id: -1 }).doesntExist()
   * const none = await db.selectFrom('users').where({ active: false }).doesntExist()
   * ```
   */
  doesntExist: () => Promise<boolean>
  /**
   * # `cursorPaginate`
   *
   * Cursor-based pagination helper.
   *
   * @example
   * ```ts
   * const page1 = await db.selectFrom('users').cursorPaginate(10)
   * const page2 = await db.selectFrom('users').cursorPaginate(10, page1.meta.nextCursor)
   * ```
   */
  cursorPaginate: (perPage: number, cursor?: string | number, column?: string, direction?: 'asc' | 'desc') => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, nextCursor: string | number | null } }>
  /**
   * # `chunk`
   *
   * Iterates through results in pages and invokes the handler for each chunk.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').chunk(100, async rows => {
   *   // process rows
   * })
   * const done = await db.selectFrom('users').chunk(50, () => {})
   * ```
   */
  chunk: (size: number, handler: (rows: SelectedRow<DB, TTable, TSelected>[]) => Promise<void> | void) => Promise<void>
  /**
   * # `chunkById`
   *
   * Iterates through results using cursor-based pagination on an id-like column.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').chunkById(100, 'id', async rows => { // noop })
   * await db.selectFrom('users').chunkById(100)
   * ```
   */
  chunkById: (size: number, column?: keyof DB[TTable]['columns'] & string, handler?: (rows: SelectedRow<DB, TTable, TSelected>[]) => Promise<void> | void) => Promise<void>
  /**
   * # `eachById`
   *
   * Iterates row-by-row using id-based cursor pagination.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').eachById(100, 'id', async row => { // noop })
   * await db.selectFrom('users').eachById(50)
   * ```
   */
  eachById: (size: number, column?: keyof DB[TTable]['columns'] & string, handler?: (row: SelectedRow<DB, TTable, TSelected>) => Promise<void> | void) => Promise<void>
  /**
   * # `when`
   *
   * Conditionally modifies the query.
   *
   * @example
   * ```ts
   * const activeOnly = true
   * const q = db.selectFrom('users').when(activeOnly, qb => qb.where({ active: true }))
   * const sql = q.toSQL()
   * ```
   */
  when: (condition: unknown, then: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown, otherwise?: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `tap`
   *
   * Runs a side-effect function and returns the builder for chaining.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').tap(qb => qb.orderBy('id')).get()
   * const sql = db.selectFrom('users').tap(() => {}).toSQL()
   * ```
   */
  tap: (fn: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `dump`
   *
   * Logs the SQL string to the console and returns the builder.
   *
   * @example
   * ```ts
   * db.selectFrom('users').whereId(1).dump().get()
   * db.selectFrom('users').orderBy('id').dump()
   * ```
   */
  dump: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `dd`
   *
   * Dumps the SQL and throws an error to stop execution.
   *
   * @example
   * ```ts
   * // db.selectFrom('users').whereId(1).dd()
   * ```
   */
  dd: () => never
  /**
   * # `explain`
   *
   * Runs EXPLAIN on the built query and returns the plan rows.
   *
   * @example
   * ```ts
   * const plan = await db.selectFrom('users').whereId(1).explain()
   * const plan2 = await db.selectFrom('users').orderBy('id').limit(1).explain()
   * ```
   */
  explain: () => Promise<Record<string, unknown>[]>
  /**
   * # `simple`
   *
   * Returns the Bun.sql simple representation for the built query.
   *
   * @example
   * ```ts
   * const s = db.selectFrom('users').whereId(1).simple()
   * const t = db.selectFrom('users').orderBy('id').simple()
   * ```
   */
  simple: () => unknown
  toText?: () => string
  /**
   * # `paginate`
   *
   * Paginates results using LIMIT/OFFSET and returns data with meta info.
   *
   * @example
   * ```ts
   * const res = await db.selectFrom('users').paginate(10, 2)
   * const res2 = await db.selectFrom('users').where({ active: true }).paginate(25)
   * ```
   */
  paginate: (perPage: number, page?: number, opts?: { tx?: { unsafe: (sql: string, params?: unknown[]) => unknown } }) => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, page: number, total: number, lastPage: number } }>
  /**
   * # `simplePaginate`
   *
   * Lightweight paginator using LIMIT/OFFSET and a hasMore flag.
   *
   * @example
   * ```ts
   * const res = await db.selectFrom('users').simplePaginate(10, 1)
   * const res2 = await db.selectFrom('users').where({ active: true }).simplePaginate(25)
   * ```
   */
  simplePaginate: (perPage: number, page?: number) => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, page: number, hasMore: boolean } }>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the current query (with placeholders).
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').where({ id: 1 }).toSQL()
   * const text = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  toSQL: () => string
  execute: () => Promise<SelectedRow<DB, TTable, TSelected>[]>
  executeTakeFirst: () => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  executeTakeFirstOrThrow: () => Promise<SelectedRow<DB, TTable, TSelected>>
  // Laravel-style retrieval helpers
  /**
   * # `get`
   *
   * Executes the query and returns all rows.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereName('Alice').get()
   * const rows2 = await db.selectFrom('users').orderBy('id', 'desc').get()
   * ```
   */
  get: () => Promise<SelectedRow<DB, TTable, TSelected>[]>
  /**
   * # `first`
   *
   * Returns the first row or undefined if none found.
   *
   * @example
   * ```ts
   * const row = await db.selectFrom('users').whereId(1).first()
   * const row2 = await db.selectFrom('users').orderBy('id').first()
   * ```
   */
  first: () => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  /**
   * # `firstOrFail`
   *
   * Returns the first row or throws if none found.
   *
   * @example
   * ```ts
   * const row = await db.selectFrom('users').whereId(1).firstOrFail()
   * const row2 = await db.selectFrom('users').where({ email: 'a@b.c' }).firstOrFail()
   * ```
   */
  firstOrFail: () => Promise<SelectedRow<DB, TTable, TSelected>>
  find: (id: PrimaryKeyValue<DB, TTable>) => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  findOrFail: (id: PrimaryKeyValue<DB, TTable>) => Promise<SelectedRow<DB, TTable, TSelected>>
  findMany: (ids: PrimaryKeyValue<DB, TTable>[]) => Promise<SelectedRow<DB, TTable, TSelected>[]>
  lazy: () => AsyncIterable<SelectedRow<DB, TTable, TSelected>>
  lazyById: () => AsyncIterable<SelectedRow<DB, TTable, TSelected>>
  pipe: <R>(fn: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => R) => R
  count: () => Promise<number>
  avg: (column: NumericColumnName<DB[TTable]['columns']>) => Promise<number>
  sum: (column: NumericColumnName<DB[TTable]['columns']>) => Promise<number>
  /** MAX of a column — typed as that column's value (string columns yield strings), or null on an empty set. */
  max: <K extends keyof DB[TTable]['columns'] & string>(column: K) => Promise<DB[TTable]['columns'][K] | null>
  /** MIN of a column — typed as that column's value (string columns yield strings), or null on an empty set. */
  min: <K extends keyof DB[TTable]['columns'] & string>(column: K) => Promise<DB[TTable]['columns'][K] | null>
  // Type-only convenience properties for IDE hovers; not implemented at runtime
  readonly rows: TSelected[]
  readonly row: TSelected
  values: () => Promise<unknown[][]>
  /** Return parameter values for debugging/tests. */
  toParams?: () => unknown[]
  raw: () => Promise<unknown[][]>
  cancel: () => void
  /** Include soft-deleted rows in results. */
  withTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Only return soft-deleted rows. */
  onlyTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Apply a named scope defined on the model. */
  scope?: (name: string, value?: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Shallow clone of this builder to branch query modifications. */
  clone?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Enable query result caching with TTL in milliseconds (default 60000ms / 1 minute). */
  cache?: (ttlMs?: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Window function helpers */
  rowNumber?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  denseRank?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  rank?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
}

export type SelectQueryBuilder<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>

export interface InsertQueryBuilder<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> {
  /**
   * # `values`
   *
   * Sets the row or rows to insert.
   *
   * @example
   * ```ts
   * const id = await db.insertInto('users').values({ name: 'Alice' }).execute()
   * const rows = await db.insertInto('users').values([{ name: 'A' }, { name: 'B' }]).execute()
   * ```
   */
  values: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const row = await db.insertInto('users').values({ name: 'Alice' }).returning('id', 'name').first()
   * const sql = db.insertInto('users').values({ name: 'A' }).returning('id').toSQL()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the INSERT statement.
   *
   * @example
   * ```ts
   * const sql = db.insertInto('users').values({ name: 'A' }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the INSERT. Returns affected row count or inserted rows when using RETURNING.
   *
   * @example
   * ```ts
   * const count = await db.insertInto('users').values({ name: 'A' }).execute()
   * const rows = await db.insertInto('users').values({ name: 'A' }).returning('id').execute()
   * ```
   */
  execute: () => Promise<number | DB[TTable]['columns'] | DB[TTable]['columns'][]>
  returningAll: () => SelectQueryBuilder<DB, TTable, DB[TTable]['columns']>
  executeTakeFirst: () => Promise<DB[TTable]['columns'] | undefined>
  executeTakeFirstOrThrow: () => Promise<DB[TTable]['columns']>
}

export interface UpdateQueryBuilder<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> {
  /**
   * # `set`
   *
   * Sets columns and values to update.
   *
   * @example
   * ```ts
   * const sql = db.updateTable('users').set({ name: 'Alice' }).where({ id: 1 }).toSQL()
   * ```
   */
  set: (values: Partial<{ [K in keyof DB[TTable]['columns']]: DB[TTable]['columns'][K] | SqlFragment }>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `where`
   *
   * Filters rows to update using a flexible expression.
   *
   * @example
   * ```ts
   * const cnt = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * const cnt2 = await db.updateTable('users').set({ active: true }).where('id', '=', 1).execute()
   * const cnt3 = await db.updateTable('users').set({ active: true }).where('id', 'in', [1, 2]).execute()
   * ```
   *
   * `in` and `not in` take a list and render one placeholder per element. The
   * select builder was fixed for this in stacksjs/bun-query-builder#1013 and
   * writes were left behind, so the same call that worked on a read failed on
   * an update - which reads as a bug in the caller rather than in the builder.
   */
  where: <K extends keyof DB[TTable]['columns'] & string>(
    expr: WhereExpression<DB[TTable]['columns']> | K | SqlFragment,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][K]>,
  ) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `whereNull`
   *
   * Restricts the update to rows where a column is `NULL`.
   *
   * `where(column, 'is', null)` cannot express this: the null is bound as a
   * parameter and the statement comes out as `"col" is $1`, which every server
   * rejects. `IS NULL` is a predicate rather than a comparison, so it has to be
   * rendered rather than parameterised.
   *
   * The select builder has had this for a long time; updates and deletes did
   * not, which made an optimistic lock - claim the row only if nobody else has -
   * impossible to write against them.
   *
   * @example
   * ```ts
   * // Reserve a job only if it is still unreserved.
   * await db.updateTable('jobs').set({ reserved_at: now }).where('id', '=', id).whereNull('reserved_at').execute()
   * ```
   */
  whereNull: <K extends keyof DB[TTable]['columns'] & string>(column: K) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `whereNotNull`
   *
   * Restricts the update to rows where a column is not `NULL`. See `whereNull`.
   */
  whereNotNull: <K extends keyof DB[TTable]['columns'] & string>(column: K) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const rows = await db.updateTable('users').set({ name: 'A' }).returning('id').execute()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the UPDATE statement.
   *
   * @example
   * ```ts
   * const sql = db.updateTable('users').set({ name: 'A' }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the UPDATE and returns the number of affected rows.
   *
   * @example
   * ```ts
   * const count = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  execute: () => Promise<number>
  returningAll: () => SelectQueryBuilder<DB, TTable, DB[TTable]['columns']>
  executeTakeFirst: () => Promise<{ numUpdatedRows?: number }>
  executeTakeFirstOrThrow: () => Promise<{ numUpdatedRows: number }>
}

export interface DeleteQueryBuilder<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> {
  /**
   * # `where`
   *
   * Filters rows to delete using a flexible expression.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ inactive: true }).execute()
   * const count2 = await db.deleteFrom('users').where('id', '=', 1).execute()
   * const count3 = await db.deleteFrom('users').where('id', 'in', [1, 2]).execute()
   * ```
   *
   * `in` and `not in` take a list, as on the select and update builders. The
   * operator is checked against the allowed set before it reaches the statement
   * text - it is not a bound parameter, and a DELETE is the one statement where
   * an injected operator is unrecoverable.
   */
  where: <K extends keyof DB[TTable]['columns'] & string>(
    expr: WhereExpression<DB[TTable]['columns']> | K,
    op?: WhereOperator,
    value?: WhereValue<DB[TTable]['columns'][K]>,
  ) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `whereNull`
   *
   * Restricts the delete to rows where a column is `NULL`. See the note on
   * `UpdateQueryBuilder.whereNull`: `where(column, 'is', null)` binds the null
   * and produces `"col" is $1`, which is not valid SQL.
   *
   * @example
   * ```ts
   * await db.deleteFrom('sessions').whereNull('user_id').execute()
   * ```
   */
  whereNull: <K extends keyof DB[TTable]['columns'] & string>(column: K) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `whereNotNull`
   *
   * Restricts the delete to rows where a column is not `NULL`. See `whereNull`.
   */
  whereNotNull: <K extends keyof DB[TTable]['columns'] & string>(column: K) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const rows = await db.deleteFrom('users').where({ id: 1 }).returning('id').execute()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the DELETE statement.
   *
   * @example
   * ```ts
   * const sql = db.deleteFrom('users').where({ id: 1 }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the DELETE and returns the number of affected rows.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ id: 1 }).execute()
   * ```
   */
  execute: () => Promise<number>
  returningAll: () => SelectQueryBuilder<DB, TTable, DB[TTable]['columns']>
  executeTakeFirst: () => Promise<{ numDeletedRows?: number }>
  executeTakeFirstOrThrow: () => Promise<{ numDeletedRows: number }>
}

export interface TableQueryBuilder<DB extends AnyDatabaseSchema, TTable extends keyof DB & string> {
  /**
   * # `insert`
   *
   * Inserts rows into the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').insert({ name: 'Alice' }).execute()
   * const rows = await db.table('users').insert([{ name: 'A' }, { name: 'B' }]).execute()
   * ```
   */
  insert: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  /**
   * # `update`
   *
   * Updates rows in the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').update({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  update: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `delete`
   *
   * Deletes rows from the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').delete().where({ id: 1 }).execute()
   * ```
   */
  delete: () => DeleteQueryBuilder<DB, TTable>
  /**
   * # `select`
   *
   * Selects from the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const rows = await db.table('users').select('id', 'name').execute()
   * ```
   */
  select: <K extends keyof DB[TTable]['columns'] & string>(...columns: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
}

export interface QueryBuilder<DB extends AnyDatabaseSchema> {
  // typed select list (column names or raw aliases)
  /**
   * # `select`
   *
   * Starts a SELECT query for a table with explicit columns or raw aliases.
   *
   * @example
   * ```ts
   * const rows = await db.select('users', 'id', 'name').get()
   * const sql = db.select('users', 'id', `count(*) as c`).toSQL()
   * ```
   */
  select: {
    /** Plain column names narrow the result rows to exactly those columns. */
    <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
      table: TTable,
      ...columns: K[]
    ): SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
    /** Raw `expr as alias` entries fall back to untyped rows. */
    <TTable extends keyof DB & string>(
      table: TTable,
      ...columns: ((keyof DB[TTable]['columns'] & string) | `${string} as ${string}`)[]
    ): SelectQueryBuilder<DB, TTable, Record<string, unknown>>
  }
  /**
   * # `selectFrom`
   *
   * Starts a SELECT * query for the given table with typed dynamic where methods.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereId(1).get()
   * const sql = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  selectFrom: <TTable extends keyof DB & string>(table: TTable) => TypedSelectQueryBuilder<DB, TTable, DB[TTable]['columns'], TTable, `SELECT * FROM ${TTable}`>
  /**
   * # `insertInto`
   *
   * Starts an INSERT query for the given table.
   *
   * @example
   * ```ts
   * const id = await db.insertInto('users').values({ name: 'A' }).execute()
   * const row = await db.insertInto('users').values({ name: 'A' }).returning('id').first()
   * ```
   */
  insertInto: <TTable extends keyof DB & string>(table: TTable) => TypedInsertQueryBuilder<DB, TTable>
  /**
   * # `updateTable`
   *
   * Starts an UPDATE query for the given table.
   *
   * @example
   * ```ts
   * const count = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  updateTable: <TTable extends keyof DB & string>(table: TTable) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `deleteFrom`
   *
   * Starts a DELETE query for the given table.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ id: 1 }).execute()
   * ```
   */
  deleteFrom: <TTable extends keyof DB & string>(table: TTable) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `table`
   *
   * Laravel-style table API with insert/update/delete methods.
   *
   * @example
   * ```ts
   * const count = await db.table('users').insert({ name: 'Alice' }).execute()
   * const rows = await db.table('users').insert([{ name: 'A' }, { name: 'B' }]).execute()
   * await db.table('users').update({ active: true }).where({ id: 1 }).execute()
   * await db.table('users').delete().where({ id: 1 }).execute()
   * ```
   */
  table: <TTable extends keyof DB & string>(table: TTable) => TableQueryBuilder<DB, TTable>
  /**
   * # `selectFromSub`
   *
   * Selects from a subquery with an alias.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').where({ active: true })
   * const sql = db.selectFromSub(sub, 'u').toSQL()
   * ```
   */
  selectFromSub: (sub: { toSQL: () => string }, alias: string) => SelectQueryBuilder<DB, keyof DB & string, Record<string, unknown>>
  /**
   * # `sql`
   *
   * Exposes the underlying Bun.sql tag for advanced usage.
   *
   * @example
   * ```ts
   * const rows = await db.sql`SELECT 1 as one`.execute()
   * ```
   */
  sql: DriverConnection
  /**
   * # `raw`
   *
   * Tagged template passthrough to Bun.sql.
   *
   * @example
   * ```ts
   * const q = db.raw`SELECT ${1} as one`
   * ```
   */
  raw: (strings: TemplateStringsArray, ...values: unknown[]) => SqlFragment
  /**
   * # `simple`
   *
   * Tagged template passthrough that returns a simple statement.
   *
   * @example
   * ```ts
   * const s = db.simple`SELECT ${1}`
   * ```
   */
  simple: (strings: TemplateStringsArray, ...values: unknown[]) => unknown
  /**
   * # `unsafe`
   *
   * Executes an unsafe raw SQL string with optional parameters.
   *
   * @example
   * ```ts
   * const rows = await db.unsafe('SELECT 1 as one')
   * ```
   */
  unsafe: <TRow extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<TRow[]>
  /**
   * # `file`
   *
   * Executes a SQL file with optional parameters (if supported by Bun.sql).
   *
   * @example
   * ```ts
   * const rows = await db.file('queries/users.sql')
   * ```
   */
  file: <TRow extends Record<string, unknown> = Record<string, unknown>>(path: string, params?: unknown[]) => Promise<TRow[]>
  /**
   * # `reserve`
   *
   * Reserves a connection from the pool and returns a scoped query builder.
   *
   * @example
   * ```ts
   * const reserved = await db.reserve()
   * try { await reserved.selectFrom('users').get() }
finally { reserved.release() }
   * ```
   */
  reserve: () => Promise<(QueryBuilder<DB> & { release: () => void })>
  /**
   * # `close`
   *
   * Closes the underlying connection/pool.
   *
   * @example
   * ```ts
   * await db.close()
   * ```
   */
  close: (opts?: { timeout?: number }) => Promise<void>
  // Pub/Sub (stubs until Bun exposes API)
  /**
   * # `listen`
   *
   * Subscribes to a channel (placeholder until Bun exposes API).
   *
   * @example
   * ```ts
   * await db.listen('events')
   * ```
   */
  listen: (channel: string, handler?: (payload: unknown) => void) => Promise<void>
  /**
   * # `unlisten`
   *
   * Unsubscribes from a channel or all channels (placeholder).
   */
  unlisten: (channel?: string) => Promise<void>
  /**
   * # `notify`
   *
   * Sends a notification to a channel (placeholder).
   */
  notify: (channel: string, payload?: unknown) => Promise<void>
  // COPY support (stubs until available)
  /**
   * # `copyTo`
   *
   * Streams out data from a query or table (placeholder).
   */
  copyTo: (queryOrTable: string, options?: Record<string, unknown>) => Promise<unknown>
  /**
   * # `copyFrom`
   *
   * Streams data into a table (placeholder).
   */
  copyFrom: (queryOrTable: string, source: AsyncIterable<unknown> | Iterable<unknown>, options?: Record<string, unknown>) => Promise<unknown>
  // Pool readiness
  /**
   * # `ping`
   *
   * Executes a lightweight query to confirm connectivity.
   */
  ping: () => Promise<boolean>
  /**
   * # `waitForReady`
   *
   * Repeatedly pings until ready or attempts exhausted.
   */
  waitForReady: (opts?: { attempts?: number, delayMs?: number }) => Promise<void>
  /**
   * # `transaction`
   *
   * Runs the provided function within a transaction with retry options.
   *
   * @example
   * ```ts
   * const res = await db.transaction(async tx => {
   *   await tx.insertInto('users').values({ name: 'A' }).execute()
   *   return 'ok'
   * })
   * ```
   */
  transaction: <T>(fn: (tx: QueryBuilder<DB>) => Promise<T> | T, options?: TransactionOptions) => Promise<T>
  /**
   * # `savepoint`
   *
   * Executes the provided function inside a database savepoint.
   */
  savepoint: <T>(fn: (sp: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  /**
   * # `beginDistributed` / `commitDistributed` / `rollbackDistributed`
   *
   * Distributed transaction primitives (if supported by Bun.sql).
   */
  beginDistributed: <T>(name: string, fn: (tx: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  commitDistributed: (name: string) => Promise<void>
  rollbackDistributed: (name: string) => Promise<void>
  /**
   * # `configure`
   *
   * Applies runtime configuration overrides to this builder instance.
   */
  configure: (opts: Partial<typeof config>) => QueryBuilder<DB>
  /**
   * # `setTransactionDefaults`
   *
   * Sets default transaction options for this builder instance.
   */
  setTransactionDefaults: (defaults: TransactionOptions) => void
  /**
   * # `transactional`
   *
   * Wraps a function so it runs inside a new transaction when called.
   */
  transactional: <TArgs extends unknown[], R>(fn: (tx: QueryBuilder<DB>, ...args: TArgs) => Promise<R> | R, options?: TransactionOptions) => (...args: TArgs) => Promise<R>
  // aggregates
  count: <TTable extends keyof DB & string>(table: TTable, column?: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  avg: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  min: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(table: TTable, column: K) => Promise<DB[TTable]['columns'][K] | null>
  max: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(table: TTable, column: K) => Promise<DB[TTable]['columns'][K] | null>
  // dml helpers
  insertOrIgnore: <TTable extends keyof DB & string>(table: TTable, values: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => Promise<number>
  insertGetId: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string = DB[TTable]['primaryKey'] & keyof DB[TTable]['columns'] & string>(table: TTable, values: Partial<DB[TTable]['columns']>, idColumn?: K) => Promise<DB[TTable]['columns'][K]>
  updateOrInsert: <TTable extends keyof DB & string>(table: TTable, match: Partial<DB[TTable]['columns']>, values: Partial<DB[TTable]['columns']>) => Promise<boolean>
  upsert: <TTable extends keyof DB & string>(table: TTable, rows: Partial<DB[TTable]['columns']>[], conflictColumns: (keyof DB[TTable]['columns'] & string)[], mergeColumns?: (keyof DB[TTable]['columns'] & string)[]) => Promise<number>

  /**
   * # `create(table, values)`
   *
   * Inserts a row and returns the created record.
   */
  create: <TTable extends keyof DB & string>(
    table: TTable,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `createMany(table, rows)`
   *
   * Inserts multiple rows. Returns void.
   */
  createMany: <TTable extends keyof DB & string>(
    table: TTable,
    rows: Partial<DB[TTable]['columns']>[],
  ) => Promise<void>

  /**
   * # `insertMany(table, rows)`
   *
   * Alias for createMany. Inserts multiple rows. Returns void.
   */
  insertMany: <TTable extends keyof DB & string>(
    table: TTable,
    rows: Partial<DB[TTable]['columns']>[],
  ) => Promise<void>

  /**
   * # `updateMany(table, conditions, data)`
   *
   * Updates multiple rows matching conditions. Returns count of affected rows.
   */
  updateMany: <TTable extends keyof DB & string>(
    table: TTable,
    conditions: WhereExpression<DB[TTable]['columns']>,
    data: Partial<DB[TTable]['columns']>,
  ) => Promise<number>

  /**
   * # `deleteMany(table, ids)`
   *
   * Deletes multiple rows by IDs. Returns count of deleted rows.
   */
  deleteMany: <TTable extends keyof DB & string>(
    table: TTable,
    ids: PrimaryKeyValue<DB, TTable>[],
  ) => Promise<number>

  /**
   * # `firstOrCreate(table, match, [defaults])`
   *
   * Returns the first matching row, or creates one with defaults merged and returns it.
   */
  firstOrCreate: <TTable extends keyof DB & string>(
    table: TTable,
    match: Partial<DB[TTable]['columns']>,
    defaults?: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `updateOrCreate(table, match, values)`
   *
   * Updates the first matching row with values or creates a new one if none exists, then returns it.
   */
  updateOrCreate: <TTable extends keyof DB & string>(
    table: TTable,
    match: Partial<DB[TTable]['columns']>,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `save(table, values)`
   * If values contain the primary key and a row exists, updates it; otherwise creates a new row. Returns the row.
   */
  save: <TTable extends keyof DB & string>(
    table: TTable,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `remove(table, id)`
   * Deletes by primary key and returns adapter's first result object.
   */
  remove: <TTable extends keyof DB & string>(
    table: TTable,
    id: PrimaryKeyValue<DB, TTable>,
  ) => Promise<unknown>

  /**
   * # `find(table, id)`
   * Fetch by primary key. Returns the row or undefined.
   */
  find: <TTable extends keyof DB & string>(
    table: TTable,
    id: PrimaryKeyValue<DB, TTable>,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `findOrFail(table, id)`
   * Fetch by primary key or throw if not found.
   */
  findOrFail: <TTable extends keyof DB & string>(
    table: TTable,
    id: PrimaryKeyValue<DB, TTable>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `findMany(table, ids)`
   * Fetch many by primary keys.
   */
  findMany: <TTable extends keyof DB & string>(
    table: TTable,
    ids: PrimaryKeyValue<DB, TTable>[],
  ) => Promise<DB[TTable]['columns'][]>

  /**
   * # `latest(table, column?)`
   * Returns latest row by column or default timestamp column.
   */
  latest: <TTable extends keyof DB & string>(
    table: TTable,
    column?: keyof DB[TTable]['columns'] & string,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `oldest(table, column?)`
   * Returns oldest row by column or default timestamp column.
   */
  oldest: <TTable extends keyof DB & string>(
    table: TTable,
    column?: keyof DB[TTable]['columns'] & string,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `skip(table, count)`
   * Returns a builder with an offset applied.
   */
  skip: <TTable extends keyof DB & string>(
    table: TTable,
    count: number,
  ) => SelectQueryBuilder<DB, TTable, DB[TTable]['columns'], TTable>

  /**
   * # `rawQuery(sql)`
   * Execute a raw SQL string (single statement) with no parameters.
   */
  rawQuery: (query: string) => Promise<Record<string, unknown>[]>
  /** Safely wrap/validate an identifier for raw fragments. */
  id?: (name: string) => SqlFragment
  /** Safely wrap/validate multiple identifiers. */
  ids?: (...names: string[]) => SqlFragment
  /** Take an advisory lock (PostgreSQL only). */
  advisoryLock?: (key: number | string) => Promise<void>
  /** Try to take an advisory lock and return false if unavailable (PostgreSQL only). */
  tryAdvisoryLock?: (key: number | string) => Promise<boolean>
  /**
   * Release an advisory lock taken on THIS builder's connection.
   *
   * Both lock helpers existed without this one, which made them a trap rather
   * than a tool: a Postgres session lock is held until it is released or the
   * SESSION ends, and a pooled connection does not end when it is returned to
   * the pool. So `advisoryLock()` on a pooled builder leaked the lock onto
   * whichever connection happened to serve it, and the next caller waited
   * forever on a lock nobody was holding on purpose.
   *
   * Take the lock on a `reserve()`d connection and release it through the same
   * builder.
   */
  advisoryUnlock?: (key: number | string) => Promise<boolean>
  /** Get all relationships defined for a table. */
  getRelationships?: (table: string) => Record<string, unknown>
  /** Check if a table has a specific relationship. */
  hasRelationship?: (table: string, relationName: string) => boolean
  /** Get the type of a relationship (hasMany, belongsTo, etc.). */
  getRelationshipType?: (table: string, relationName: string) => string | null
  /** Get the target model/table of a relationship. */
  getRelationshipTarget?: (table: string, relationName: string) => string | null
}

// Typed INSERT builder to expose a structured SQL literal in hovers
export type TypedInsertQueryBuilder<
  DB extends AnyDatabaseSchema,
  TTable extends keyof DB & string,
  TSql extends string = `INSERT INTO ${TTable}`,
> = Omit<InsertQueryBuilder<DB, TTable>, 'toSQL' | 'values' | 'returning'> & {
  toSQL: () => TSql
  values: (
    data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[],
  ) => TypedInsertQueryBuilder<DB, TTable, `${TSql} ${string}`>
  returning: <K extends keyof DB[TTable]['columns'] & string>(
    ...cols: K[]
  ) => TypedSelectQueryBuilder<
    DB,
    TTable,
    Pick<DB[TTable]['columns'], K>,
    TTable,
    `${TSql} RETURNING ${string}`
  >
}

interface InternalState {
  /** The driver handle - Bun's `SQL` or our SQLite wrapper, both `DriverConnection`. */
  sql: DriverConnection
  meta?: SchemaMeta
  schema?: AnyDatabaseSchema
  txDefaults?: TransactionOptions
  /**
   * Lifecycle hooks for this builder specifically.
   *
   * `createQueryBuilder({ schema, meta, hooks })` is the form the docs have
   * shown for a long time, and it did not exist: `hooks` was not a member of
   * this interface, so the call was a `TS2353` excess-property error. The
   * obvious workaround made it worse rather than better — `as any` compiled,
   * and then the hooks never fired, because every hook site read the
   * process-wide `config.hooks` and nothing ever looked at builder state. A
   * builder that appeared configured silently ignored every hook it was given.
   *
   * These merge OVER `config.hooks` per key (see `activeHooks`), so a global
   * logger or tracer keeps firing for builders that only override one hook.
   */
  hooks?: QueryHooks
  /**
   * Set on the builder handed to a `transaction()` callback. A nested
   * `transaction()` must open a SAVEPOINT (`tx.savepoint(...)`) rather than a
   * new top-level transaction (`tx.begin(...)`) — Bun's driver throws "cannot
   * call begin inside a transaction" otherwise.
   */
  inTransaction?: boolean
}

// applyCondition and applyWhere moved inside createQueryBuilder to use the correct SQL instance

function isRetriableTxError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase()
  return (
    msg.includes('deadlock')
    || msg.includes('serialization failure')
    || msg.includes('could not serialize access')
    || msg.includes('deadlock found when trying to get lock') // MySQL
    || msg.includes('lock wait timeout exceeded') // MySQL
    || msg.includes('database is locked') // SQLite
    || msg.includes('busy') // SQLite BUSY
  )
}

type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable'
interface TxBackoff { baseMs?: number, maxMs?: number, factor?: number, jitter?: boolean }
interface TxLoggerEvent { type: 'start' | 'retry' | 'commit' | 'rollback' | 'error', attempt: number, error?: unknown, durationMs?: number }
export interface TransactionOptions {
  retries?: number
  isolation?: TransactionIsolation
  onRetry?: (attempt: number, error: unknown) => void
  afterCommit?: () => void
  sqlStates?: string[]
  backoff?: TxBackoff
  logger?: (event: TxLoggerEvent) => void
  /** When true, executes transaction in read-only mode (where supported). */
  readOnly?: boolean
  /** Called when a transaction is rolled back. */
  onRollback?: (error: unknown) => void
  /** Called after rollback completes. */
  afterRollback?: () => void
}

function matchesSqlState(err: any, states?: string[]): boolean {
  if (!states || states.length === 0)
    return false
  const code = (err && (err.code || err.sqlState || err.sqlstate)) as string | undefined
  if (!code)
    return false
  return states.includes(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Reorder a SELECT statement's trailing clauses into canonical SQL
 * order: WHERE → GROUP BY → HAVING → ORDER BY → LIMIT → OFFSET.
 *
 * Why this exists:
 *   The SELECT query builder appends clauses to its accumulated
 *   `text` string in METHOD-CALL order. If a caller chains
 *   `.orderBy().where()` (the natural shape for "build a base query,
 *   then conditionally add filters"), the resulting SQL comes out as
 *   `... ORDER BY ... WHERE ...`, which every dialect rejects. Most
 *   query builders (Knex, Kysely, Drizzle, Laravel) reorder clauses
 *   at compile time; bqb didn't, which made the chain-order pitfall
 *   a frequent source of `near "WHERE": syntax error`.
 *
 * How it works:
 *   Walks the string at paren-depth zero and outside string literals,
 *   recording where each top-level clause keyword starts. Splits the
 *   text into a base (SELECT … FROM … JOINs) plus per-clause
 *   fragments, then re-emits the fragments in canonical order.
 *
 * Known limitation: stray trailing fragments that aren't keyword-led
 * (e.g. a chained `.where()` AFTER `.orderBy()` that started with
 * `AND` because the first WHERE already existed) end up attached to
 * the preceding clause and stay misplaced. Workaround: chain all
 * `.where()` calls together before adding ORDER BY / LIMIT. For the
 * 95% case (single WHERE / single ORDER BY / single LIMIT in any
 * chain order), the reorder yields correct SQL.
 *
 * Subqueries inside parens are not parsed — `WHERE id IN (SELECT …
 * ORDER BY …)` keeps its inner ORDER BY untouched because the scan
 * only fires at paren-depth zero. Same for string literals
 * containing keyword text.
 *
 * See https://github.com/stacksjs/bun-query-builder/issues/1018
 */
// Memo for reorderSelectClauses: the scan runs on every built/executed query
// (ensureBuilt + toSQL + computeSqlText), and query TEXT repeats heavily in
// real apps because values travel as placeholders, not literals. Bounded;
// cleared wholesale at the cap (cheaper than LRU bookkeeping at this size).
const reorderCache = new Map<string, string>()
const REORDER_CACHE_MAX = 500

function reorderSelectClauses(sql: string): string {
  const hit = reorderCache.get(sql)
  if (hit !== undefined) return hit
  const out = computeReorderedClauses(sql)
  if (reorderCache.size >= REORDER_CACHE_MAX)
    reorderCache.clear()
  reorderCache.set(sql, out)
  return out
}

function computeReorderedClauses(sql: string): string {
  // Order matters in the keyword list: longer, multi-word keywords
  // must be checked before single-word prefixes that would
  // otherwise short-circuit them (e.g. "ORDER" alone isn't a clause
  // start; "ORDER BY" is).
  const KEYWORDS: Array<{ key: 'WHERE' | 'GROUP_BY' | 'HAVING' | 'ORDER_BY' | 'LIMIT' | 'OFFSET', tokens: RegExp }> = [
    { key: 'GROUP_BY', tokens: /^GROUP\s+BY\b/i },
    { key: 'ORDER_BY', tokens: /^ORDER\s+BY\b/i },
    { key: 'HAVING', tokens: /^HAVING\b/i },
    { key: 'OFFSET', tokens: /^OFFSET\b/i },
    { key: 'LIMIT', tokens: /^LIMIT\b/i },
    { key: 'WHERE', tokens: /^WHERE\b/i },
  ]

  const positions: Array<{ key: string, start: number }> = []
  let depth = 0
  let inString = false
  let stringChar = ''

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === stringChar) {
        // SQL escapes a quote by doubling it ('it''s'). Skip the pair.
        if (sql[i + 1] === stringChar) { i++; continue }
        inString = false
      }
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      inString = true
      stringChar = ch
      continue
    }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (depth !== 0) continue
    // Keyword must be word-boundary-led — i.e. preceded by whitespace
    // (or start of string, which never matches a clause).
    if (i === 0 || !/\s/.test(sql[i - 1])) continue
    // Cheap pre-filter: every clause keyword starts with G/O/H/L/W. Skip the
    // slice + regex battery (the hot part of this scan) for any other char.
    const lead = sql.charCodeAt(i) & ~32 // ASCII uppercase
    if (lead !== 71 && lead !== 79 && lead !== 72 && lead !== 76 && lead !== 87) continue
    const rest = sql.slice(i)
    for (const { key, tokens } of KEYWORDS) {
      const m = rest.match(tokens)
      if (!m) continue
      positions.push({ key, start: i })
      // Advance past the matched keyword so we don't re-detect it on
      // the next iteration of the outer loop.
      i += m[0].length - 1
      break
    }
  }

  // Nothing to reorder if zero or one clause: zero clauses means the
  // SQL is just SELECT…FROM, and a single clause is already in
  // canonical position relative to itself.
  if (positions.length <= 1) return sql

  const base = sql.slice(0, positions[0].start).trimEnd()
  const fragments: Record<string, string[]> = {}
  for (let p = 0; p < positions.length; p++) {
    const start = positions[p].start
    const end = p + 1 < positions.length ? positions[p + 1].start : sql.length
    const txt = sql.slice(start, end).trim()
    if (!fragments[positions[p].key]) fragments[positions[p].key] = []
    fragments[positions[p].key].push(txt)
  }

  const ORDER = ['WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY', 'LIMIT', 'OFFSET']
  const tail = ORDER
    .filter(k => fragments[k])
    .map(k => fragments[k].join(' '))
    .join(' ')

  return tail ? `${base} ${tail}` : base
}

function computeBackoffMs(attempt: number, cfg?: TxBackoff): number {
  const base = Math.max(1, cfg?.baseMs ?? 50)
  const factor = Math.max(1, cfg?.factor ?? 2)
  const max = Math.max(base, cfg?.maxMs ?? 2000)
  let ms = Math.min(max, base * (factor ** Math.max(0, attempt - 1)))
  if (cfg?.jitter) {
    // Symmetric ±10% around the computed delay. The previous form only ever
    // SUBTRACTED (0–10%), so every retrying transaction still clustered at the
    // top of the same narrow window — which is the thundering herd jitter
    // exists to break up. Clamped to the cap so jitter can't overshoot maxMs.
    ms = Math.min(max, ms * (0.9 + Math.random() * 0.2))
  }
  return Math.floor(ms)
}

// eslint-disable-next-line pickier/no-unused-vars
export function createQueryBuilder<DB extends AnyDatabaseSchema>(state?: Partial<InternalState>): QueryBuilder<DB> {
  // Single boundary cast: `state.sql` is `any` (allows mock/tx injection) and
  // getOrCreateBunSql() returns Bun's `SQL`; both satisfy DriverConnection. With
  // `_sql` typed, the downstream `.unsafe(...)` calls no longer need casts (#1044).
  //
  // EVERY statement this builder executes must go through `_sql`, never the
  // module-global `bunSql`. They are the same object only for a plain builder;
  // the moment one is created with its own connection — `db.transaction()`,
  // `savepoint()`, `beginDistributed()`, `reserve()`, or an explicit
  // `createQueryBuilder({ sql })` — they are two different connections, and the
  // global is a DIFFERENT pooled session from the one the builder's own reads
  // and writes use.
  //
  // That is not a cosmetic distinction. A write issued on the global while the
  // caller is inside `db.transaction()` autocommits on its own session, so it
  // outlives a ROLLBACK: the transaction fails, the caller sees the error, and
  // the row is still there. A read issued on the global cannot see the
  // transaction's uncommitted rows, so read-then-decide logic acts on stale
  // data. With `pool: { max: 1 }` it does not even get that far — the call
  // blocks forever waiting for the single connection its own transaction is
  // holding. All three are silent; none produces a driver error.
  //
  // The exceptions are the pool-lifecycle methods (`reserve`, `close`), which
  // act on the pool itself rather than on a session, and the two-phase
  // `commitDistributed`/`rollbackDistributed`, which by design run outside the
  // transaction that prepared them.
  const _sql: DriverConnection = (state?.sql ?? getOrCreateBunSql()) as unknown as DriverConnection
  const meta = state?.meta
  const schema = state?.schema

  /**
   * A row's date columns, in the shape the dialect accepts.
   *
   * Applied once, where a row enters the builder, rather than at each of the
   * several places a parameter is bound: an insert has four code paths (single
   * row, multi row, Postgres, the rest) and an update has its own, and a rule
   * that has to be remembered in five places is a rule that will be missed in
   * one. A no-op on Postgres, which takes ISO-8601 as written.
   */
  const reshapeTemporal = <T extends Record<string, any>>(table: string, rows: readonly T[]): T[] => {
    const columns = meta?.temporalColumns?.[table]

    if (!columns || columns.length === 0 || !isMysqlLike(config.dialect))
      return rows as T[]

    return rows.map((row) => {
      let copy: T | null = null

      for (const column of columns) {
        if (!(column in row))
          continue

        const shaped = temporalLiteral(row[column])

        if (shaped !== row[column]) {
          copy = copy ?? { ...row }
          ;(copy as Record<string, unknown>)[column] = shaped
        }
      }

      return copy ?? row
    })
  }

  /**
   * The 32-bit key Postgres advisory locks take, derived from a string name.
   *
   * Extracted because lock, try-lock and unlock each carried their own copy:
   * three transcriptions of one hash, where any drift between them means
   * `advisoryUnlock` computes a different key than `advisoryLock` did and
   * silently releases nothing.
   */
  function advisoryLockKey(key: number | string): number {
    if (typeof key === 'number')
      return key
    const s = String(key)
    let hash = 7
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
    return Math.abs(hash)
  }

  /**
   * The hooks this builder should fire.
   *
   * Read through this rather than reaching for `config.hooks` directly, for the
   * same reason statements go through `_sql`: a builder can be handed its own,
   * and ignoring them makes a configured builder silently do nothing.
   *
   * Resolved per call, not captured once, because `setConfig({ hooks })` may
   * land after the builder is constructed — the usual
   * `export const db = createQueryBuilder(...)` at module scope followed by
   * configuration at boot. Merged per key so a global logger still fires for a
   * builder that overrides only `beforeCreate`.
   */
  function activeHooks(): QueryHooks | undefined {
    if (!state?.hooks)
      return config.hooks
    return { ...config.hooks, ...state.hooks }
  }

  // `whereCreatedAt` → `created_at` resolution for the dynamic-where Proxy,
  // cached per (table, prop): the schema is fixed for this builder, and the
  // resolution (regex strip + snake-case + column scan) otherwise re-runs on
  // every property access in query hot paths.
  const dynamicWhereColumnCache = new Map<string, string>()

  function applyCondition(expr: WhereExpression<any>): any {
    // Returns just the condition part without WHERE keyword
    // Avoid using _sql(column) as it creates "helpers" that Bun restricts
    if (Array.isArray(expr)) {
      const [col, op, val] = expr
      // Validate column + operator so callers building either from
      // request input (`Model.where([req.query.field, req.query.op,
      // value])`) can't inject SQL via either slot. See
      // stacksjs/stacks#1858 Q-6, Q-8.
      validateIdentifier(col, 'where(column)')
      const colName = String(col)
      switch (op) {
        case 'in':
          if (Array.isArray(val)) {
            const placeholders = getPlaceholders(val.length)
            return _sql.unsafe(`${colName} IN (${placeholders})`, val)
          }
          return _sql.unsafe(`${colName} IN (${getPlaceholder(1)})`, [val])
        case 'not in':
          if (Array.isArray(val)) {
            const placeholders = getPlaceholders(val.length)
            return _sql.unsafe(`${colName} NOT IN (${placeholders})`, val)
          }
          return _sql.unsafe(`${colName} NOT IN (${getPlaceholder(1)})`, [val])
        case 'like':
          return _sql.unsafe(`${colName} LIKE ${getPlaceholder(1)}`, [val])
        case 'is':
        case 'is not': {
          // `is` / `is not` is `IS NULL` / `IS NOT NULL` only. The
          // previous shape interpolated `val` directly into the SQL
          // (`IS ${val}`), so passing `val = 'NULL; DROP TABLE x'`
          // landed straight in the query string. The spec says these
          // operators only compare against NULL, so reject anything
          // else loud. See stacksjs/stacks#1858 Q-8.
          if (val !== null && val !== undefined) {
            throw new TypeError(`[query-builder] where(..., '${op}', ?): operator '${op}' only accepts NULL/undefined as value, got ${typeof val} (${String(val)})`)
          }
          return _sql.unsafe(`${colName} IS ${op === 'is not' ? 'NOT ' : ''}NULL`)
        }
        case '!=':
          return _sql.unsafe(`${colName} <> ${getPlaceholder(1)}`, [val])
        case '<':
        case '>':
        case '<=':
        case '>=':
        case '=':
          return _sql.unsafe(`${colName} ${op} ${getPlaceholder(1)}`, [val])
        default:
          throw new TypeError(`[query-builder] where(..., '${String(op)}', ?): unsupported operator. Allowed: =, !=, <>, <, <=, >, >=, like, in, not in, is, is not`)
      }
    }
    if ('raw' in (expr as any)) {
      return (expr as WhereRaw).raw
    }
    // Object notation: {name: 'Alice', age: 25}
    const keys = Object.keys(expr)
    if (keys.length === 0)
      return _sql.unsafe('')

    const conditions: string[] = []
    const allParams: any[] = []
    let paramIndex = 1

    for (const key of keys) {
      // Object-form `where({col: val})` — keys come from
      // `Object.keys(arbitraryInput)`. Validate so a caller that
      // spreads `req.body` can't smuggle a SQL expression as a key
      // name. See stacksjs/stacks#1858 Q-6.
      validateIdentifier(key, 'where(object key)')
      const value = (expr as any)[key]
      if (Array.isArray(value)) {
        const placeholders = getPlaceholders(value.length, paramIndex)
        conditions.push(`${key} IN (${placeholders})`)
        allParams.push(...value)
        paramIndex += value.length
      }
      else {
        conditions.push(`${key} = ${getPlaceholder(paramIndex++)}`)
        allParams.push(value)
      }
    }

    return _sql.unsafe(conditions.join(' AND '), allParams)
  }

  // eslint-disable-next-line pickier/no-unused-vars
  function applyWhere(columns: Record<string, unknown>, q: any, expr?: WhereExpression<any>) {
    if (!expr)
      return q
    const condition = applyCondition(expr)
    return _sql`${q} WHERE ${condition}`
  }

  function computeSqlText(q: any): string {
    const prev = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
    const s = String(q)
    if (config.debug)
      config.debug.captureText = prev as boolean
    return s
  }

  /**
   * Best-effort extraction of a query's bound parameters for the hook events
   * (#1045). The bun:sqlite wrapper exposes them as a `.values` array; Bun's
   * native query exposes `.values` as a method (skipped). Returns undefined
   * when not cheaply available.
   */
  function computeParams(q: any): any[] | undefined {
    if (!q || typeof q !== 'object')
      return undefined
    if (Array.isArray(q.values))
      return q.values
    if (Array.isArray(q.parameters))
      return q.parameters
    if (Array.isArray(q.params))
      return q.params
    return undefined
  }

  function runWithHooks<T = any>(q: any, kind: 'select' | 'insert' | 'update' | 'delete' | 'raw', opts?: { signal?: AbortSignal, timeoutMs?: number }): Promise<T> {
    const hooks = activeHooks()
    const slowMs = hooks?.slowQueryThresholdMs
    const slowEnabled = slowMs != null && slowMs >= 0
    const hasSlowQuery = Boolean(hooks?.onSlowQuery || slowEnabled)
    const hasHooks = hooks && (hooks.onQueryStart || hooks.onQueryEnd || hooks.onQueryError || hooks.startSpan || hasSlowQuery)
    const hasTimeoutOrSignal = (opts?.timeoutMs && opts.timeoutMs > 0) || opts?.signal

    // Fast path: no hooks, no timeout, no signal - direct execute
    if (!hasHooks && !hasTimeoutOrSignal) {
      return (q as any).execute()
    }

    const text = computeSqlText(q)
    const params = computeParams(q)
    const startAt = Date.now()
    let span: { end: (error?: any) => void } | undefined

    try {
      hooks?.onQueryStart?.({ sql: text, params, kind })
      if (hooks?.startSpan)
        span = hooks.startSpan({ sql: text, params, kind })
    }
    catch {}

    let finished = false
    const finish = (err?: any, rowCount?: number) => {
      if (finished)
        return
      finished = true
      const durationMs = Date.now() - startAt
      try {
        if (err) {
          hooks?.onQueryError?.({ sql: text, params, error: err, durationMs, kind })
        }
        else {
          hooks?.onQueryEnd?.({ sql: text, params, durationMs, rowCount, kind })
          // Slow-query reporting reuses the duration just measured (#1045).
          if (slowEnabled && durationMs >= (slowMs as number)) {
            if (hooks?.onSlowQuery)
              hooks.onSlowQuery({ sql: text, params, durationMs, kind })
            else
              console.warn(`[query-builder] slow query (${durationMs}ms >= ${slowMs}ms): ${text}`)
          }
        }
      }
      catch {}
      try {
        span?.end(err)
      }
      catch {}
    }

    const execPromise = (q as any).execute()

    // Handle timeout/abort by canceling the query if driver supports it
    const promises: Promise<any>[] = [execPromise]
    let timeoutId: any
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            (q as any).cancel?.()
          }
          catch {}
          const err = new Error(`Query timed out after ${opts.timeoutMs}ms`)
          ;(err as any).code = 'EBQBTIMEOUT'
          reject(err)
        }, opts.timeoutMs)
      })
      promises.push(timeoutPromise)
    }
    if (opts?.signal) {
      if (opts.signal.aborted) {
        try {
          (q as any).cancel?.()
        }
        catch {}
        const err = new Error('Query aborted')
          ;(err as any).code = 'EBQBABORT'
        finish(err)
        return Promise.reject(err)
      }
      const abortHandler = () => {
        try {
          (q as any).cancel?.()
        }
        catch {}
      }
      opts.signal.addEventListener('abort', abortHandler, { once: true })
      execPromise.finally(() => {
        opts.signal?.removeEventListener('abort', abortHandler)
      })
    }

    return Promise.race(promises)
      .then((rows) => {
        clearTimeout(timeoutId)
        const rc = Array.isArray(rows) ? rows.length : (typeof rows === 'number' ? rows : undefined)
        finish(undefined, rc)
        return rows
      })
      .catch((err) => {
        clearTimeout(timeoutId)
        finish(err)
        throw err
      })
  }

  /**
   * Normalize mutation metadata returned by Bun SQL drivers.
   *
   * SQLite returns `{ changes, lastInsertRowid }`, MySQL commonly returns
   * `{ affectedRows }`, and PostgreSQL adapters may expose `rowCount`.
   * Builder mutation methods promise numeric counts, so leaking the raw
   * driver object produces nested results such as
   * `{ numDeletedRows: { changes: 1 } }`.
   */
  function mutationCount(result: unknown): number {
    if (typeof result === 'number')
      return Number.isFinite(result) ? result : 0
    if (typeof result === 'bigint')
      return Number(result)
    if (!result || typeof result !== 'object')
      return 0

    const record = result as Record<string, unknown>
    for (const key of [
      'changes',
      'affectedRows',
      'count',
      'rowCount',
      'numAffectedRows',
      'numUpdatedRows',
      'numDeletedRows',
      'numInsertedOrUpdatedRows',
    ]) {
      if (record[key] !== undefined && record[key] !== null)
        return mutationCount(record[key])
    }
    if (Array.isArray(result))
      return result.reduce((total, item) => total + mutationCount(item), 0)
    return 0
  }

  function makeExecutableQuery(q: any, text?: string) {
    const sqlText = text ?? computeSqlText(q)
    return {
      sql: sqlText,
      toString: () => sqlText,
      execute: () => (q as any).execute(),
      values: () => (q as any).values(),
      raw: () => (q as any).raw(),
    }
  }

  // eslint-disable-next-line pickier/no-unused-vars
  function makeSelect<TTable extends keyof DB & string>(table: TTable): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT * FROM ${TTable}`>
  // eslint-disable-next-line pickier/no-unused-vars
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns: string[]): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT ${string} FROM ${TTable}`>
  // eslint-disable-next-line pickier/no-unused-vars
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns?: string[]): any {
    // Use the sql instance from state (allows tests to inject mockSql)
    const sql = _sql
    // Build query using unsafe for better performance
    let text = (columns && columns.length > 0)
      ? `SELECT ${columns.join(', ')} FROM ${String(table)}`
      : `SELECT * FROM ${String(table)}`

    // The WHERE clause is a TERM LIST, not text appended to `text`. Each term
    // records the connector its caller asked for, and the body is rendered at
    // emit time by renderWhereTerms(), which brackets each maximal OR-run with
    // the term that opens it.
    //
    // A `whereConditions: string[]` used to live here with 25 pushes and zero
    // reads — a structured representation nobody ever wired to the emit path,
    // which is exactly why `orWhere` shipped as flat text and mis-grouped.
    // See stacksjs/bun-query-builder#1083.
    const whereTerms: WhereTerm[] = []
    const whereParams: unknown[] = []
    // Set once a set operator closes the current SELECT. Terms pushed after a
    // UNION/INTERSECT/EXCEPT belong to the RIGHT-hand SELECT and must render at
    // the end of `text`, or their params would bind in the wrong order.
    let whereTail = false
    /**
     * Whether the operand a tail predicate would attach to already carries one.
     *
     * Only consulted once `whereTail` is set. It used to be inferred by testing
     * the WHOLE statement for `/\bWHERE\b/`, but by then `text` holds the LEFT
     * select — WHERE and all — so a predicate on the left was read as one on
     * the right and the right side's first predicate came out as `AND`:
     *
     *     SELECT * FROM a WHERE y = $1 UNION SELECT * FROM b AND x = $2
     *
     * which does not parse. Set from the right-hand operand alone. See #1120.
     */
    let tailHasPredicate = false
    /**
     * Whether this builder has emitted its HAVING.
     *
     * Same defect as #1113, different keyword: scanning `text` for
     * `/\bHAVING\b/` also matches a raw select fragment that merely contains
     * the word, so the first real HAVING was emitted as `AND` and fused onto
     * the GROUP BY list. See #1122.
     */
    let hasHaving = false

    // Lazy building: don't prepare statement until execution
    // built is initialized lazily to avoid expensive template tag calls on every query
    let built: any = null
    const ensureBuilt = () => {
      if (built === null) {
        const finalText = reorderSelectClauses(currentSql())
        built = whereParams.length > 0
          ? _sql.unsafe(finalText, whereParams)
          : _sql.unsafe(finalText)
      }
      return built
    }

    /** Record one WHERE predicate. The connector is the caller's intent, not a
     *  position — renderWhereTerms() decides what the first term emits. */
    const pushWhere = (conn: 'AND' | 'OR', clause: string) => {
      whereTerms.push({ conn, sql: clause })
      built = null
    }

    // Kept so the existing call sites need no edit. Callers pass 'WHERE' to
    // mean "a where-type clause" (whereLike/whereExists/whereILike/the dynamic
    // whereX proxy all do); only 'OR' is a real disjunction.
    const addWhereText = (prefix: 'WHERE' | 'AND' | 'OR', clause: string) => {
      pushWhere(prefix === 'OR' ? 'OR' : 'AND', clause)
    }

    // Index of the first TOP-LEVEL clause that must follow WHERE, or -1.
    // Paren-depth scan so a subquery's own ORDER BY/LIMIT doesn't match.
    const TAIL_CLAUSE = /\(|\)|\b(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW|UNION|INTERSECT|EXCEPT|FOR\s+UPDATE|FOR\s+SHARE|LOCK\s+IN\s+SHARE\s+MODE)\b/gi
    const firstTailIndex = (s: string): number => {
      TAIL_CLAUSE.lastIndex = 0
      let depth = 0
      let m: RegExpExecArray | null
      // eslint-disable-next-line no-cond-assign
      while ((m = TAIL_CLAUSE.exec(s))) {
        if (m[0] === '(') { depth++ }
        else if (m[0] === ')') { depth = Math.max(0, depth - 1) }
        else if (depth === 0) { return m.index }
      }
      return -1
    }

    /**
     * `text` with the rendered WHERE spliced in ahead of the first trailing
     * clause.
     *
     * EVERY path that emits executable SQL must go through this. The WHERE no
     * longer lives in `text`, so reading `text` directly now yields a query
     * with no filter at all — the worst failure mode available here, and the
     * reason this function exists rather than the splice being inlined.
     *
     * Splicing rather than appending also fixes `.where(a).orderBy(c).orWhere(b)`,
     * which used to emit `… ORDER BY c ASC OR b` and fail to parse.
     *
     * `extra` appends one more AND-term for this render only, without recording
     * it. That is what cursorPaginate needs: its cursor predicate changes on
     * every page, so pushing it onto `whereTerms` would accumulate one stale
     * predicate per iteration.
     */
    const currentSql = (extra?: WhereTerm): string => {
      const body = renderWhereTerms(extra ? [...whereTerms, extra] : whereTerms)
      if (!body)
        return text
      if (whereTail) {
        const kw = tailHasPredicate ? 'AND' : 'WHERE'
        return `${text} ${kw} ${body}`
      }
      const cut = firstTailIndex(text)
      return cut >= 0
        ? `${text.slice(0, cut)}WHERE ${body} ${text.slice(cut)}`
        : `${text} WHERE ${body}`
    }

    /**
     * A parenthesised sub-group: the escape hatch for `(a AND b) OR c`, the one
     * shape the new precedence rule can no longer express by chaining alone.
     *
     * The callback receives a fresh builder over the same table and only its
     * WHERE state is harvested — nothing else it touches has any effect.
     */
    const addWhereGroup = (conn: 'AND' | 'OR', cb: (b: any) => unknown) => {
      const sub: any = makeSelect(table as any)
      cb(sub)
      const st = sub.__whereState?.() as { body: string, params: unknown[] } | undefined
      if (!st || !st.body) {
        // Fails closed, for the same reason where() throws on a condition it
        // does not understand: a group that contributed nothing would leave the
        // query matching every row the filter existed to exclude.
        throw new TypeError(
          '[query-builder] whereGroup(callback): the callback added no conditions. '
          + 'Add at least one where()/orWhere() to the builder it receives.',
        )
      }
      const offset = whereParams.length
      // The sub-builder numbered its placeholders from $1; on Postgres they
      // have to continue ours. `?` dialects need no renumbering.
      const body = offset > 0 && config.dialect === 'postgres'
        ? st.body.replace(/\$(\d+)/g, (_m: string, n: string) => `$${Number(n) + offset}`)
        : st.body
      whereParams.push(...st.params)
      pushWhere(conn, `(${body})`)
    }

    /**
     * The body of `andWhere` and `orWhere`.
     *
     * These were two near-identical 75-line copies that differed only in the
     * connector they emitted — which is exactly how the OR variant came to be
     * the one that mis-grouped. One implementation, connector as a parameter.
     */
    const addBooleanWhere = (self: any, conn: 'AND' | 'OR', label: string, expr: any, op?: WhereOperator, value?: any) => {
      if (typeof expr === 'string' && op !== undefined) {
        validateIdentifier(String(expr), `${label}(column)`)
        assertSafeWhereOperator(op, `${label}(operator)`)
        const paramIndex = whereParams.length + 1
        whereParams.push(value)
        pushWhere(conn, `${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`)
        return self
      }

      // Array format: ['column', 'op', value]
      if (Array.isArray(expr)) {
        const [col, rawOp, val] = expr
        const colName = String(col)
        validateIdentifier(colName, `${label}(column)`)
        const operator = assertSafeWhereOperator(rawOp, `${label}(operator)`)

        if (operator === 'in' || operator === 'not in') {
          const values = Array.isArray(val) ? val : [val]
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          const clause = renderInPredicate(quoteColumnForDialect(colName), values, operator === 'not in', placeholders)
          whereParams.push(...values)
          pushWhere(conn, clause)
        }
        else {
          const paramIndex = whereParams.length + 1
          whereParams.push(val)
          pushWhere(conn, `${colName} ${operator} ${getPlaceholder(paramIndex)}`)
        }
        return self
      }

      // Callback: a parenthesised group, same as where(callback)/whereGroup().
      if (typeof expr === 'function') {
        addWhereGroup(conn, expr)
        return self
      }

      // Object format: { name: 'Alice', age: 25 }
      if (expr && typeof expr === 'object' && !('raw' in expr)) {
        const conditions: string[] = []
        for (const key of Object.keys(expr)) {
          validateIdentifier(key, `${label}(column)`)
          const v = (expr as any)[key]
          if (Array.isArray(v)) {
            const placeholders = getPlaceholders(v.length, whereParams.length + 1)
            conditions.push(renderInPredicate(quoteColumnForDialect(key), v, false, placeholders))
            whereParams.push(...v)
          }
          else {
            const paramIndex = whereParams.length + 1
            conditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
            whereParams.push(v)
          }
        }
        // One term. `orWhere({a, b})` means "OR (a AND b)", so the conjunction
        // has to be bracketed — un-bracketed it bound only `a` to the OR.
        if (conditions.length > 0)
          pushWhere(conn, conditions.length > 1 ? `(${conditions.join(' AND ')})` : conditions[0])
        return self
      }

      // Raw expressions
      if (expr && typeof (expr as any).raw !== 'undefined') {
        pushWhere(conn, (expr as any).raw)
        return self
      }

      return self
    }

    // Append a UNION/UNION ALL (extensible to INTERSECT/EXCEPT) while MERGING
    // the other side's bound params and renumbering its `$n` placeholders past
    // ours on Postgres — previously the set-op appended text only, dropping the
    // right side's params and colliding `$1`. See stacksjs/bun-query-builder#1029.
    const appendSetOp = (op: string, other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] }, __hasPredicate?: () => boolean }) => {
      // Params are one flat array in push order, so the WHERE text has to
      // precede the set operator's params in the emitted string. Materialize it
      // into `text` now; terms added after this point belong to the RIGHT-hand
      // SELECT and render at the end — which is what the old text-append did.
      if (whereTerms.length > 0) {
        text = currentSql()
        whereTerms.length = 0
      }
      whereTail = true
      const st = other.__rawState?.()
      if (st) {
        const offset = whereParams.length
        const otherSql = config.dialect === 'postgres'
          ? st.sql.replace(/\$(\d+)/g, (_m: string, n: string) => `$${Number(n) + offset}`)
          : st.sql
        text += ` ${op} ${otherSql}`
        whereParams.push(...st.params)
        // A predicate added after this point attaches to the RIGHT operand, so
        // the keyword depends on that operand alone — not on the statement,
        // which by now also holds the left side's WHERE. Ask the builder; only
        // scan when it is a foreign one that cannot answer. See #1120.
        tailHasPredicate = other.__hasPredicate?.() ?? SQL_PATTERNS.WHERE.test(otherSql)
      }
      else {
        // Foreign builder without __rawState — fall back to text-only (no param merge).
        const otherSql = String(other.toSQL())
        text += ` ${op} ${otherSql}`
        tailHasPredicate = other.__hasPredicate?.() ?? SQL_PATTERNS.WHERE.test(otherSql)
      }
      built = null
    }

    // Splice a JOIN clause into its correct position — after FROM/existing
    // joins but before the first TOP-LEVEL trailing clause (WHERE/GROUP BY/
    // HAVING/ORDER BY/LIMIT/OFFSET/UNION). Previously joins were appended to the
    // end of `text`, so `.where(...).join(...)` emitted `... WHERE ... JOIN ...`
    // (invalid on every dialect). Also invalidates `built`. Paren-depth scan so
    // a subquery's inner WHERE doesn't get matched. See #1030.
    const insertJoin = (joinClause: string) => {
      const re = /\(|\)|\b(?:WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|UNION)\b/gi
      let depth = 0
      let cut = -1
      let mm: RegExpExecArray | null
      // eslint-disable-next-line no-cond-assign
      while ((mm = re.exec(text))) {
        if (mm[0] === '(') { depth++ }
        else if (mm[0] === ')') { depth = Math.max(0, depth - 1) }
        else if (depth === 0) { cut = mm.index; break }
      }
      text = cut >= 0
        ? `${text.slice(0, cut)}${joinClause} ${text.slice(cut)}`
        : `${text} ${joinClause}`
      built = null
    }

    const joinedTables = new Set<string>()
    let timeoutMs: number | undefined
    let abortSignal: AbortSignal | undefined
    let includeTrashed = false
    let onlyTrashed = false
    let useCache = false
    const pivotColumns = new Map<string, string[]>() // Store pivot columns per relationship
    /**
     * Relations declared with the new `BelongsToManyConfig` (Option A or B).
     * Result rows for these relations will be post-processed to nest
     * `pivot_<col>` aliases under a `.pivot` object — matching the issue's
     * `a.pivot.role` access pattern. Legacy string-form relations keep emitting
     * flat `pivot_<col>` keys for backwards compatibility.
     */
    const pivotConfigRelations = new Set<string>()
    let cacheTtl = 60000

    /**
     * Closure-level singularize, honoring `config.relations.singularizeStrategy`.
     * Lifted here so the pivot resolver and `wherePivot` can use it without
     * being inside the `with()` method body.
     */
    const singularize = (name: string): string =>
      singularizerFor(config.relations.singularizeStrategy)(name)

    /** Local helper: resolve the pivot for a relation on the current table. */
    const resolvePivotLocal = (relationKey: string): ResolvedPivot | null => {
      if (!meta) return null
      return resolvePivot(meta as SchemaMeta, String(table), relationKey, {
        singularize,
        models: (meta as SchemaMeta).models,
      })
    }

    /**
     * Walk a result row and lift any `pivot_<col>` alias into a nested
     * `row.pivot.<col>` object, deleting the flat key. Only applied when the
     * source relation came from a `BelongsToManyConfig` (tracked in
     * `pivotConfigRelations`); the legacy string form keeps the flat shape.
     */
    const hydratePivotRow = (row: any): any => {
      if (!row || typeof row !== 'object' || pivotConfigRelations.size === 0)
        return row
      let pivot: Record<string, unknown> | undefined
      for (const k of Object.keys(row)) {
        if (k.startsWith('pivot_')) {
          if (!pivot) pivot = {}
          pivot[k.slice(6)] = row[k]
          delete row[k]
        }
      }
      if (pivot) row.pivot = pivot
      return row
    }
    const hydratePivotRows = (rows: any): any => {
      if (pivotConfigRelations.size === 0 || !rows) return rows
      if (Array.isArray(rows)) {
        for (let i = 0; i < rows.length; i++) hydratePivotRow(rows[i])
      }
      else {
        hydratePivotRow(rows)
      }
      return rows
    }

    /**
     * Auto-join the pivot table for a belongsToMany relation if not already
     * joined. Called by wherePivot* before adding the predicate.
     */
    const ensurePivotJoined = (resolved: ResolvedPivot): void => {
      if (!meta) return
      if (joinedTables.has(resolved.pivotTable))
        return
      const parentTable = String(table)
      const parentPk = meta.primaryKeys[parentTable] ?? 'id'
      validateIdentifier(resolved.pivotTable, 'wherePivot auto-join (pivot table)')
      validateIdentifier(resolved.fkParent, 'wherePivot auto-join (parent FK)')
      validateIdentifier(parentTable, 'wherePivot auto-join (parent table)')
      validateIdentifier(parentPk, 'wherePivot auto-join (parent PK)')
      built = sql`${ensureBuilt()} LEFT JOIN ${sql(resolved.pivotTable)} ON ${sql(`${resolved.pivotTable}.${resolved.fkParent}`)} = ${sql(`${parentTable}.${parentPk}`)}`
      // Reflect in text so toSQL() sees it
      text = `${text} LEFT JOIN ${resolved.pivotTable} ON ${resolved.pivotTable}.${resolved.fkParent} = ${parentTable}.${parentPk}`
      joinedTables.add(resolved.pivotTable)
    }


    // Helper function to add columns to the SELECT clause
    const addToSelectClause = (columnsToAdd: string): void => {
      // Update text representation for toSQL()
      if (SQL_PATTERNS.SELECT_STAR.test(text)) {
        text = text.replace(SQL_PATTERNS.SELECT_STAR, `SELECT *, ${columnsToAdd}`)
      }
      else if (SQL_PATTERNS.SELECT.test(text)) {
        text = text.replace(SQL_PATTERNS.SELECT_FROM, `SELECT $1, ${columnsToAdd} FROM`)
      }

      // Update built query
      const currentSelect = String(ensureBuilt())
      if (SQL_PATTERNS.SELECT_STAR.test(currentSelect)) {
        const newSql = currentSelect.replace(SQL_PATTERNS.SELECT_STAR, `SELECT *, ${columnsToAdd}`)
        built = _sql.unsafe(newSql)
      }
      else if (SQL_PATTERNS.SELECT.test(currentSelect)) {
        const selectPart = SQL_PATTERNS.SELECT_FROM.exec(currentSelect)
        if (selectPart) {
          const newSql = currentSelect.replace(SQL_PATTERNS.SELECT_FROM, `SELECT $1, ${columnsToAdd} FROM`)
          built = _sql.unsafe(newSql)
        }
      }
    }

    const addWindowFunction = (fnExpr: string, alias: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]): void => {
      addToSelectClause(`${fnExpr} ${buildOverClause(partitionBy, orderBy)} AS ${alias}`)
    }

    // Helper function to build hasOne/hasMany subquery with validation
    const buildHasSubquery = (parentTable: string, targetTable: string, pk: string, callback?: (qb: any) => any): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')

      const fk = `${parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable}_id`
      validateIdentifier(fk, 'relationship subquery (foreign key)')

      let subquerySQL = `SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${fk} = ${parentTable}.${pk}`

      if (callback) {
        const subQb = {
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${assertSafeWhereOperator(op, 'whereHas callback')} ${formatSubqueryValue(val)}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build belongsTo subquery with validation
    const buildBelongsToSubquery = (parentTable: string, targetTable: string, pk: string, callback?: (qb: any) => any): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')

      const fk = `${targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable}_id`
      validateIdentifier(fk, 'relationship subquery (foreign key)')

      let subquerySQL = `SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${pk} = ${parentTable}.${fk}`

      if (callback) {
        const subQb = {
          // Same boundary guards as the hasOne/hasMany variant: the operator
          // is allow-listed and string values are SQL-escaped. The previous
          // `'${val}'` interpolation let a quote in `val` terminate the
          // literal — a whereHas(belongsTo, cb) injection vector.
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${assertSafeWhereOperator(op, 'whereHas callback')} ${formatSubqueryValue(val)}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build belongsToMany subquery with validation
    const buildBelongsToManySubquery = (parentTable: string, targetTable: string, pk: string, targetPk: string, callback?: (qb: any) => any, relationKey?: string): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')
      validateIdentifier(targetPk, 'relationship subquery (target primary key)')

      // Honor BelongsToManyConfig overrides when the relation name is known.
      const resolved = relationKey && meta
        ? resolvePivot(meta as SchemaMeta, parentTable, relationKey, { singularize, models: (meta as SchemaMeta).models })
        : null
      const a = singularize(parentTable)
      const b = singularize(targetTable)
      const pivot = resolved?.pivotTable ?? [a, b].sort().join('_')
      const fkA = resolved?.fkParent ?? `${a}_id`
      const fkB = resolved?.fkRelated ?? `${b}_id`

      validateIdentifier(pivot, 'relationship subquery (pivot table)')
      validateIdentifier(fkA, 'relationship subquery (foreign key A)')
      validateIdentifier(fkB, 'relationship subquery (foreign key B)')

      let subquerySQL = `SELECT 1 FROM ${pivot} JOIN ${targetTable} ON ${targetTable}.${targetPk} = ${pivot}.${fkB} WHERE ${pivot}.${fkA} = ${parentTable}.${pk}`

      if (callback) {
        const subQb = {
          // Same boundary guards as the hasOne/hasMany variant — see
          // buildBelongsToSubquery above for why.
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${assertSafeWhereOperator(op, 'whereHas callback')} ${formatSubqueryValue(val)}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build count subquery for hasOne/hasMany with validation
    const buildHasCountSubquery = (parentTable: string, targetTable: string, pk: string): string => {
      validateIdentifier(parentTable, 'withCount (parent table)')
      validateIdentifier(targetTable, 'withCount (target table)')
      validateIdentifier(pk, 'withCount (primary key)')

      const fk = `${parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable}_id`
      validateIdentifier(fk, 'withCount (foreign key)')

      return `(SELECT COUNT(*) FROM ${targetTable} WHERE ${targetTable}.${fk} = ${parentTable}.${pk})`
    }

    // Helper function to build count subquery for belongsToMany with validation
    const buildBelongsToManyCountSubquery = (parentTable: string, targetTable: string, pk: string, relationKey?: string): string => {
      validateIdentifier(parentTable, 'withCount (parent table)')
      validateIdentifier(targetTable, 'withCount (target table)')
      validateIdentifier(pk, 'withCount (primary key)')

      const resolved = relationKey && meta
        ? resolvePivot(meta as SchemaMeta, parentTable, relationKey, { singularize, models: (meta as SchemaMeta).models })
        : null
      const a = singularize(parentTable)
      const b = singularize(targetTable)
      const pivot = resolved?.pivotTable ?? [a, b].sort().join('_')
      const fkA = resolved?.fkParent ?? `${a}_id`

      validateIdentifier(pivot, 'withCount (pivot table)')
      validateIdentifier(fkA, 'withCount (foreign key)')

      return `(SELECT COUNT(*) FROM ${pivot} WHERE ${pivot}.${fkA} = ${parentTable}.${pk})`
    }

    // Add an aggregate of a related column as a correlated subquery column —
    // withSum/withAvg/withMax/withMin. Mirrors withCount but over a real column.
    // See stacksjs/bun-query-builder#1046.
    const applyRelationAggregate = (fn: 'SUM' | 'AVG' | 'MAX' | 'MIN', relation: string, column: string) => {
      if (!meta)
        return
      validateIdentifier(column, `with${fn[0]}${fn.slice(1).toLowerCase()} (column)`)
      const parentTable = String(table)
      const rels = meta.relations?.[parentTable]
      if (!rels)
        return
      const found = Object.entries(rels).find(([_t, relMap]) => relMap && typeof relMap === 'object' && relation in relMap)
      if (!found)
        return
      const [type, relMap] = found
      const entry = (relMap as any)[relation]
      const targetModel = typeof entry === 'string' ? entry : (entry?.model || entry?.target || entry)
      const targetTable = meta.modelToTable[targetModel] || targetModel
      const pk = meta.primaryKeys[parentTable] ?? 'id'
      validateIdentifier(targetTable, `with${fn} (target table)`)
      const aggExpr = `${fn}(${targetTable}.${column})`
      let sub: string
      if (type === 'hasMany' || type === 'hasOne') {
        const fk = `${parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable}_id`
        validateIdentifier(fk, `with${fn} (foreign key)`)
        sub = `(SELECT ${aggExpr} FROM ${targetTable} WHERE ${targetTable}.${fk} = ${parentTable}.${pk})`
      }
      else if (type === 'belongsToMany') {
        const resolved = meta
          ? resolvePivot(meta as SchemaMeta, parentTable, relation, { singularize, models: (meta as SchemaMeta).models })
          : null
        const a = singularize(parentTable)
        const b = singularize(targetTable)
        const pivot = resolved?.pivotTable ?? [a, b].sort().join('_')
        const fkA = resolved?.fkParent ?? `${a}_id`
        const fkB = resolved?.fkRelated ?? `${b}_id`
        const targetPk = meta.primaryKeys[targetTable] ?? 'id'
        validateIdentifier(pivot, `with${fn} (pivot table)`)
        validateIdentifier(fkA, `with${fn} (foreign key)`)
        validateIdentifier(fkB, `with${fn} (related key)`)
        sub = `(SELECT ${aggExpr} FROM ${pivot} JOIN ${targetTable} ON ${targetTable}.${targetPk} = ${pivot}.${fkB} WHERE ${pivot}.${fkA} = ${parentTable}.${pk})`
      }
      else {
        return
      }
      addToSelectClause(`${sub} AS ${relation}_${fn.toLowerCase()}_${column}`)
    }

    // Helper function to apply pivot columns to the query
    const applyPivotColumnsToQuery = () => {
      if (pivotColumns.size === 0)
        return

      const allPivotColumns: string[] = []

      for (const [relation, columns] of pivotColumns.entries()) {
        const resolved = resolvePivotLocal(relation)
        if (!resolved)
          continue

        // Validate each column name to prevent SQL injection
        for (const col of columns) {
          validateIdentifier(col, 'withPivot')
        }

        const pivotColumnsStr = columns.map(col => `${resolved.pivotTable}.${col} AS pivot_${col}`)
        allPivotColumns.push(...pivotColumnsStr)
      }

      if (allPivotColumns.length > 0) {
        const pivotColumnsStr = allPivotColumns.join(', ')
        addToSelectClause(pivotColumnsStr)
      }
    }

    // Build the base API; then wrap with a proxy that exposes dynamic where/orWhere/andWhere methods

    const base: BaseSelectQueryBuilder<DB, TTable, any, TTable> = {
      distinct() {
        text = text.replace(/^SELECT\s+/i, 'SELECT DISTINCT ')
        built = null
        return this as any
      },
      distinctOn(...columns: any[]) {
        const colList = columns.map(String).join(', ')
        text = text.replace(/^SELECT\s+/i, `SELECT DISTINCT ON (${colList}) `)
        built = null
        return this as any
      },
      selectRaw(fragment: any) {
        const frag = renderRawFragment(fragment, 'selectRaw(fragment)')
        // Insert raw fragment into SELECT list before FROM
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1) {
          text = `${text.substring(0, fromIdx)}, ${frag}${text.substring(fromIdx)}`
        }
        else {
          text += `, ${frag}`
        }
        built = null
        return this as any
      },
      rowNumber(alias = 'row_number', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const overParts: string[] = []
        if (partitionBy) {
          const cols = Array.isArray(partitionBy) ? partitionBy : [partitionBy]
          overParts.push(`PARTITION BY ${cols.join(', ')}`)
        }
        if (orderBy && orderBy.length)
          overParts.push(`ORDER BY ${orderBy.map(([c, d]) => `${c} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`)
        const overClause = overParts.length ? `OVER (${overParts.join(' ')})` : 'OVER ()'
        const windowExpr = `ROW_NUMBER() ${overClause} AS ${alias}`
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1)
          text = `${text.substring(0, fromIdx)}, ${windowExpr}${text.substring(fromIdx)}`
        else
          text += `, ${windowExpr}`
        built = null
        return this as any
      },
      denseRank(alias = 'dense_rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const overParts: string[] = []
        if (cols.length)
          overParts.push(`PARTITION BY ${cols.join(', ')}`)
        if (orderBy && orderBy.length)
          overParts.push(`ORDER BY ${orderBy.map(([c, d]) => `${c} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`)
        const overClause = overParts.length ? `OVER (${overParts.join(' ')})` : 'OVER ()'
        const windowExpr = `DENSE_RANK() ${overClause} AS ${alias}`
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1)
          text = `${text.substring(0, fromIdx)}, ${windowExpr}${text.substring(fromIdx)}`
        else
          text += `, ${windowExpr}`
        built = null
        return this as any
      },
      rank(alias = 'rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const overParts: string[] = []
        if (cols.length)
          overParts.push(`PARTITION BY ${cols.join(', ')}`)
        if (orderBy && orderBy.length)
          overParts.push(`ORDER BY ${orderBy.map(([c, d]) => `${c} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`)
        const overClause = overParts.length ? `OVER (${overParts.join(' ')})` : 'OVER ()'
        const windowExpr = `RANK() ${overClause} AS ${alias}`
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1)
          text = `${text.substring(0, fromIdx)}, ${windowExpr}${text.substring(fromIdx)}`
        else
          text += `, ${windowExpr}`
        built = null
        return this as any
      },
      // Generalized window functions (#1050). `over()` is the escape hatch for
      // any expression; the rest are conveniences. opts: { partitionBy, orderBy,
      // alias, offset (lag/lead) }.
      over(expression: string, alias: string, opts: WindowOpts = {}) {
        addWindowFunction(expression, alias, opts.partitionBy, opts.orderBy)
        return this as any
      },
      lag(column: string, opts: WindowOpts & { offset?: number, defaultValue?: string | number } = {}) {
        const args = [column, String(opts.offset ?? 1)]
        if (opts.defaultValue !== undefined)
          args.push(String(opts.defaultValue))
        addWindowFunction(`LAG(${args.join(', ')})`, opts.alias ?? `${column}_lag`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      lead(column: string, opts: WindowOpts & { offset?: number, defaultValue?: string | number } = {}) {
        const args = [column, String(opts.offset ?? 1)]
        if (opts.defaultValue !== undefined)
          args.push(String(opts.defaultValue))
        addWindowFunction(`LEAD(${args.join(', ')})`, opts.alias ?? `${column}_lead`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      sumOver(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`SUM(${column})`, opts.alias ?? `${column}_sum`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      avgOver(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`AVG(${column})`, opts.alias ?? `${column}_avg`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      countOver(column: string = '*', opts: WindowOpts = {}) {
        addWindowFunction(`COUNT(${column})`, opts.alias ?? 'count_over', opts.partitionBy, opts.orderBy)
        return this as any
      },
      minOver(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`MIN(${column})`, opts.alias ?? `${column}_min`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      maxOver(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`MAX(${column})`, opts.alias ?? `${column}_max`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      firstValue(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`FIRST_VALUE(${column})`, opts.alias ?? `${column}_first`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      lastValue(column: string, opts: WindowOpts = {}) {
        addWindowFunction(`LAST_VALUE(${column})`, opts.alias ?? `${column}_last`, opts.partitionBy, opts.orderBy)
        return this as any
      },
      selectAll() {
        return this as any
      },
      select(columns: string | SqlFragment | Array<string | SqlFragment>) {
        if (!columns)
          return this as any
        // Normalize the single-string form so `.select('col')` works at
        // parity with `.select(['col'])`. The internal compiler calls
        // `.join(', ')` unconditionally on the argument — without this
        // guard a bare string passes the `.length` check (strings carry
        // it) and then crashes on `.join` (only arrays do). Matches the
        // Kysely / Knex / Drizzle ergonomic where either shape works.
        // See https://github.com/stacksjs/bun-query-builder/issues/1012
        const cols = Array.isArray(columns) ? columns : [columns]
        if (cols.length === 0)
          return this as any
        // Unwrap SQL fragments (e.g. `sql`count(*) as c``) to their text so a
        // fragment object doesn't stringify to "[object Object]" through
        // `.join(', ')`. See stacksjs/bun-query-builder#1016.
        const rendered = cols.map(renderSelectColumn)
        // Preserve a DISTINCT / DISTINCT ON (...) modifier set by a prior
        // .distinct()/.distinctOn() call — rebuilding the SELECT list from
        // scratch otherwise silently dropped it, so `.distinct().select([...])`
        // returned duplicate rows.
        const distinctMatch = /^SELECT\s+(DISTINCT(?:\s+ON\s+\([^)]*\))?\s+)/i.exec(text)
        const distinctPrefix = distinctMatch ? distinctMatch[1] : ''
        // Replace SELECT * with SELECT specific columns, preserving FROM and JOINs
        const fromIndex = text.indexOf(' FROM ')
        if (fromIndex !== -1) {
          text = `SELECT ${distinctPrefix}${rendered.join(', ')}${text.substring(fromIndex)}`
        }
        else {
          text = `SELECT ${distinctPrefix}${rendered.join(', ')} FROM ${table}`
        }
        built = null
        return this as any
      },
      addSelect(...columns: Array<string | SqlFragment>) {
        if (!columns.length)
          return this as any
        const rendered = columns.map(renderSelectColumn)
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1) {
          text = `${text.substring(0, fromIdx)}, ${rendered.join(', ')}${text.substring(fromIdx)}`
        }
        else {
          text += `, ${rendered.join(', ')}`
        }
        built = null
        return this as any
      },
      with(...relations: (string | Record<string, (qb: any) => any> | ((qb: any) => any))[]) {
        // Null safety and validation
        if (!meta || !relations || relations.length === 0)
          return this as any

        // Filter out null/undefined/invalid values and normalize to array of objects
        const normalizedRelations: Array<{ name: string, callback?: (qb: any) => any }> = []

        for (const rel of relations) {
          if (!rel)
            continue

          if (typeof rel === 'string') {
            normalizedRelations.push({ name: rel })
          }
          else if (typeof rel === 'object' && !Array.isArray(rel)) {
            // Object notation: { posts: (qb) => qb.where(...) }
            for (const [name, callback] of Object.entries(rel)) {
              if (typeof callback === 'function') {
                normalizedRelations.push({ name, callback })
              }
              else {
                normalizedRelations.push({ name })
              }
            }
          }
        }

        if (normalizedRelations.length === 0)
          return this as any

        // Check max eager load limit
        const maxEagerLoad = config.relations.maxEagerLoad ?? 50
        if (normalizedRelations.length > maxEagerLoad) {
          throw new Error(`[query-builder] Too many relationships to eager load (${normalizedRelations.length}). Maximum allowed: ${maxEagerLoad}`)
        }

        const parentTable = String(table)
        const visitedTables = new Set<string>() // For cycle detection
        const loadedRelationships = new Set<string>() // Track loaded relationships
        const relationConditions = new Map<string, (qb: any) => any>() // Store conditions per relation

        const getAvailableRelations = (fromTable: string): string[] => {
          const rels = meta.relations?.[fromTable]
          if (!rels)
            return []
          return [
            ...Object.keys(rels.hasOne || {}),
            ...Object.keys(rels.hasMany || {}),
            ...Object.keys(rels.belongsTo || {}),
            ...Object.keys(rels.belongsToMany || {}),
            ...Object.keys(rels.hasOneThrough || {}),
            ...Object.keys(rels.hasManyThrough || {}),
            ...Object.keys(rels.morphOne || {}),
            ...Object.keys(rels.morphMany || {}),
            ...Object.keys(rels.morphToMany || {}),
            ...Object.keys(rels.morphedByMany || {}),
          ]
        }

        const addJoin = (fromTable: string, relationKey: string, depth: number = 0, condition?: (qb: any) => any) => {
          // Check max depth
          const maxDepth = config.relations.maxDepth ?? 10
          if (depth >= maxDepth) {
            throw new Error(`[query-builder] Maximum relationship depth (${maxDepth}) exceeded at '${relationKey}'. Consider using separate queries or increasing maxDepth.`)
          }

          const rels = meta.relations?.[fromTable]

          // If no relationships defined for this table, return early
          if (!rels) {
            return fromTable
          }

          // Helper to add soft delete check to JOIN
          const addSoftDeleteCheck = (table: string): string => {
            if (config.softDeletes?.enabled && config.softDeletes?.defaultFilter) {
              const softDeleteColumn = config.softDeletes.column || 'deleted_at'
              return ` AND ${table}.${softDeleteColumn} IS NULL`
            }
            return ''
          }

          // Build the ` AND (...)` suffix for a constraint callback passed to
          // `.with({ rel: qb => qb.where(...) })`. The client builder eager
          // loads via a flattening LEFT JOIN, so a constraint becomes part of
          // the JOIN ON clause — `LEFT JOIN posts ON posts.user_id = users.id
          // AND posts.published = 1` keeps every parent (LEFT) while joining
          // only matching children, which is exactly "load only published
          // posts". The previous code applied NONE of this (silent no-op,
          // despite being documented).
          //
          // Values are inline-escaped via formatSubqueryValue rather than
          // bound: the JOIN appears BEFORE the WHERE in the SQL, but `.with()`
          // may be chained AFTER `.where()`, so pushing to the positional
          // `whereParams` array would bind them in the wrong order. This is
          // the same approach the whereHas subquery builders use. Identifiers
          // and operators are still validated/allow-listed. orderBy/limit/
          // offset have no per-parent meaning in a flat join, so they throw
          // rather than silently drop.
          const buildJoinConstraint = (targetTbl: string): string => {
            if (!condition)
              return ''
            const frags: string[] = []
            const addCmp = (col: unknown, op: unknown, val: unknown): void => {
              validateIdentifier(String(col), 'with() constraint column')
              const operator = assertSafeWhereOperator(op, 'with() constraint operator')
              frags.push(`${targetTbl}.${String(col)} ${operator} ${formatSubqueryValue(val)}`)
            }
            const unsupported = (m: string) => () => {
              throw new Error(`[query-builder] with('${relationKey}', ...): ${m} is not supported inside a constraint callback on the JOIN-based builder — apply it to the outer query, or use the model layer's eager loading. (Silently ignoring it would return wrong data.)`)
            }
            const constraintQb: any = {
              where: (expr: any, op?: any, val?: any) => {
                if (Array.isArray(expr))
                  addCmp(expr[0], expr[1], expr[2])
                else if (expr && typeof expr === 'object')
                  for (const k of Object.keys(expr)) addCmp(k, '=', expr[k])
                else if (op !== undefined && val !== undefined)
                  addCmp(expr, op, val)
                else if (op !== undefined)
                  addCmp(expr, '=', op)
                return constraintQb
              },
              whereIn: (col: any, vals: any[]) => {
                validateIdentifier(String(col), 'with() constraint column')
                frags.push(`${targetTbl}.${String(col)} IN (${vals.map(formatSubqueryValue).join(', ')})`)
                return constraintQb
              },
              whereNull: (col: any) => {
                validateIdentifier(String(col), 'with() constraint column')
                frags.push(`${targetTbl}.${String(col)} IS NULL`)
                return constraintQb
              },
              whereNotNull: (col: any) => {
                validateIdentifier(String(col), 'with() constraint column')
                frags.push(`${targetTbl}.${String(col)} IS NOT NULL`)
                return constraintQb
              },
              orderBy: unsupported('orderBy()'),
              limit: unsupported('limit()'),
              offset: unsupported('offset()'),
              take: unsupported('take()'),
            }
            condition(constraintQb)
            return frags.length ? ` AND ${frags.join(' AND ')}` : ''
          }

          const resolveTarget = (): string | undefined => {
            const pick = (m?: Record<string, string>) => {
              const modelName = m?.[relationKey]
              return modelName ? meta.modelToTable[modelName] : undefined
            }
            const pickBtm = (m?: Record<string, string | { model: string }>) => {
              const entry = m?.[relationKey]
              const modelName = typeof entry === 'string' ? entry : entry?.model
              return modelName ? meta.modelToTable[modelName] : undefined
            }
            const pickThrough = (m?: Record<string, { through: string, target: string }>) => {
              const rel = m?.[relationKey]
              return rel?.target ? meta.modelToTable[rel.target] : undefined
            }
            return pick(rels?.hasOne) || pick(rels?.hasMany) || pick(rels?.belongsTo) || pickBtm(rels?.belongsToMany) || pickThrough(rels?.hasOneThrough) || pickThrough(rels?.hasManyThrough) || pick(rels?.morphOne) || pick(rels?.morphMany) || pick(rels?.morphToMany) || pick(rels?.morphedByMany)
          }

          // Resolve target table with fallback logic
          const targetTable = resolveTarget() ?? (meta.modelToTable[relationKey] || meta.tableToModel[relationKey] ? (meta.modelToTable[relationKey] ?? relationKey) : relationKey)
          const childTable = String(targetTable)

          // Validate relationship exists (only throw error if it's truly invalid)
          if (!targetTable || (!resolveTarget() && !meta.modelToTable[relationKey] && !meta.tableToModel[relationKey])) {
            const available = getAvailableRelations(fromTable)
            if (available.length > 0 && !available.includes(relationKey)) {
              const suggestion = ` Available relationships: ${available.join(', ')}`
              throw new Error(`[query-builder] Relationship '${relationKey}' not found on table '${fromTable}'.${suggestion}`)
            }
          }

          // Cycle detection
          if (config.relations.detectCycles !== false) {
            const cycleKey = `${fromTable}->${childTable}`
            if (visitedTables.has(cycleKey)) {
              throw new Error(`[query-builder] Circular relationship detected: ${cycleKey}. This would cause an infinite loop.`)
            }
            visitedTables.add(cycleKey)
          }

          if (!childTable || childTable === fromTable)
            return fromTable

          // hasOneThrough / hasManyThrough: access through intermediate table
          const throughRel = rels?.hasOneThrough?.[relationKey] || rels?.hasManyThrough?.[relationKey]
          if (throughRel) {
            const throughModel = throughRel.through
            const targetModel = throughRel.target
            const throughTable = meta.modelToTable[throughModel] || throughModel
            const finalTable = meta.modelToTable[targetModel] || targetModel
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const throughPk = meta.primaryKeys[throughTable] ?? 'id'
            const fkInThrough = `${singularize(fromTable)}_id`
            const fkInFinal = `${singularize(throughTable)}_id`
            // insertJoin maintains `text` directly (and nulls `built` so it
            // rebuilds from text) — the previous `built = sql\`...\`` + a
            // `text = computeSqlText(built)` resync produced "[object Promise]"
            // text on real drivers, whose query objects can't be stringified.
            insertJoin(`LEFT JOIN ${throughTable} ON ${throughTable}.${fkInThrough} = ${fromTable}.${fromPk} LEFT JOIN ${finalTable} ON ${finalTable}.${fkInFinal} = ${throughTable}.${throughPk}`)
            joinedTables.add(throughTable)
            joinedTables.add(finalTable)
            return finalTable
          }

          // belongsToMany: join through pivot
          const isBtm = Boolean(rels?.belongsToMany?.[relationKey])
          if (isBtm) {
            // Use the resolver so Option A/B `table:`/`through:`/`foreignKey:`/`relatedKey:` overrides apply.
            const resolved = resolvePivot(meta, fromTable, relationKey, { singularize, models: meta.models })
            const pivot = resolved?.pivotTable ?? [singularize(fromTable), singularize(childTable)].sort().join('_')
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            const fkA = resolved?.fkParent ?? `${singularize(fromTable)}_id`
            const fkB = resolved?.fkRelated ?? `${singularize(childTable)}_id`
            insertJoin(`LEFT JOIN ${pivot} ON ${pivot}.${fkA} = ${fromTable}.${fromPk} LEFT JOIN ${childTable} ON ${childTable}.${childPk} = ${pivot}.${fkB}${buildJoinConstraint(childTable)}`)

            joinedTables.add(pivot)
            joinedTables.add(childTable)
            return childTable
          }

          // morphToMany: polymorphic many-to-many through pivot
          const isMtm = Boolean(rels?.morphToMany?.[relationKey])
          if (isMtm) {
            const morphName = relationKey
            const pivotTable = `${singularize(childTable)}_${morphName}`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            const morphType = `${morphName}_type`
            const morphId = `${morphName}_id`
            const targetFk = `${singularize(childTable)}_id`
            const morphVal = formatSubqueryValue(meta.tableToModel[fromTable] || fromTable)
            insertJoin(`LEFT JOIN ${pivotTable} ON ${pivotTable}.${morphId} = ${fromTable}.${fromPk} AND ${pivotTable}.${morphType} = ${morphVal} LEFT JOIN ${childTable} ON ${childTable}.${childPk} = ${pivotTable}.${targetFk}`)
            joinedTables.add(pivotTable)
            joinedTables.add(childTable)
            return childTable
          }

          // morphedByMany: inverse of morphToMany
          const isMbm = Boolean(rels?.morphedByMany?.[relationKey])
          if (isMbm) {
            const relatedModel = rels.morphedByMany?.[relationKey] || relationKey
            const relatedTable = meta.modelToTable[relatedModel] || relatedModel
            const morphName = singularize(fromTable)
            const pivotTable = `${singularize(relatedTable)}_${morphName}`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const relatedPk = meta.primaryKeys[relatedTable] ?? 'id'
            const morphType = `${morphName}_type`
            const morphId = `${morphName}_id`
            const relatedFk = `${singularize(relatedTable)}_id`
            const morphVal = formatSubqueryValue(meta.tableToModel[relatedTable] || relatedTable)
            insertJoin(`LEFT JOIN ${pivotTable} ON ${pivotTable}.${relatedFk} = ${fromTable}.${fromPk} LEFT JOIN ${relatedTable} ON ${relatedTable}.${relatedPk} = ${pivotTable}.${morphId} AND ${pivotTable}.${morphType} = ${morphVal}`)
            joinedTables.add(pivotTable)
            joinedTables.add(relatedTable)
            return relatedTable
          }

          // belongsTo: parent has fk to child
          const isBt = Boolean(rels?.belongsTo?.[relationKey])
          if (isBt) {
            const fkInParent = `${singularize(childTable)}_id`
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            insertJoin(`LEFT JOIN ${childTable} ON ${fromTable}.${fkInParent} = ${childTable}.${childPk}${buildJoinConstraint(childTable)}`)
            joinedTables.add(childTable)
            return childTable
          }

          // morphOne / morphMany: polymorphic one/many
          const isMorphOne = Boolean(rels?.morphOne?.[relationKey])
          const isMorphMany = Boolean(rels?.morphMany?.[relationKey])
          if (isMorphOne || isMorphMany) {
            const morphType = `${relationKey}_type`
            const morphId = `${relationKey}_id`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const morphVal = formatSubqueryValue(meta.tableToModel[fromTable] || fromTable)
            insertJoin(`LEFT JOIN ${childTable} ON ${childTable}.${morphId} = ${fromTable}.${fromPk} AND ${childTable}.${morphType} = ${morphVal}`)
            joinedTables.add(childTable)
            return childTable
          }

          // hasOne/hasMany: child has fk to parent
          const fkInChild = `${singularize(fromTable)}_id`
          const pk = meta.primaryKeys[fromTable] ?? 'id'
          const extraOn = `${addSoftDeleteCheck(childTable)}${buildJoinConstraint(childTable)}`
          insertJoin(`LEFT JOIN ${childTable} ON ${childTable}.${fkInChild} = ${fromTable}.${pk}${extraOn}`)
          joinedTables.add(childTable)
          return childTable
        }

        for (const rel of normalizedRelations) {
          const relationName = rel.name.trim()

          // Store callback for later use
          if (rel.callback) {
            relationConditions.set(relationName, rel.callback)
          }

          // Safely split the relationship path
          const parts = relationName.split('.')
          let from = parentTable
          let currentDepth = 0

          for (const part of parts) {
            if (!part || part.trim().length === 0)
              continue // Skip empty parts
            const trimmedPart = part.trim()

            // For conditional loading, we need to add WHERE conditions to the JOIN
            const condition = relationConditions.get(trimmedPart)
            const next = addJoin(from, trimmedPart, currentDepth, condition) || from
            from = next
            currentDepth++
          }

          // Track loaded relationship
          loadedRelationships.add(relationName)
        }

        // Apply pivot columns if any were requested
        if (pivotColumns.size > 0) {
          const allPivotColumns: string[] = []

          for (const [relation, columns] of pivotColumns.entries()) {
            const resolved = resolvePivotLocal(relation)
            if (!resolved)
              continue
            const pivotColumnsStr = columns.map(col => `${resolved.pivotTable}.${col} AS pivot_${col}`)
            allPivotColumns.push(...pivotColumnsStr)
          }

          if (allPivotColumns.length > 0) {
            const pivotColumnsStr = allPivotColumns.join(', ')
            addToSelectClause(pivotColumnsStr)
          }
        }

        // `text` is maintained directly by insertJoin() / addToSelectClause()
        // above. We no longer resync via computeSqlText(ensureBuilt()) — real
        // driver query objects stringify to "[object Promise]", which used to
        // corrupt `text` (and thus toSQL() and the prepared-statement fast
        // path) for every .with() on a non-mock connection.
        built = null

        return this as any
      },
      /**
       * Query records that have a specific relationship with optional conditions
       */
      whereHas(relation: string, callback?: (qb: any) => any) {
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels) {
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)
        }

        // Find the relationship
        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )

        if (!relType) {
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)
        }

        const [type, relMap] = relType
        const _entry = (relMap as any)[relation]
        const targetModel = typeof _entry === 'string' ? _entry : (_entry?.model || _entry?.target || _entry)
        const targetTable = meta.modelToTable[targetModel] || targetModel

        // Build raw SQL for EXISTS clause since we can't use sql in a cross-compatible way
        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, callback, relation)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for whereHas`)
        }

        // The record of truth is the term list; ensureBuilt() renders from it.
        // This used to ALSO assign `built = sql`${ensureBuilt()} WHERE ...``, a
        // parallel representation carrying an unconditional WHERE keyword. See #1083.
        addWhereText('WHERE', `EXISTS (${subquerySQL})`)

        return this as any
      },
      /**
       * Query records that don't have a specific relationship
       */
      whereDoesntHave(relation: string, callback?: (qb: any) => any) {
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels) {
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)
        }

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )

        if (!relType) {
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)
        }

        const [type, relMap] = relType
        const _entry = (relMap as any)[relation]
        const targetModel = typeof _entry === 'string' ? _entry : (_entry?.model || _entry?.target || _entry)
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, callback, relation)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for whereDoesntHave`)
        }

        // See the note in whereHas: the term list is the single record.
        addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)

        return this as any
      },
      /**
       * Shorthand for whereHas - filter records that have a relationship
       */
      has(relation: string) {
        // Inline implementation to avoid TypeScript `this` issues
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels)
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )
        if (!relType)
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)

        const [type, relMap] = relType
        const _entry = (relMap as any)[relation]
        const targetModel = typeof _entry === 'string' ? _entry : (_entry?.model || _entry?.target || _entry)
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, undefined, relation)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for has`)
        }

        // The record of truth is the term list; ensureBuilt() renders from it.
        // This used to ALSO assign `built = sql`${ensureBuilt()} WHERE ...``, a
        // parallel representation carrying an unconditional WHERE keyword. See #1083.
        addWhereText('WHERE', `EXISTS (${subquerySQL})`)

        return this as any
      },
      /**
       * Shorthand for whereDoesntHave - filter records that don't have a relationship
       */
      doesntHave(relation: string) {
        // Inline implementation to avoid TypeScript `this` issues
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels)
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )
        if (!relType)
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)

        const [type, relMap] = relType
        const _entry = (relMap as any)[relation]
        const targetModel = typeof _entry === 'string' ? _entry : (_entry?.model || _entry?.target || _entry)
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, undefined, relation)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for doesntHave`)
        }

        // See the note in whereHas: the term list is the single record.
        addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)

        return this as any
      },
      /**
       * Load relationship counts as aggregate columns
       */
      withCount(...relations: string[]) {
        if (!meta || !relations || relations.length === 0)
          return this as any

        const parentTable = String(table)

        for (const relation of relations) {
          const rels = meta.relations?.[parentTable]
          if (!rels)
            continue

          const relType = Object.entries(rels).find(([_type, relMap]) =>
            relMap && typeof relMap === 'object' && relation in relMap,
          )

          if (!relType)
            continue

          const [type, relMap] = relType
          const _entry = (relMap as any)[relation]
          const targetModel = typeof _entry === 'string' ? _entry : (_entry?.model || _entry?.target || _entry)
          const targetTable = meta.modelToTable[targetModel] || targetModel

          const pk = meta.primaryKeys[parentTable] ?? 'id'
          let countSubquery: string

          if (type === 'hasMany' || type === 'hasOne') {
            countSubquery = buildHasCountSubquery(parentTable, targetTable, pk)
          }
          else if (type === 'belongsToMany') {
            countSubquery = buildBelongsToManyCountSubquery(parentTable, targetTable, pk, relation)
          }
          else {
            continue // Skip unsupported relationship types
          }

          const alias = `${relation}_count`
          addToSelectClause(`${countSubquery} AS ${alias}`)
        }

        return this as any
      },
      // Aggregate a related column as a correlated subquery (#1046). Result
      // column is aliased `${relation}_${fn}_${column}`, e.g. `posts_sum_views`.
      withSum(relation: string, column: string) {
        applyRelationAggregate('SUM', relation, column)
        return this as any
      },
      withAvg(relation: string, column: string) {
        applyRelationAggregate('AVG', relation, column)
        return this as any
      },
      withMax(relation: string, column: string) {
        applyRelationAggregate('MAX', relation, column)
        return this as any
      },
      withMin(relation: string, column: string) {
        applyRelationAggregate('MIN', relation, column)
        return this as any
      },
      /**
       * Apply pivot columns to the SELECT clause
       */
      applyPivotColumns() {
        applyPivotColumnsToQuery()
        return this as any
      },
      /**
       * Include pivot table columns when eager loading belongsToMany relationships
       * Usage: .with('tags').withPivot('tags', 'created_at', 'role')
       *
       * When the relation uses the new BelongsToManyConfig form (Option A or
       * Option B), result rows nest aliases under `row.pivot.<col>`. Legacy
       * string-form relations keep emitting flat `pivot_<col>` keys.
       */
      withPivot(relation: string, ...columns: string[]) {
        if (!meta)
          return this as any

        const parentTable = String(table)
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${parentTable}'`)
        }

        // Default to all declared pivot columns when caller doesn't enumerate
        // any. Only fires for the new config form, since the legacy form has
        // no declared column list.
        const cols = columns && columns.length > 0
          ? columns
          : (resolved.hasConfig ? resolved.pivotColumns : [])
        if (cols.length === 0)
          return this as any

        // Store pivot columns for this relationship
        pivotColumns.set(relation, cols)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)

        // Apply pivot columns to the current query
        applyPivotColumnsToQuery()

        return this as any
      },
      /**
       * Filter a `belongsToMany` query by a pivot-table column. Auto-joins
       * the pivot table when not already joined.
       *
       * Two-arg form (`= ?`): `.wherePivot('athletes', 'role', 'primary')`
       * Three-arg form: `.wherePivot('athletes', 'status', '!=', 'archived')`
       */
      wherePivot(relation: string, column: string, opOrValue: any, value?: any) {
        if (!meta)
          return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivot (pivot table)')
        validateIdentifier(column, 'wherePivot (column)')
        ensurePivotJoined(resolved)

        const op = value === undefined ? '=' : String(opOrValue)
        const val = value === undefined ? opOrValue : value
        const paramIndex = whereParams.length + 1
        const clause = `${resolved.pivotTable}.${column} ${op} ${getPlaceholder(paramIndex)}`
        whereParams.push(val)
        pushWhere('AND', clause)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      wherePivotIn(relation: string, column: string, values: any[]) {
        if (!meta || !Array.isArray(values))
          return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivotIn (pivot table)')
        validateIdentifier(column, 'wherePivotIn (column)')
        ensurePivotJoined(resolved)

        // An empty list is FALSE, not absent: `return this` here dropped the
        // predicate and widened the query to every row it existed to exclude.
        // `wherePivotNotIn([])` keeps its no-op below — non-membership in the
        // empty set is TRUE, so dropping the term there is correct. See #1083.
        const placeholders = getPlaceholders(values.length, whereParams.length + 1)
        const clause = renderInPredicate(`${resolved.pivotTable}.${column}`, values, false, placeholders)
        whereParams.push(...values)
        pushWhere('AND', clause)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      wherePivotNotIn(relation: string, column: string, values: any[]) {
        if (!meta || !Array.isArray(values) || values.length === 0)
          return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivotNotIn (pivot table)')
        validateIdentifier(column, 'wherePivotNotIn (column)')
        ensurePivotJoined(resolved)

        const placeholders = getPlaceholders(values.length, whereParams.length + 1)
        const clause = `${resolved.pivotTable}.${column} NOT IN (${placeholders})`
        whereParams.push(...values)
        pushWhere('AND', clause)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      wherePivotNull(relation: string, column: string) {
        if (!meta) return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivotNull (pivot table)')
        validateIdentifier(column, 'wherePivotNull (column)')
        ensurePivotJoined(resolved)
        pushWhere('AND', `${resolved.pivotTable}.${column} IS NULL`)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      wherePivotNotNull(relation: string, column: string) {
        if (!meta) return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivotNotNull (pivot table)')
        validateIdentifier(column, 'wherePivotNotNull (column)')
        ensurePivotJoined(resolved)
        pushWhere('AND', `${resolved.pivotTable}.${column} IS NOT NULL`)
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      where(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          // Boundary validation: the column and operator are interpolated
          // into SQL text (values stay parameterized). Compile-time types
          // constrain both, but `as any` casts and dynamically-built strings
          // bypass them — reject anything outside a (qualified) identifier
          // and the operator allow-list. Mirrors applyCondition().
          validateIdentifier(String(expr), 'where(column)')
          assertSafeWhereOperator(op, 'where(operator)')
          const operator = String(op).toLowerCase()
          // Keep `.where('col', 'in', vals)` at parity with the
          // array form (`.where(['col', 'in', vals])`, line ~3596).
          // Without this branch, IN-with-string-form emits a single
          // placeholder (`col IN ?`) and SQLite rejects it. See
          // https://github.com/stacksjs/bun-query-builder/issues/1013
          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(value) ? value : [value]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            const clause = renderInPredicate(quoteColumnForDialect(String(expr)), values, operator === 'not in', placeholders)
            whereParams.push(...values)
            pushWhere('AND', clause)
            return this
          }
          const paramIndex = whereParams.length + 1
          whereParams.push(value)
          pushWhere('AND', `${quoteColumnForDialect(String(expr))} ${String(op)} ${getPlaceholder(paramIndex)}`)
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          validateIdentifier(colName, 'where(column)')
          const operator = assertSafeWhereOperator(op, 'where(operator)')

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            const clause = renderInPredicate(quoteColumnForDialect(colName), values, operator === 'not in', placeholders)
            whereParams.push(...values)
            pushWhere('AND', clause)
          }
          else {
            const paramIndex = whereParams.length + 1
            whereParams.push(val)
            pushWhere('AND', `${quoteColumnForDialect(colName)} ${operator} ${getPlaceholder(paramIndex)}`)
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !isRawExpression(expr)) {
          const whereObject = expr as Record<string, unknown>
          const keys = Object.keys(whereObject)
          const conditions: string[] = []

          for (const key of keys) {
            validateIdentifier(key, 'where(column)')
            const value = whereObject[key]
            if (Array.isArray(value)) {
              const placeholders = getPlaceholders(value.length, whereParams.length + 1)
              conditions.push(renderInPredicate(quoteColumnForDialect(key), value, false, placeholders))
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${quoteColumnForDialect(key)} = ${getPlaceholder(paramIndex)}`)
              whereParams.push(value)
            }
          }

          // One term, not one per key: an object literal is a single
          // conjunction, so a later `.orWhere(z)` must OR against the whole of
          // it rather than against its last key.
          if (conditions.length > 0)
            pushWhere('AND', conditions.length > 1 ? `(${conditions.join(' AND ')})` : conditions[0])
          return this
        }

        // Handle raw expressions
        if (isRawExpression(expr)) {
          pushWhere('AND', expr.raw)
          return this
        }

        // Anything else used to fall through to `return this`, which is the
        // worst thing a filter can do: the builder came back unchanged, the
        // query ran, and it matched every row the filter was meant to exclude.
        // A `where` that fails open is a data leak in any application where the
        // filter is the access check, and nothing anywhere says it happened.
        //
        // The callback form is the one people actually write, because it is how
        // Kysely and Knex express a group, and docs/guide/where.md has shown it
        // for longer than the builder has rejected it. It is now a real group —
        // see addWhereGroup, which still throws if the callback adds nothing, so
        // the fails-closed guarantee is unchanged.
        if (typeof expr === 'function') {
          addWhereGroup('AND', expr)
          return this
        }

        if (expr === undefined || expr === null) {
          throw new TypeError('where() was called with no condition.')
        }

        if (typeof expr === 'string') {
          throw new TypeError(
            `where(${JSON.stringify(expr)}) is missing an operator and a value. Pass `
            + 'where(column, operator, value), or whereRaw() for a raw fragment.',
          )
        }

        throw new TypeError(`where() does not understand a condition of type ${typeof expr}.`)
      },
      // where helpers
      whereNull(column: string) {
        validateIdentifier(String(column), 'whereNull(column)')
        pushWhere('AND', `${String(column)} IS NULL`)
        return this
      },
      whereNotNull(column: string) {
        validateIdentifier(String(column), 'whereNotNull(column)')
        pushWhere('AND', `${String(column)} IS NOT NULL`)
        return this
      },
      orWhereNull(column: string) {
        validateIdentifier(String(column), 'orWhereNull(column)')
        pushWhere('OR', `${String(column)} IS NULL`)
        return this as any
      },
      orWhereNotNull(column: string) {
        validateIdentifier(String(column), 'orWhereNotNull(column)')
        pushWhere('OR', `${String(column)} IS NOT NULL`)
        return this as any
      },
      whereBetween(column: string, start: any, end: any) {
        validateIdentifier(String(column), 'whereBetween(column)')
        // Dialect-aware placeholders: Postgres needs `$n`, not `?` (#1027).
        const i = whereParams.length + 1
        whereParams.push(start, end)
        pushWhere('AND', `${String(column)} BETWEEN ${getPlaceholder(i)} AND ${getPlaceholder(i + 1)}`)
        return this
      },
      orWhereBetween(column: string, start: any, end: any) {
        validateIdentifier(String(column), 'orWhereBetween(column)')
        const i = whereParams.length + 1
        whereParams.push(start, end)
        pushWhere('OR', `${String(column)} BETWEEN ${getPlaceholder(i)} AND ${getPlaceholder(i + 1)}`)
        return this as any
      },
      whereExists(subquery: { toSQL: () => any }) {
        pushWhere('AND', `EXISTS (${subquery.toSQL()})`)
        return this
      },
      orWhereExists(subquery: { toSQL: () => any }) {
        pushWhere('OR', `EXISTS (${subquery.toSQL()})`)
        return this as any
      },
      /**
       * A parenthesised group of conditions.
       *
       * This is the escape hatch for `(a AND b) OR c` — the shape that chaining
       * alone can no longer express now that a chained `orWhere` groups with the
       * term before it. See renderWhereTerms and #1083.
       */
      whereGroup(cb: (b: any) => unknown) {
        addWhereGroup('AND', cb)
        return this as any
      },
      orWhereGroup(cb: (b: any) => unknown) {
        addWhereGroup('OR', cb)
        return this as any
      },
      /** Internal: the rendered WHERE body and its params, harvested by whereGroup(). */
      __whereState() {
        return { body: renderWhereTerms(whereTerms), params: [...whereParams] }
      },
      whereJsonContains(column: string, json: unknown) {
        // Dialect-aware JSON containment. Previously hardcoded Postgres `@>`,
        // which is a syntax error on MySQL/SQLite and ignored the configured
        // `jsonContainsMode`. See stacksjs/bun-query-builder#1026.
        validateIdentifier(String(column), 'whereJsonContains(column)')
        const dialect = config.dialect
        const idx = whereParams.length + 1
        if (dialect === 'postgres') {
          // Bind the document itself, NOT `JSON.stringify(document)`. Bun's
          // driver already JSON-encodes a value bound to a jsonb parameter, so
          // stringifying first encoded it twice and Postgres received the jsonb
          // *string* `"[\"bun\"]"` where the array `["bun"]` was meant. A jsonb
          // string never `@>`-contains anything, so the predicate was vacuously
          // false and every call returned zero rows, silently. See #1091.
          //
          // That encoding covers objects, arrays and strings. Numbers and
          // booleans are bound as int4/bool instead, which `@>` has no operator
          // for (`operator does not exist: jsonb @> integer`), so those are
          // lifted to a jsonb scalar with to_jsonb().
          const needsJsonbLift = typeof json === 'number' || typeof json === 'boolean'
          const operand = needsJsonbLift
            ? `to_jsonb(${getPlaceholder(idx)})`
            : getPlaceholder(idx)
          // operator (`@>`, default) or function (`jsonb_contains`) per config.
          if (config.sql?.jsonContainsMode === 'function')
            pushWhere('AND', `jsonb_contains(${column}, ${operand})`)
          else
            pushWhere('AND', `${column} @> ${operand}`)
          whereParams.push(json)
        }
        else if (isMysqlLike(dialect)) {
          pushWhere('AND', `JSON_CONTAINS(${column}, ${getPlaceholder(idx)})`)
          whereParams.push(JSON.stringify(json))
        }
        else {
          // SQLite has no native JSON containment. Use json_each membership,
          // which covers the common "array contains value(s)" case
          // (`whereJsonContains('tags', ['bun'])`). For an array, every listed
          // value must be present.
          if (Array.isArray(json)) {
            const conds = json.map((_, i) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${getPlaceholder(idx + i)})`)
            pushWhere('AND', `(${conds.join(' AND ')})`)
            for (const v of json) whereParams.push(v as any)
          }
          else if (json !== null && typeof json === 'object') {
            throw new Error('[query-builder] whereJsonContains: object containment is not supported on SQLite — pass a scalar or array, or use whereJsonPath.')
          }
          else {
            pushWhere('AND', `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${getPlaceholder(idx)})`)
            whereParams.push(json as any)
          }
        }
        return this as any
      },
      whereJsonPath(path: string, op: WhereOperator, value: any) {
        // Validate operator (Q-5 from stacksjs/stacks#1858).
        assertSafeWhereOperator(op, 'whereJsonPath(op)')
        // Validate path shape — JSON paths can include dots, brackets,
        // single quotes (for keys), and `$`/`->`/`->>` per dialect.
        // We allow that set but reject anything that could break out
        // of the path (`;`, double quotes, parentheses, etc).
        if (typeof path !== 'string' || path.length === 0 || path.length > 256)
          throw new TypeError(`[query-builder] whereJsonPath(path): expected non-empty string up to 256 chars, got ${typeof path === 'string' ? `'${path.slice(0, 32)}...'` : typeof path}`)
        // Allow: A-Z, a-z, 0-9, _, ., [, ], $, ', -, >, *  (the chars
        // needed by Postgres `col->'a'->>'b'`, MySQL/SQLite `col, '$.path[0]'`).
        // Reject: ;, ", (, ), spaces, anything else.
        if (!/^[A-Za-z0-9_.[\]$'\->* ,]+$/.test(path))
          throw new TypeError(`[query-builder] whereJsonPath(path): refusing to use '${path}' — contains characters outside the allowed JSON-path set`)

        const dialect = config.dialect
        const idx = whereParams.length + 1
        if (dialect === 'postgres')
          pushWhere('AND', `${path} ${op} ${getPlaceholder(idx)}`)
        else if (isMysqlLike(dialect))
          pushWhere('AND', `JSON_EXTRACT(${path}) ${op} ${getPlaceholder(idx)}`)
        else
          pushWhere('AND', `json_extract(${path}) ${op} ${getPlaceholder(idx)}`)
        whereParams.push(value)
        return this as any
      },
      // The LIKE/ILIKE family records the clause in `text` + `whereParams`
      // (dialect-aware placeholder) and invalidates `built` so the next
      // ensureBuilt() rebuilds from text. The previous version ALSO built a
      // `sql\`${ensureBuilt()} WHERE ...\`` tagged-template directly with an
      // UNCONDITIONAL `WHERE`/`OR`, so chaining after an existing WHERE emitted
      // a second `WHERE` (invalid SQL). addWhereText() now picks the right
      // connector; building from text keeps the two representations in sync.
      // See stacksjs/bun-query-builder#1028.
      whereLike(column: string, pattern: string, caseSensitive = false) {
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      whereILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres')
          addWhereText('WHERE', `${String(column)} ILIKE ${ph}`)
        else
          addWhereText('WHERE', `LOWER(${String(column)}) LIKE LOWER(${ph})`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      orWhereLike(column: string, pattern: string, caseSensitive = false) {
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      orWhereILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres')
          addWhereText('OR', `${String(column)} ILIKE ${ph}`)
        else
          addWhereText('OR', `LOWER(${String(column)}) LIKE LOWER(${ph})`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      whereNotLike(column: string, pattern: string, caseSensitive = false) {
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      whereNotILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres')
          addWhereText('WHERE', `${String(column)} NOT ILIKE ${ph}`)
        else
          addWhereText('WHERE', `LOWER(${String(column)}) NOT LIKE LOWER(${ph})`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      orWhereNotLike(column: string, pattern: string, caseSensitive = false) {
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      orWhereNotILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres')
          addWhereText('OR', `${String(column)} NOT ILIKE ${ph}`)
        else
          addWhereText('OR', `LOWER(${String(column)}) NOT LIKE LOWER(${ph})`)
        whereParams.push(pattern)
        built = null
        return this as any
      },
      whereAny(cols: string[], op: WhereOperator, value: any) {
        // An empty disjunction is FALSE, not absent. Returning `this` emitted
        // the identity of the wrong connective, so a `.filter()` that removed
        // every column WIDENED the query to all the rows it existed to
        // exclude — silently, and in the dangerous direction.
        //
        // `whereAll([])` and `whereNone([])` keep their no-op just below,
        // because TRUE genuinely is their identity. The asymmetry is the point,
        // not an inconsistency to tidy up.
        if (cols.length === 0) {
          pushWhere('AND', `(${FALSE_PREDICATE})`)
          return this as any
        }
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        pushWhere('AND', `(${conds.join(' OR ')})`)
        return this as any
      },
      whereAll(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0) return this as any
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        pushWhere('AND', `(${conds.join(' AND ')})`)
        return this as any
      },
      whereNone(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0) return this as any
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        pushWhere('AND', `NOT (${conds.join(' OR ')})`)
        return this as any
      },
      whereNotBetween(column: string, start: any, end: any) {
        validateIdentifier(String(column), 'whereNotBetween(column)')
        const i = whereParams.length + 1
        whereParams.push(start, end)
        pushWhere('AND', `${column} NOT BETWEEN ${getPlaceholder(i)} AND ${getPlaceholder(i + 1)}`)
        return this as any
      },
      whereDate(column: string, op: WhereOperator, date: string | Date) {
        validateIdentifier(column, 'whereDate(column)')
        // Date objects need ISO format — `String(new Date())` produces
        // `'Tue May 21 2026 ...'` which Postgres/MySQL silently reject
        // as a date comparison. ISO yields a value the DB driver can
        // parse on every dialect. See stacksjs/stacks#1862 #29.
        const dateString = date instanceof Date
          ? date.toISOString()
          : typeof date === 'string'
            ? date
            : (() => { throw new TypeError(`[query-builder] whereDate(date): expected string or Date, got ${typeof date}`) })()
        const idx = whereParams.length + 1
        whereParams.push(dateString)
        pushWhere('AND', `${column} ${op} ${getPlaceholder(idx)}`)
        return this as any
      },
      // A raw fragment is ONE term and is deliberately not auto-parenthesised —
      // wrapping would churn emitted SQL for no correctness gain. A fragment
      // containing a top-level OR must bracket itself; see docs/guide/where.md.
      whereRaw(fragment: any) {
        pushWhere('AND', renderRawFragment(fragment, 'whereRaw(fragment)'))
        return this as any
      },
      orWhereRaw(fragment: any) {
        pushWhere('OR', renderRawFragment(fragment, 'orWhereRaw(fragment)'))
        return this as any
      },
      whereColumn(left: string, op: WhereOperator, right: string) {
        validateIdentifier(left, 'whereColumn(left)')
        validateIdentifier(right, 'whereColumn(right)')
        pushWhere('AND', `${left} ${op} ${right}`)
        return this as any
      },
      orWhereColumn(left: string, op: WhereOperator, right: string) {
        validateIdentifier(left, 'orWhereColumn(left)')
        validateIdentifier(right, 'orWhereColumn(right)')
        pushWhere('OR', `${left} ${op} ${right}`)
        return this as any
      },
      whereIn(column: string, values: any[] | { toSQL: () => any }) {
        validateIdentifier(String(column), 'whereIn(column)')
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          const clause = renderInPredicate(column, values, false, placeholders)
          whereParams.push(...values)
          pushWhere('AND', clause)
        }
        else {
          pushWhere('AND', `${column} IN (${String((values as any).toSQL())})`)
        }
        return this as any
      },
      orWhereIn(column: string, values: any[] | { toSQL: () => any }) {
        validateIdentifier(String(column), 'orWhereIn(column)')
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          const clause = renderInPredicate(column, values, false, placeholders)
          whereParams.push(...values)
          pushWhere('OR', clause)
        }
        else {
          pushWhere('OR', `${column} IN (${String((values as any).toSQL())})`)
        }
        return this as any
      },
      whereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        validateIdentifier(String(column), 'whereNotIn(column)')
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          const clause = renderInPredicate(column, values, true, placeholders)
          whereParams.push(...values)
          pushWhere('AND', clause)
        }
        else {
          pushWhere('AND', `${column} NOT IN (${String((values as any).toSQL())})`)
        }
        return this as any
      },
      orWhereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        validateIdentifier(String(column), 'orWhereNotIn(column)')
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          const clause = renderInPredicate(column, values, true, placeholders)
          whereParams.push(...values)
          pushWhere('OR', clause)
        }
        else {
          pushWhere('OR', `${column} NOT IN (${String((values as any).toSQL())})`)
        }
        return this as any
      },
      whereNested(fragment: any) {
        const inner = fragment.toSQL ? String(fragment.toSQL()) : String(fragment)
        pushWhere('AND', `(${inner})`)
        return this as any
      },
      orWhereNested(fragment: any) {
        const inner = fragment.toSQL ? String(fragment.toSQL()) : String(fragment)
        pushWhere('OR', `(${inner})`)
        return this as any
      },
      andWhere(expr: any, op?: WhereOperator, value?: any) {
        return addBooleanWhere(this, 'AND', 'andWhere', expr, op, value)
      },
      orWhere(expr: any, op?: WhereOperator, value?: any) {
        return addBooleanWhere(this, 'OR', 'orWhere', expr, op, value)
      },
      orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
        // Compose-aware: detect an existing ORDER BY clause and append the
        // new column with a comma instead of emitting a second `ORDER BY`,
        // which is invalid SQL. Without this fix, calling .orderBy() twice
        // produced `ORDER BY a ASC ORDER BY b ASC` and SQLite/MySQL/Postgres
        // all rejected it.
        const dir = direction === 'asc' ? 'ASC' : 'DESC'
        // Quoted for the same reason a select list is: `ORDER BY key ASC` is a
        // syntax error on MySQL, `key` being reserved there.
        const ordered = quoteColumnForDialect(String(column))
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${ordered} ${dir}`
          : `${text} ORDER BY ${ordered} ${dir}`
        built = null
        return this
      },
      orderByDesc(column: string) {
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${column} DESC`
          : `${text} ORDER BY ${column} DESC`
        built = null
        return this as any
      },
      inRandomOrder() {
        const rnd = config.sql.randomFunction === 'RAND()' ? 'RAND()' : 'RANDOM()'
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${rnd}`
          : `${text} ORDER BY ${rnd}`
        built = null
        return this as any
      },
      reorder(column: string, direction: 'asc' | 'desc' = 'asc') {
        text = text.replace(/ORDER BY[\s\S]*$/i, '')
        text += ` ORDER BY ${column} ${direction === 'asc' ? 'ASC' : 'DESC'}`
        built = null
        return this as any
      },
      latest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${col} DESC`
          : `${text} ORDER BY ${col} DESC`
        built = null
        return this as any
      },
      oldest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${col} ASC`
          : `${text} ORDER BY ${col} ASC`
        built = null
        return this as any
      },
      limit(n: number) {
        // Validate at runtime — TypeScript typed `n` as `number`, but
        // `Number(req.query.limit)` is the typical caller and produces
        // `NaN` for non-numeric input. Pre-fix, `LIMIT NaN` shipped
        // straight to the driver. See stacksjs/stacks#1862 #25.
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
          throw new TypeError(`[bun-query-builder] limit(n): expected non-negative integer, got ${n}`)
        // Calling limit() twice would produce `LIMIT 5 LIMIT 10` — invalid
        // SQL. Replace any existing clause so the most recent call wins,
        // matching Laravel/Eloquent semantics.
        text = SQL_PATTERNS.LIMIT.test(text)
          ? text.replace(SQL_PATTERNS.LIMIT, ` LIMIT ${n}`)
          : `${text} LIMIT ${n}`
        built = null
        return this
      },
      offset(n: number) {
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
          throw new TypeError(`[bun-query-builder] offset(n): expected non-negative integer, got ${n}`)
        text = SQL_PATTERNS.OFFSET.test(text)
          ? text.replace(SQL_PATTERNS.OFFSET, ` OFFSET ${n}`)
          : `${text} OFFSET ${n}`
        built = null
        return this
      },
      join(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        // Same boundary validation as joinSub: identifiers and the operator
        // are interpolated into SQL text, so reject anything that isn't a
        // plain (optionally table-qualified) identifier or allow-listed
        // operator. Compile-time types already constrain these; this guards
        // the `as any` / dynamic-string escape hatch.
        validateIdentifier(table2, 'join(table)')
        validateQualifiedIdentifier(onLeft, 'join(onLeft)')
        validateQualifiedIdentifier(onRight, 'join(onRight)')
        assertSafeWhereOperator(operator, 'join(operator)')
        insertJoin(`JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      joinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        // Alias goes into the SQL as a bare identifier; validate it
        // strictly. The ON columns are typically table-qualified
        // (`users.id`) so the strict identifier regex rejects them —
        // they're traditionally dev-controlled (literals in code), so
        // we accept them via `validateQualifiedIdentifier` which
        // allows one optional `table.` prefix. See
        // stacksjs/stacks#1858 #20.
        validateIdentifier(alias, 'joinSub(alias)')
        validateQualifiedIdentifier(onLeft, 'joinSub(onLeft)')
        validateQualifiedIdentifier(onRight, 'joinSub(onRight)')
        assertSafeWhereOperator(operator, 'joinSub(operator)')
        insertJoin(`JOIN (${String(sub.toSQL())}) AS ${alias} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(alias)
        return this as any
      },
      innerJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        validateIdentifier(table2, 'innerJoin(table)')
        validateQualifiedIdentifier(onLeft, 'innerJoin(onLeft)')
        validateQualifiedIdentifier(onRight, 'innerJoin(onRight)')
        assertSafeWhereOperator(operator, 'innerJoin(operator)')
        insertJoin(`INNER JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      leftJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        validateIdentifier(table2, 'leftJoin(table)')
        validateQualifiedIdentifier(onLeft, 'leftJoin(onLeft)')
        validateQualifiedIdentifier(onRight, 'leftJoin(onRight)')
        assertSafeWhereOperator(operator, 'leftJoin(operator)')
        insertJoin(`LEFT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      leftJoinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        validateIdentifier(alias, 'leftJoinSub(alias)')
        validateQualifiedIdentifier(onLeft, 'leftJoinSub(onLeft)')
        validateQualifiedIdentifier(onRight, 'leftJoinSub(onRight)')
        assertSafeWhereOperator(operator, 'leftJoinSub(operator)')
        insertJoin(`LEFT JOIN (${String(sub.toSQL())}) AS ${alias} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(alias)
        return this as any
      },
      rightJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        validateIdentifier(table2, 'rightJoin(table)')
        validateQualifiedIdentifier(onLeft, 'rightJoin(onLeft)')
        validateQualifiedIdentifier(onRight, 'rightJoin(onRight)')
        assertSafeWhereOperator(operator, 'rightJoin(operator)')
        insertJoin(`RIGHT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      crossJoin(table2: string) {
        validateIdentifier(table2, 'crossJoin(table)')
        insertJoin(`CROSS JOIN ${table2}`)
        joinedTables.add(table2)
        return this as any
      },
      crossJoinSub(sub: { toSQL: () => any }, alias: string) {
        validateIdentifier(alias, 'crossJoinSub(alias)')
        insertJoin(`CROSS JOIN (${String(sub.toSQL())}) AS ${alias}`)
        joinedTables.add(alias)
        return this as any
      },
      selectAllRelations() {
        if (!schema)
          return this as any
        const parent = String(table)
        const parentCols = Object.keys((schema as any)[parent]?.columns ?? {})
        const parts: any[] = []
        if (parentCols.length > 0)
          parts.push(sql`${sql(parent)}.*`)
        for (const jt of joinedTables) {
          const cols = Object.keys((schema as any)[jt]?.columns ?? {})
          for (const c of cols) {
            const alias = config.aliasing.relationColumnAliasFormat === 'camelCase'
              ? `${jt}_${c}`.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
              : config.aliasing.relationColumnAliasFormat === 'table.dot.column'
                ? `${jt}.${c}`
                : `${jt}_${c}`
            parts.push(sql`${sql(`${jt}.${c}`)} AS ${sql(alias)}`)
          }
        }
        if (parts.length > 0) {
          // Build column list as text
          const parentPart = parentCols.length > 0 ? `${parent}.*` : ''
          const joinParts: string[] = []
          for (const jt of joinedTables) {
            const cols = Object.keys((schema as any)[jt]?.columns ?? {})
            for (const c of cols) {
              const alias = config.aliasing.relationColumnAliasFormat === 'camelCase'
                ? `${jt}_${c}`.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())
                : config.aliasing.relationColumnAliasFormat === 'table.dot.column'
                  ? `${jt}.${c}`
                  : `${jt}_${c}`
              joinParts.push(`${jt}.${c} AS ${alias}`)
            }
          }
          const allCols = [parentPart, ...joinParts].filter(Boolean).join(', ')
          const fromIdx = text.indexOf(' FROM ')
          if (fromIdx !== -1)
            text = `SELECT ${allCols}${text.substring(fromIdx)}`
          else
            text = `SELECT ${allCols} FROM ${parent}`
          built = null
        }
        return this as any
      },
      groupBy(...cols: string[]) {
        if (cols.length) {
          // Compose with any existing GROUP BY so chained calls add columns
          // instead of emitting a second clause.
          text = SQL_PATTERNS.GROUP_BY.test(text)
            ? `${text}, ${cols.map(one => quoteColumnForDialect(String(one))).join(', ')}`
            : `${text} GROUP BY ${cols.map(one => quoteColumnForDialect(String(one))).join(', ')}`
          built = null
        }
        return this as any
      },
      groupByRaw(fragment: any) {
        const frag = renderRawFragment(fragment, 'groupByRaw(fragment)')
        text = SQL_PATTERNS.GROUP_BY.test(text)
          ? `${text}, ${frag}`
          : `${text} GROUP BY ${frag}`
        built = null
        return this as any
      },
      having(expr: any) {
        // Chained having() calls join with AND, not a second HAVING keyword
        // (`HAVING a HAVING b` is invalid). See stacksjs/bun-query-builder#1034.
        // Read from builder state, not from `text` — a raw select fragment that
        // merely contains the word made the first HAVING emit as AND. See #1122.
        const kw = hasHaving ? 'AND' : 'HAVING'
        // Handle array format: ['COUNT(id)', '>', 3]
        if (Array.isArray(expr)) {
          const paramIdx = whereParams.length + 1
          text = `${text} ${kw} ${expr[0]} ${expr[1]} ${getPlaceholder(paramIdx)}`
          whereParams.push(expr[2])
          hasHaving = true
          built = null
        }
        // Handle object format
        else if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const len = keys.length
          if (len) {
            const baseIdx = whereParams.length
            const conditions: string[] = Array.from({ length: len })
            for (let i = 0; i < len; i++) {
              const key = keys[i]
              conditions[i] = `${key} = ${getPlaceholder(baseIdx + i + 1)}`
              whereParams.push(expr[key])
            }
            text = `${text} ${kw} ${conditions.join(' AND ')}`
            hasHaving = true
            built = null
          }
        }
        // Handle raw expressions
        else if (expr && typeof (expr as any).raw !== 'undefined') {
          text += ` ${kw} ${(expr as any).raw}`
          hasHaving = true
          built = null
        }
        return this as any
      },
      havingRaw(fragment: any) {
        const frag = renderRawFragment(fragment, 'havingRaw(fragment)')
        const kw = hasHaving ? 'AND' : 'HAVING'
        text += ` ${kw} ${frag}`
        hasHaving = true
        built = null
        return this as any
      },
      orderByRaw(fragment: any) {
        const frag = renderRawFragment(fragment, 'orderByRaw(fragment)')
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${frag}`
          : `${text} ORDER BY ${frag}`
        built = null
        return this as any
      },
      $call(callback: (query: any) => any) {
        /*
         * Conditional chaining, without breaking the chain.
         *
         * `query.$call(q => wanted ? q.where(...) : q)` is how a filter that
         * only sometimes applies is written without assigning the builder to a
         * variable and losing the fluency - the shape Kysely made standard.
         *
         * The callback's return value is ignored on purpose: this builder
         * mutates and returns itself, so a callback that forgets to return
         * would otherwise turn the whole query into `undefined`. Taking `this`
         * back makes the two spellings - returning the query or not - mean the
         * same thing.
         */
        callback(this as any)

        return this as any
      },
      union(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('UNION', other)
        return this as any
      },
      unionAll(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('UNION ALL', other)
        return this as any
      },
      // INTERSECT / EXCEPT set operators (#1049), sharing union()'s param-merging
      // seam. The ALL variants are Postgres/MySQL-only (SQLite has no
      // INTERSECT ALL / EXCEPT ALL).
      intersect(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('INTERSECT', other)
        return this as any
      },
      intersectAll(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('INTERSECT ALL', other)
        return this as any
      },
      except(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('EXCEPT', other)
        return this as any
      },
      exceptAll(other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) {
        appendSetOp('EXCEPT ALL', other)
        return this as any
      },
      forPage(page: number, perPage: number) {
        const p = Math.max(1, Math.floor(page))
        const pp = Math.max(1, Math.floor(perPage))
        text += ` LIMIT ${pp} OFFSET ${(p - 1) * pp}`
        built = null
        return this as any
      },
      toSQL() {
        // Lazy: don't construct the driver Query object just to read SQL
        // text — most toSQL() calls never execute the returned handle.
        // ensureBuilt() still runs (memoized) if execute()/values()/raw()
        // is actually invoked.
        const sqlText = reorderSelectClauses(currentSql())
        return {
          sql: sqlText,
          toString: () => sqlText,
          execute: () => ensureBuilt().execute(),
          values: () => ensureBuilt().values(),
          raw: () => ensureBuilt().raw(),
        } as any
      },
      async value(column: string) {
        const q = sql`${ensureBuilt()} LIMIT 1`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.[column]
      },
      async pluck(column: any, key?: any) {
        const rows = await runWithHooks<any[]>(ensureBuilt(), 'select', { signal: abortSignal, timeoutMs })
        if (key) {
          // Build the keyed map, but throw on duplicate keys so the
          // caller knows their assumption ("the key column is
          // unique") was wrong. The previous implementation
          // silently overwrote on collision — two rows with the
          // same `key` value left only the last one's `column`
          // visible, which the documented `Record<string, ...>`
          // return type implicitly promised was a unique mapping.
          // See stacksjs/stacks#1862 #30.
          const out: Record<string, any> = {}
          for (const r of rows) {
            const k = String(r?.[key])
            if (Object.prototype.hasOwnProperty.call(out, k)) {
              throw new Error(`[query-builder] pluck(${column}, ${key}): duplicate key '${k}' — multiple rows share this value, so the resulting map would silently drop data. Use a unique key column or pluck without a key to get an array.`)
            }
            out[k] = r?.[column]
          }
          return out
        }
        return rows.map((r: any) => r?.[column])
      },
      async exists() {
        const q = sql`SELECT EXISTS (${ensureBuilt()}) as e`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Boolean(row?.e)
      },
      async doesntExist() {
        const e = await (this as any).exists()
        return !e
      },
      async paginate(perPage: number, page = 1, opts: { tx?: { unsafe: (sql: string, params?: any[]) => any } } = {}) {
        if (!Number.isFinite(perPage) || perPage <= 0 || !Number.isInteger(perPage))
          throw new TypeError(`[query-builder] paginate(perPage): expected positive integer, got ${perPage}`)
        if (!Number.isFinite(page) || page < 1 || !Number.isInteger(page))
          throw new TypeError(`[query-builder] paginate(page): expected integer >= 1, got ${page}`)

        // Snapshot-consistent pagination (#1051): when the caller supplies a
        // transaction handle, run BOTH the count and the page-data through it,
        // so a concurrent INSERT/DELETE can't desync `total` from `data.length`.
        // The caller owns the transaction (and thus the isolation level).
        if (opts.tx) {
          const baseSql = reorderSelectClauses(currentSql())
          const baseParams = [...whereParams]
          const cRows = await opts.tx.unsafe(`SELECT COUNT(*) as c FROM (${baseSql}) as sub`, baseParams) as any[]
          const total = Number(cRows?.[0]?.c ?? 0)
          const lastPage = Math.max(1, Math.ceil(total / perPage))
          const p = Math.max(1, Math.min(page, lastPage))
          const offset = (p - 1) * perPage
          const data = await opts.tx.unsafe(`${baseSql} LIMIT ${perPage} OFFSET ${offset}`, baseParams) as any[]
          return { data, meta: { perPage, page: p, total, lastPage } }
        }

        // Count + page-data run as two separate queries, so a
        // concurrent INSERT or DELETE between them can make `total`
        // and `data.length` mutually inconsistent — `total = 99` with
        // a `perPage = 20` page returning 18 rows on page 5 is a
        // classic symptom. The fix is to wrap both in a single
        // read-only transaction with snapshot isolation, but that
        // doesn't compose cleanly with callers who already wrap
        // `paginate()` in their own transaction (nested begin()
        // semantics vary by driver). For now we run both queries
        // back-to-back as before; under typical low-write workloads
        // the window is small enough that users rarely notice.
        //
        // See stacksjs/stacks#1862 #12 — a future major version
        // should accept a `tx` parameter so the caller can choose
        // their isolation level.
        const countQ = sql`SELECT COUNT(*) as c FROM (${ensureBuilt()}) as sub`
        const cRows = await runWithHooks<any[]>(countQ, 'select', { signal: abortSignal, timeoutMs })
        const [cRow] = cRows
        const total = Number(cRow?.c ?? 0)
        const lastPage = Math.max(1, Math.ceil(total / perPage))
        const p = Math.max(1, Math.min(page, lastPage))
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(sql`${ensureBuilt()} LIMIT ${perPage} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        return { data, meta: { perPage, page: p, total, lastPage } }
      },
      async simplePaginate(perPage: number, page = 1) {
        const p = Math.max(1, page)
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(sql`${ensureBuilt()} LIMIT ${perPage + 1} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        const hasMore = data.length > perPage
        return { data: hasMore ? data.slice(0, perPage) : data, meta: { perPage, page: p, hasMore } }
      },
      async cursorPaginate(perPage: number, cursor?: any, column: string | string[] = 'id', direction: 'asc' | 'desc' = 'asc') {
        if (!Number.isInteger(perPage) || perPage <= 0)
          throw new TypeError(`[query-builder] cursorPaginate(perPage): expected positive integer, got ${perPage}`)

        const cols = (Array.isArray(column) ? column : [column]).map(String)
        for (const c of cols) validateIdentifier(c, 'cursorPaginate(column)')
        const cmp = direction === 'asc' ? '>' : '<'
        const dir = direction === 'asc' ? 'ASC' : 'DESC'
        const params = [...whereParams]

        // The cursor predicate is a WHERE TERM, not a second WHERE keyword.
        // It used to be composed as `sql`${q} WHERE ...``, unconditionally — so
        // any filter already on the builder produced `... WHERE a WHERE b`, a
        // syntax error on every dialect. That is why `.where(x).chunkById(...)`
        // never worked: page one has no cursor and succeeds, and the failure
        // only lands on page two. See stacksjs/bun-query-builder#1090.
        let predicate = ''
        if (cursor !== undefined && cursor !== null) {
          if (Array.isArray(column)) {
            const phs = (cursor as any[]).map((v) => { params.push(v); return getPlaceholder(params.length) })
            predicate = `(${cols.join(', ')}) ${cmp} (${phs.join(', ')})`
          }
          else {
            params.push(cursor)
            predicate = `${cols[0]} ${cmp} ${getPlaceholder(params.length)}`
          }
        }

        // Rendered through currentSql() so the predicate is spliced ahead of any
        // trailing clause rather than appended past it, and so the builder's own
        // WHERE terms come along.
        const base = reorderSelectClauses(predicate ? currentSql({ conn: 'AND', sql: predicate }) : currentSql())
        const order = cols.map(c => `${c} ${dir}`).join(', ')

        // Cursor pagination OWNS the ordering — the cursor predicate `col > ?`
        // only selects "the rows after this one" if the rows are sorted by that
        // same column, so a different ORDER BY makes the cursor meaningless and
        // silently skips or repeats rows.
        //
        // This case has always been broken: it emitted a second ORDER BY and
        // failed to parse. It was invisible until now only because the
        // duplicate-WHERE error above fired first. Refusing it says so, rather
        // than dropping the caller's ordering without mentioning it.
        if (hasTopLevelOrderBy(base)) {
          throw new TypeError(
            `[query-builder] cursorPaginate() cannot be combined with orderBy() — it orders by `
            + `${order} itself, and a cursor is only meaningful in that order. `
            + `Remove the orderBy(), or pass the column and direction to cursorPaginate().`,
          )
        }
        const q = params.length > 0
          ? _sql.unsafe(`${base} ORDER BY ${order} LIMIT ${perPage + 1}`, params)
          : _sql.unsafe(`${base} ORDER BY ${order} LIMIT ${perPage + 1}`)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        // We fetch perPage+1 rows to detect whether more exist; the extra row
        // is only a "has more?" probe and is NOT delivered. The next cursor
        // MUST be the LAST DELIVERED row — using the probe row (rows[perPage])
        // made the next page query `col > <probe>`, which skipped that row
        // entirely, dropping one row at every page boundary (and silently
        // truncating chunkById/eachById).
        const hasMore = rows.length > perPage
        const data = rows.slice(0, perPage)
        const lastRow = data[data.length - 1]
        const next = hasMore && lastRow
          ? (Array.isArray(column) ? column.map(c => lastRow[c]) : lastRow[column])
          : null
        const prevCursor = data.length ? (Array.isArray(column) ? column.map(c => data[0]?.[c]) : data[0]?.[column]) : null
        return { data, meta: { perPage, nextCursor: next ?? null, prevCursor } }
      },
      async chunk(size: number, handler: (rows: any[]) => Promise<void> | void) {
        let page = 1
        while (true) {
          const { data, meta } = await (this as any).paginate(size, page)
          if (data.length === 0)
            break
          await handler(data as any[])
          // Terminate on lastPage, NOT on `data.length < size`: paginate()
          // CLAMPS an out-of-range page back to the last page, so when the row
          // count is an exact multiple of `size` the final page is full and a
          // `< size` check would request page after page forever, each clamped
          // to the same last page (infinite loop). meta.lastPage is authoritative.
          if (page >= meta.lastPage)
            break
          page += 1
        }
      },
      async chunkById(size: number, column = 'id', handler?: (rows: any[]) => Promise<void> | void) {
        let cursor: any
        while (true) {
          const { data, meta } = await (this as any).cursorPaginate(size, cursor, column, 'asc')
          if (data.length === 0)
            break
          if (handler)
            await handler(data as any[])
          cursor = meta.nextCursor
          if (!cursor)
            break
        }
      },
      async eachById(size: number, column = 'id', handler?: (row: any) => Promise<void> | void) {
        await (this as any).chunkById(size, column, async (rows: any[]) => {
          for (const r of rows) await handler?.(r as any)
        })
      },
      withTimeout(ms: number) {
        timeoutMs = Math.max(1, Math.floor(ms))
        return this as any
      },
      abort(signal: any) {
        abortSignal = signal
        return this as any
      },
      withTrashed() {
        includeTrashed = true
        onlyTrashed = false
        return this as any
      },
      onlyTrashed() {
        includeTrashed = true
        onlyTrashed = true

        const softDeleteColumn = config.softDeletes?.column || 'deleted_at'

        // Find the OUTERMOST `WHERE` (paren depth 0). The previous
        // implementation used `replace(/WHERE/, ...)` which matched
        // the first `WHERE` anywhere in the SQL — including inside a
        // subquery's WHERE clause. So a join like
        // `SELECT * FROM posts INNER JOIN (SELECT … WHERE x = 1) AS s
        //  WHERE posts.id = ?` got the soft-delete predicate spliced
        // into the SUBQUERY's WHERE instead of the outer one,
        // silently corrupting the SQL. See stacksjs/stacks#1862 #19.
        const splice = (raw: string, predicate: string): string => {
          const upper = raw.toUpperCase()
          let depth = 0
          for (let i = 0; i < raw.length; i++) {
            const c = raw[i]
            if (c === '(') depth++
            else if (c === ')') depth--
            else if (
              depth === 0
              && upper.substring(i, i + 5) === 'WHERE'
              && (i === 0 || /\s/.test(raw[i - 1] ?? ''))
              && /\s/.test(raw[i + 5] ?? '')
            ) {
              return `${raw.substring(0, i)}WHERE ${predicate} AND ${raw.substring(i + 6)}`
            }
          }
          // No outer WHERE — append one.
          return `${raw} WHERE ${predicate}`
        }

        const predicate = `${table}.${softDeleteColumn} IS NOT NULL`

        text = splice(text, predicate)

        const currentSql = String(ensureBuilt())
        built = sql([splice(currentSql, predicate)] as any)

        return this as any
      },
      scope(name: string, value?: any) {
        const tbl = String(table)
        const scopeMap = meta?.scopes?.[tbl]
        const fn = scopeMap?.[name]
        if (fn)
          return fn(this, value)
        return this as any
      },
      when(condition: any, then: (qb: any) => any, otherwise?: (qb: any) => any) {
        if (condition)
          return then(this)
        if (otherwise)
          return otherwise(this)
        return this as any
      },
      tap(fn: (qb: any) => any) {
        fn(this)
        return this as any
      },
      dump() {
        console.log(String(ensureBuilt()))
        return this as any
      },
      dd() {
        console.log(String(ensureBuilt()))
        throw new Error('Dump and Die')
      },
      cache(ttlMs: number = 60000) {
        cacheTtl = ttlMs
        useCache = true
        return this as any
      },
      async explain() {
        const q = sql`EXPLAIN ${ensureBuilt()}`
        return await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
      },
      simple() {
        return (ensureBuilt() as any).simple()
      },
      toText() {
        return currentSql()
      },
      async get() {
        const hooks = activeHooks()
        const hasQueryHooks = hooks && (hooks.onQueryStart || hooks.onQueryEnd || hooks.onQueryError || hooks.startSpan || hasSlowQueryHook(hooks))

        // Ultra-fast path: skip unsafe() entirely, use _prepareStatement for direct stmt access
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !hasQueryHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const stmt = prepareFn(currentSql())
            return hydratePivotRows(whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all())
          }
        }

        // Build query at execution time (statement will be cached by db-clients.ts)
        const getText = currentSql()
        built = whereParams.length > 0
          ? _sql.unsafe(getText, whereParams)
          : _sql.unsafe(getText)

        // Fast path: no soft-deletes, no cache, no timeout, no signal, no hooks
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !hasQueryHooks) {
          // Direct statement execution for maximum performance (bypasses all overhead)
          const stmt = ensureBuilt()._stmt
          const params = ensureBuilt()._params
          if (stmt) {
            return hydratePivotRows(params && params.length > 0 ? stmt.all(...params) : stmt.all())
          }
          return hydratePivotRows(await ensureBuilt().execute())
        }

        // Fast path: no soft-deletes, no cache, no timeout, no signal (but may have hooks)
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal) {
          return hydratePivotRows(await runWithHooks<any[]>(ensureBuilt(), 'select'))
        }

        // Apply soft-deletes default filter if enabled and table has the column
        let finalQuery = ensureBuilt()
        if (config.softDeletes?.enabled && config.softDeletes.defaultFilter && !includeTrashed) {
          const col = config.softDeletes.column
          const tbl = String(table)
          const hasCol = schema ? Boolean((schema as any)[tbl]?.columns?.[col]) : true
          if (hasCol && !SQL_PATTERNS.DELETED_AT.test(currentSql())) {
            // Record the term, then rebuild. The previous version composed
            // `sql`${ensureBuilt()} WHERE ...`` as well, which appended a second
            // unconditional WHERE keyword on top of any filter already present.
            addWhereText('WHERE', `${String(col)} IS ${onlyTrashed ? 'NOT ' : ''}NULL`)
            finalQuery = ensureBuilt()
          }
        }

        // Check cache if enabled. The key must include the BOUND PARAMS:
        // `String(query)` is only the SQL text with placeholders, so
        // `where id = $1` with [1] and with [2] would otherwise share one
        // cache entry and the second query would return the first's rows.
        const cacheKey = useCache
          ? `${String(finalQuery)}\0${JSON.stringify(whereParams)}`
          : ''
        if (useCache) {
          const cached = queryCache.get(cacheKey)
          if (cached)
            return cached
        }

        const result = await runWithHooks<any[]>(finalQuery, 'select', { signal: abortSignal, timeoutMs })

        // Store in cache if enabled
        if (useCache)
          queryCache.set(cacheKey, result, cacheTtl)

        return hydratePivotRows(result)
      },
      async executeTakeFirst() {
        const rows = await runWithHooks<any[]>(ensureBuilt(), 'select', { signal: abortSignal, timeoutMs })
        return hydratePivotRow(Array.isArray(rows) ? rows[0] : rows)
      },
      async executeTakeFirstOrThrow() {
        const result = await (this as any).executeTakeFirst()
        if (!result)
          throw new Error('Record not found')
        return result
      },
      async first() {
        // Ultra-fast path: skip overhead, prepare statement directly from text
        const fHooks = activeHooks()
        const fHasQueryHooks = fHooks && (fHooks.onQueryStart || fHooks.onQueryEnd || fHooks.onQueryError || fHooks.startSpan || hasSlowQueryHook(fHooks))
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !fHasQueryHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const base = currentSql()
            const firstText = base.includes(' LIMIT ') ? base : `${base} LIMIT 1`
            const stmt = prepareFn(firstText)
            const rows = whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all()
            return hydratePivotRow(rows[0]) as any
          }
        }
        const rows = await runWithHooks<any[]>(sql`${ensureBuilt()} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return hydratePivotRow(row) as any
      },
      async firstOrFail() {
        const row = await (this as any).first()
        if (!row)
          throw new Error('Record not found')
        return row as any
      },
      async find(id: any) {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const rows = await runWithHooks<any[]>(sql`${ensureBuilt()} WHERE ${sql(pk)} = ${id} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row as any
      },
      async findOrFail(id: any) {
        const row = await (this as any).find(id)
        if (!row)
          throw new Error('Record not found')
        return row as any
      },
      async findMany(ids: any[]) {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const rows = await runWithHooks<any[]>(sql`${ensureBuilt()} WHERE ${sql(String(pk))} IN ${sql(ids as any)}`, 'select', { signal: abortSignal, timeoutMs })
        return rows as any
      },
      async* lazy() {
        let cursor: any
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        while (true) {
          const q = cursor == null
            ? sql`${ensureBuilt()} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
            : sql`${ensureBuilt()} WHERE ${sql(String(pk))} > ${cursor} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
          const rows: any[] = await (q as any).execute()
          if (rows.length === 0)
            break
          for (const r of rows) yield r as any
          cursor = rows[rows.length - 1]?.[pk as any]
          if (cursor == null)
            break
        }
      },
      async* lazyById() {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        let cursor: any
        while (true) {
          const q = cursor == null
            ? sql`${ensureBuilt()} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
            : sql`${ensureBuilt()} WHERE ${sql(String(pk))} > ${cursor} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
          const rows: any[] = await (q as any).execute()
          if (rows.length === 0)
            break
          for (const r of rows) yield r as any
          cursor = rows[rows.length - 1]?.[pk as any]
          if (cursor == null)
            break
        }
      },
      pipe(fn: any) {
        return fn(this as any)
      },
      async count() {
        // Build COUNT query. The fast path replaces the SELECT list
        // with `COUNT(*)` and keeps everything after `FROM`. That's
        // correct UNLESS the query has a `GROUP BY` — then
        // `COUNT(*)` returns one row per group, and grabbing
        // `rows[0]` silently returns just the first group's count.
        // Wrap in a subquery when GROUP BY is present.
        // See stacksjs/stacks#1862 #26.
        // Rebuild from currentSql(), not `text` — the WHERE lives in the term
        // list now, and slicing `text` here would count the UNFILTERED table.
        const src = currentSql()
        const fromIdx = src.indexOf(' FROM ')
        const hasGroupBy = / GROUP BY /i.test(src)
        let countText: string
        if (hasGroupBy) {
          countText = `SELECT COUNT(*) as c FROM (${src}) AS _bqb_count_sub`
        }
        else if (fromIdx !== -1) {
          countText = `SELECT COUNT(*) as c${src.substring(fromIdx)}`
        }
        else {
          countText = `SELECT COUNT(*) as c FROM ${table}`
        }

        // Ultra-fast path
        const cHooks = activeHooks()
        const cHasHooks = cHooks && (cHooks.onQueryStart || cHooks.onQueryEnd || cHooks.onQueryError || cHooks.startSpan || hasSlowQueryHook(cHooks))
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !cHasHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const stmt = prepareFn(countText)
            const rows = whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all()
            return Number(rows[0]?.c ?? 0)
          }
        }

        const q = whereParams.length > 0
          ? _sql.unsafe(countText, whereParams)
          : _sql.unsafe(countText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.c ?? 0)
      },
      async avg(column: string) {
        // Build optimized AVG query without subquery or helpers
        const src = currentSql()
        const fromIdx = src.indexOf(' FROM ')
        const avgText = fromIdx !== -1
          ? `SELECT AVG(${column}) as a${src.substring(fromIdx)}`
          : `SELECT AVG(${column}) as a FROM ${table}`

        // Ultra-fast path
        const aHooks = activeHooks()
        const aHasHooks = aHooks && (aHooks.onQueryStart || aHooks.onQueryEnd || aHooks.onQueryError || aHooks.startSpan || hasSlowQueryHook(aHooks))
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !aHasHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const stmt = prepareFn(avgText)
            const rows = whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all()
            return Number(rows[0]?.a ?? 0)
          }
        }

        const q = whereParams.length > 0
          ? _sql.unsafe(avgText, whereParams)
          : _sql.unsafe(avgText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.a ?? 0)
      },
      async sum(column: string) {
        const src = currentSql()
        const fromIdx = src.indexOf(' FROM ')
        const sumText = fromIdx !== -1
          ? `SELECT SUM(${column}) as s${src.substring(fromIdx)}`
          : `SELECT SUM(${column}) as s FROM ${table}`
        const q = whereParams.length > 0
          ? _sql.unsafe(sumText, whereParams)
          : _sql.unsafe(sumText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.s ?? 0)
      },
      async max(column: string) {
        const src = currentSql()
        const fromIdx = src.indexOf(' FROM ')
        const maxText = fromIdx !== -1
          ? `SELECT MAX(${column}) as m${src.substring(fromIdx)}`
          : `SELECT MAX(${column}) as m FROM ${table}`
        const q = whereParams.length > 0
          ? _sql.unsafe(maxText, whereParams)
          : _sql.unsafe(maxText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.m
      },
      async min(column: string) {
        const src = currentSql()
        const fromIdx = src.indexOf(' FROM ')
        const minText = fromIdx !== -1
          ? `SELECT MIN(${column}) as m${src.substring(fromIdx)}`
          : `SELECT MIN(${column}) as m FROM ${table}`
        const q = whereParams.length > 0
          ? _sql.unsafe(minText, whereParams)
          : _sql.unsafe(minText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.m
      },
      lockForUpdate() {
        text += ' FOR UPDATE'
        built = null
        return this as any
      },
      sharedLock() {
        const syntax = config.sql.sharedLockSyntax === 'LOCK IN SHARE MODE' ? 'LOCK IN SHARE MODE' : 'FOR SHARE'
        text += ` ${syntax}`
        built = null
        return this as any
      },
      withCTE(name: string, sub: any) {
        validateIdentifier(name, 'withCTE(name)')
        text = `WITH ${name} AS (${String(sub.toSQL())}) ${text}`
        built = null
        return this as any
      },
      withRecursive(name: string, sub: any) {
        validateIdentifier(name, 'withRecursive(name)')
        text = `WITH RECURSIVE ${name} AS (${String(sub.toSQL())}) ${text}`
        built = null
        return this as any
      },
      execute() {
        return runWithHooks<any[]>(ensureBuilt(), 'select', { signal: abortSignal, timeoutMs })
      },
      values() {
        return (ensureBuilt() as any).values()
      },
      toParams() {
        // Return the builder's ordered bound params directly. The previous
        // `ensureBuilt().values?.()` was unreliable: `.values` is a params
        // ARRAY on the sqlite wrapper but a METHOD on Bun's native query, so
        // calling it yielded `{}`/garbage instead of the params. `whereParams`
        // is the single source of truth (same as __rawState()).
        return [...whereParams]
      },
      // Internal: the builder's finalized SQL text + ordered bound params, used
      // by union()/unionAll() on the other side to merge params and renumber
      // placeholders. See stacksjs/bun-query-builder#1029.
      __rawState() {
        return { sql: reorderSelectClauses(currentSql()), params: [...whereParams] }
      },
      // Internal: does this builder's SQL already carry a predicate that a
      // further where() would have to join with AND? Used by appendSetOp on
      // the other side, so it can answer that about the right-hand operand
      // instead of scanning a statement that also contains the left one.
      // See stacksjs/bun-query-builder#1120.
      __hasPredicate() {
        return whereTerms.length > 0 || tailHasPredicate
      },
      raw() {
        return (ensureBuilt() as any).raw()
      },
      get rows() {
        return undefined as any
      },
      get row() {
        return undefined as any
      },
      cancel() {
        try {
          (ensureBuilt() as any).cancel()
        }
        catch {}
      },

    } as unknown as BaseSelectQueryBuilder<DB, TTable, any, TTable>

    const proxy: any = new Proxy(base as any, {
      get(target, prop: string, receiver) {
        // Prefer explicitly defined methods on the base API
        const existing = Reflect.get(target, prop, receiver)
        if (existing !== undefined)
          return existing
        if (typeof prop === 'string' && (prop.startsWith('where') || prop.startsWith('orWhere') || prop.startsWith('andWhere'))) {
          const isOr = prop.startsWith('orWhere')
          const isAnd = prop.startsWith('andWhere')
          // Resolve `whereCreatedAt` → `created_at` once per (table, prop)
          // pair — this get trap runs on EVERY dynamic-where access, and the
          // regex/Object.keys/find work below showed up in profiles.
          //
          // NOTE the prefix regex: `(?:or|and)?where`. The previous
          // `/^or?where/i` parsed as `o` + optional `r` + `where`, which
          // NEVER matched plain `whereName` — the un-stripped prop then
          // snake-cased to `where_name` and every plain dynamic where
          // failed on a real database with "no such column".
          const cacheKey = `${String(table)}|${prop}`
          let chosen = dynamicWhereColumnCache.get(cacheKey)
          if (chosen === undefined) {
            const raw = prop.replace(/^(?:or|and)?where/i, '')
            if (!raw) {
              dynamicWhereColumnCache.set(cacheKey, '')
              chosen = ''
            }
            else {
              const lowerFirst = raw.charAt(0).toLowerCase() + raw.slice(1)
              const snake = raw.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
              const available: string[] = schema ? Object.keys(((schema as any)[String(table)]?.columns) ?? {}) : []
              chosen = [snake, lowerFirst, lowerFirst.toLowerCase()].find(n => available.includes(n)) ?? snake
              dynamicWhereColumnCache.set(cacheKey, chosen)
            }
          }
          if (chosen === '')
            return () => receiver
          const column = chosen
          return (value: any) => {
            // Record the term and let ensureBuilt() rebuild from it.
            //
            // This used to ALSO assign `built = sql\`${ensureBuilt()} OR …\``,
            // a second representation of the same predicate that appended a
            // bare top-level OR — so the dynamic `orWhereX` proxy mis-grouped
            // even where the text path did not. It was the query object
            // actually executed. See #1083.
            if (Array.isArray(value)) {
              const phs = getPlaceholders(value.length, whereParams.length + 1)
              addWhereText(isOr ? 'OR' : isAnd ? 'AND' : 'WHERE', `${column} IN (${phs})`)
              whereParams.push(...value)
            }
            else {
              const ph = getPlaceholder(whereParams.length + 1)
              addWhereText(isOr ? 'OR' : isAnd ? 'AND' : 'WHERE', `${column} = ${ph}`)
              whereParams.push(value)
            }
            return receiver
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return proxy as any
  }

  return {
    // Create a builder with per-instance option overrides.
    //
    // There is no per-instance config yet: this writes the same process-wide
    // singleton `setConfig()` does (see the warning on `setConfig`), so it goes
    // through the same merge rather than a bare `Object.assign`. That assign
    // was the last write path that could replace a whole nested section —
    // `db.configure({ debug: { captureText: false } })` used to drop every
    // other key of `debug`.
    configure(opts: QueryBuilderOptions) {
      setConfig(opts)
      return this as any
    },
    /** Escape/validate identifier names (best-effort) */
    id(name: string) {
      if (!SQL_PATTERNS.IDENTIFIER.test(name)) {
        throw new Error(`[query-builder] Invalid identifier: '${name}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
      }
      return _sql(String(name))
    },
    ids(...names: string[]) {
      for (const n of names) {
        if (!SQL_PATTERNS.IDENTIFIER.test(n)) {
          throw new Error(`[query-builder] Invalid identifier: '${n}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
        }
      }
      return _sql(names as any)
    },
    select<TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
      table: TTable,
      ...columns: (K | `${string} as ${string}`)[]
    ): SelectQueryBuilder<DB, TTable, any, TTable> {
      return makeSelect<any>(table, columns as string[]) as unknown as SelectQueryBuilder<DB, TTable, any, TTable>
    },
    selectFrom<TTable extends keyof DB & string>(table: TTable) {
      return makeSelect<TTable>(table)
    },
    selectFromSub(sub, alias) {
      // Helper that produces a method which throws when called. Used
      // for the ~50 methods on the `selectFromSub` return shape that
      // would otherwise return silent no-ops. See stacksjs/stacks#1862 #11.
      function subqueryNotSupported(methodName: string): () => never {
        return () => {
          throw new Error(
            `[query-builder] selectFromSub(...).${methodName}() is not supported. `
            + `Apply ${methodName}() to the underlying subquery BEFORE passing it to selectFromSub, `
            + `or use the regular selectFrom(...) builder. This previously silently returned without `
            + `affecting the SQL, producing wrong results — see stacksjs/stacks#1862 #11.`,
          )
        }
      }

      // Capture the subquery's SQL TEXT and bound PARAMS up front, then build
      // the outer query as a text+params statement. The previous version did
      // `_sql\`SELECT * FROM (${sub.toSQL()}) AS ...\`` and manipulated
      // `String(q)`: on a real driver `String(builtQuery)` is "[object Promise]"
      // (Bun query objects can't be stringified), so the SQL was corrupted, and
      // the subquery's bound params were dropped entirely (`near "?" syntax
      // error`). Text+params is the only representation that survives both.
      validateIdentifier(String(alias), 'selectFromSub(alias)')
      // Prefer the builder's internal __rawState() — it returns the finalized
      // SQL text AND the ordered bound params reliably (it's what union() uses).
      // toSQL()/toParams() are unreliable here: toParams() calls `.values()` on
      // the built query, which is a params ARRAY on the sqlite wrapper but a
      // METHOD on Bun's native query, so it silently yielded no params and the
      // subquery's WHERE bindings were dropped.
      const rawState: { sql: string, params: any[] } | null
        = typeof (sub as any).__rawState === 'function' ? (sub as any).__rawState() : null
      const subExec: any = sub.toSQL()
      const subText: string = rawState?.sql
        ?? (typeof subExec === 'string' ? subExec : (subExec?.sql ?? String(subExec)))
      const subParams: any[] = rawState?.params
        ?? (Array.isArray(subExec?.values) ? subExec.values : [])
      const baseText = `SELECT * FROM (${subText}) AS ${String(alias)}`

      // Render one condition into a clause, returning it plus the extended
      // params. The connector is NOT applied here: the caller records it as a
      // term and renderWhereTerms() decides the shape at emit time, which is
      // what stops a chained `orWhere` from mis-grouping (#1083). It also
      // retires the `hasWhere` flag this used to thread through every method —
      // the flag existed because the SUBQUERY text contains its own `WHERE`
      // inside the parens, so regex-testing for one reported the OUTER query as
      // already having a WHERE. A term list has no such question to ask.
      const appendWhere = (
        params: any[],
        expr: any,
        op: WhereOperator | undefined,
        value: any,
      ): { clause: string | null, params: any[] } => {
        const out = [...params]
        const cmp = (col: string, operator: string, val: any): string => {
          validateIdentifier(col, 'selectFromSub where(column)')
          const o = assertSafeWhereOperator(operator, 'selectFromSub where(operator)')
          if (o === 'in' || o === 'not in') {
            const vals = Array.isArray(val) ? val : [val]
            const phs = getPlaceholders(vals.length, out.length + 1)
            out.push(...vals)
            return `${col} ${o.toUpperCase()} (${phs})`
          }
          const ph = getPlaceholder(out.length + 1)
          out.push(val)
          return `${col} ${o} ${ph}`
        }
        let clause: string
        if (typeof expr === 'string' && op !== undefined) {
          clause = cmp(expr, op, value)
        }
        else if (Array.isArray(expr) && expr.length === 3) {
          clause = cmp(expr[0], expr[1], expr[2])
        }
        else if (expr && typeof expr === 'object') {
          const parts = Object.entries(expr).map(([k, v]) => cmp(k, '=', v))
          // One term: `orWhere({a, b})` means "OR (a AND b)".
          clause = parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0]
        }
        else {
          return { clause: null, params }
        }
        return { clause, params: out }
      }

      // Build the base API. makeSub() is the single factory; every mutating
      // method returns a fresh builder over the new (baseText, terms, params,
      // tail). `text` is DERIVED — the WHERE is rendered from the term list and
      // spliced between the SELECT body and the trailing clauses, so a `where`
      // added after an `orderBy` still lands in front of it.
      function makeSub(baseText: string, terms: WhereTerm[], params: any[], tail = ''): BaseSelectQueryBuilder<DB, any, any, any> {
        const body = renderWhereTerms(terms)
        const text = body ? `${baseText} WHERE ${body}${tail}` : `${baseText}${tail}`
        const build = (): any => params.length > 0 ? _sql.unsafe(text, params) : _sql.unsafe(text)
        const withTerm = (conn: 'AND' | 'OR', expr: any, op: WhereOperator | undefined, value: any) => {
          const r = appendWhere(params, expr, op, value)
          return r.clause === null
            ? makeSub(baseText, terms, params, tail) as any
            : makeSub(baseText, [...terms, { conn, sql: r.clause }], r.params, tail) as any
        }
        /**
         * A parenthesised sub-group. The callback gets a minimal collector that
         * records terms and params in the outer builder's numbering, so the
         * group's placeholders continue rather than restart.
         */
        const withGroup = (conn: 'AND' | 'OR', cb: (b: any) => unknown) => {
          const gTerms: WhereTerm[] = []
          let gParams = [...params]
          const add = (c: 'AND' | 'OR') => (expr: any, op?: WhereOperator, value?: any) => {
            const r = appendWhere(gParams, expr, op, value)
            if (r.clause !== null) {
              gTerms.push({ conn: c, sql: r.clause })
              gParams = r.params
            }
            return collector
          }
          const collector: any = { where: add('AND'), andWhere: add('AND'), orWhere: add('OR') }
          cb(collector)
          const body = renderWhereTerms(gTerms)
          if (!body) {
            // Same fails-closed rule as the main builder: a group that
            // contributed nothing would leave the query matching everything.
            throw new TypeError(
              '[query-builder] selectFromSub.whereGroup(callback): the callback added no conditions. '
              + 'Add at least one where()/orWhere() to the builder it receives.',
            )
          }
          return makeSub(baseText, [...terms, { conn, sql: `(${body})` }], gParams, tail) as any
        }
        const base: BaseSelectQueryBuilder<DB, any, any, any> = {
        distinct() {
          return makeSub(baseText.replace(/^SELECT\s+/i, 'SELECT DISTINCT '), terms, params, tail) as any
        },
        distinctOn(...columns: any[]) {
          const cols = columns.map(String).join(', ')
          return makeSub(baseText.replace(/^SELECT\s+/i, `SELECT DISTINCT ON (${cols}) `), terms, params, tail) as any
        },
        selectRaw(fragment: any) {
          const frag = renderRawFragment(fragment, 'selectFromSub.selectRaw(fragment)')
          const fromIdx = baseText.indexOf(' FROM ')
          const newBase = fromIdx !== -1
            ? `${baseText.slice(0, fromIdx)}, ${frag}${baseText.slice(fromIdx)}`
            : `${baseText}, ${frag}`
          return makeSub(newBase, terms, params, tail) as any
        },
        $call(callback: (query: any) => any) {
          /*
           * The same conditional-chaining hook the main builder has, and it has
           * to be here for the type to be true: `BaseSelectQueryBuilder`
           * declares `$call`, so a sub-select that lacked it was a builder that
           * did not implement the interface it claimed - the one thing `tsc`
           * had to say about this file.
           *
           * The callback's return value is used, where the main builder ignores
           * it, and that is not an inconsistency: this builder is immutable, so
           * `q.where(...)` yields a *new* sub-select and dropping it would drop
           * the clause. A callback that forgets to return gets the unchanged
           * query rather than `undefined`.
           */
          const next = callback(this as any)

          return (next ?? this) as any
        },
        where(expr: any, op?: WhereOperator, value?: any) {
          return withTerm('AND', expr, op, value)
        },
        andWhere(expr: any, op?: WhereOperator, value?: any) {
          return withTerm('AND', expr, op, value)
        },
        orWhere(expr: any, op?: WhereOperator, value?: any) {
          return withTerm('OR', expr, op, value)
        },
        // Supported here because `orWhere` is: now that a chained OR groups
        // with the term before it, this is the only way to express the other
        // reading. The rest of the where-family keeps the deliberate
        // subqueryNotSupported() throw further down.
        whereGroup(cb: any) {
          return withGroup('AND', cb)
        },
        orWhereGroup(cb: any) {
          return withGroup('OR', cb)
        },
        orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
          validateIdentifier(String(column), 'selectFromSub.orderBy(column)')
          const dir = direction === 'asc' ? 'ASC' : 'DESC'
          // Compose-aware: a second orderBy appends with a comma.
          const newTail = SQL_PATTERNS.ORDER_BY.test(tail)
            ? `${tail}, ${column} ${dir}`
            : `${tail} ORDER BY ${column} ${dir}`
          return makeSub(baseText, terms, params, newTail) as any
        },
        limit(n: number) {
          if (!Number.isInteger(n) || n < 0)
            throw new TypeError(`[query-builder] selectFromSub.limit(n): expected non-negative integer, got ${n}`)
          const newTail = SQL_PATTERNS.LIMIT.test(tail)
            ? tail.replace(SQL_PATTERNS.LIMIT, ` LIMIT ${n}`)
            : `${tail} LIMIT ${n}`
          return makeSub(baseText, terms, params, newTail) as any
        },
        offset(n: number) {
          if (!Number.isInteger(n) || n < 0)
            throw new TypeError(`[query-builder] selectFromSub.offset(n): expected non-negative integer, got ${n}`)
          const newTail = SQL_PATTERNS.OFFSET.test(tail)
            ? tail.replace(SQL_PATTERNS.OFFSET, ` OFFSET ${n}`)
            : `${tail} OFFSET ${n}`
          return makeSub(baseText, terms, params, newTail) as any
        },
        toSQL() {
          return makeExecutableQuery(build(), text) as any
        },
        async execute() {
          return runWithHooks<any[]>(build(), 'select')
        },
        async executeTakeFirst() {
          const rows = await runWithHooks<any[]>(build(), 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async executeTakeFirstOrThrow() {
          const rows = await runWithHooks<any[]>(build(), 'select')
          const first = Array.isArray(rows) ? rows[0] : rows
          if (!first)
            throw new Error('Record not found')
          return first
        },
        async get() {
          return runWithHooks<any[]>(build(), 'select')
        },
        async first() {
          const rows = await runWithHooks<any[]>(build(), 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async firstOrFail() {
          const rows = await runWithHooks<any[]>(build(), 'select')
          const first = Array.isArray(rows) ? rows[0] : rows
          if (!first)
            throw new Error('No rows found')
          return first
        },
        async count() {
          const q = params.length > 0
            ? _sql.unsafe(`SELECT COUNT(*) as c FROM (${text}) as sub`, params)
            : _sql.unsafe(`SELECT COUNT(*) as c FROM (${text}) as sub`)
          const rows = await runWithHooks<any[]>(q, 'select')
          return Number(rows?.[0]?.c ?? 0)
        },
        async exists() {
          const q = params.length > 0
            ? _sql.unsafe(`SELECT EXISTS(${text}) as e`, params)
            : _sql.unsafe(`SELECT EXISTS(${text}) as e`)
          const result = await runWithHooks<any[]>(q, 'select')
          return Boolean(result?.[0]?.e)
        },
        async doesntExist() {
          return !(await base.exists!())
        },
        values() {
          return (build() as any).values()
        },
        raw() {
          return (build() as any).raw()
        },
        cancel() {
          try {
            ;(build() as any).cancel()
          }
          catch {}
        },
        // Methods NOT supported on `selectFromSub` results.
        //
        // The type interface declares ~40 builder methods that look
        // chainable, but the previous implementation returned silent
        // no-ops for each — `.whereRaw(...)` did nothing, `.join(...)`
        // did nothing, `.count()` returned 0 regardless of the actual
        // subquery, etc. Callers chained and got wrong results.
        //
        // The right answer is to either (a) implement each method
        // against the subquery SQL, or (b) refuse loud so callers
        // build the subquery with the filters already applied BEFORE
        // wrapping in `selectFromSub`.
        //
        // We pick (b): throw on every unsupported method. Substantial
        // (a)-style implementations land per-method in follow-ups,
        // each replacing the throw here with a real call. Callers
        // affected: construct your subquery with its own
        // .where()/.join()/.groupBy() FIRST, then pass to
        // `selectFromSub` to wrap. See stacksjs/stacks#1862 #11.
        whereRaw: subqueryNotSupported('whereRaw'),
        whereColumn: subqueryNotSupported('whereColumn'),
        orWhereColumn: subqueryNotSupported('orWhereColumn'),
        whereIn: subqueryNotSupported('whereIn'),
        orWhereIn: subqueryNotSupported('orWhereIn'),
        whereNotIn: subqueryNotSupported('whereNotIn'),
        orWhereNotIn: subqueryNotSupported('orWhereNotIn'),
        whereLike: subqueryNotSupported('whereLike'),
        whereILike: subqueryNotSupported('whereILike'),
        orWhereLike: subqueryNotSupported('orWhereLike'),
        orWhereILike: subqueryNotSupported('orWhereILike'),
        whereNotLike: subqueryNotSupported('whereNotLike'),
        whereNotILike: subqueryNotSupported('whereNotILike'),
        orWhereNotLike: subqueryNotSupported('orWhereNotLike'),
        orWhereNotILike: subqueryNotSupported('orWhereNotILike'),
        whereAny: subqueryNotSupported('whereAny'),
        whereAll: subqueryNotSupported('whereAll'),
        whereNone: subqueryNotSupported('whereNone'),
        whereNested: subqueryNotSupported('whereNested'),
        orWhereNested: subqueryNotSupported('orWhereNested'),
        whereDate: subqueryNotSupported('whereDate'),
        whereBetween: subqueryNotSupported('whereBetween'),
        whereNotBetween: subqueryNotSupported('whereNotBetween'),
        whereJsonContains: subqueryNotSupported('whereJsonContains'),
        whereJsonPath: subqueryNotSupported('whereJsonPath'),
        whereNull: subqueryNotSupported('whereNull'),
        orWhereNull: subqueryNotSupported('orWhereNull'),
        whereNotNull: subqueryNotSupported('whereNotNull'),
        orWhereNotNull: subqueryNotSupported('orWhereNotNull'),
        whereExists: subqueryNotSupported('whereExists'),
        orWhereExists: subqueryNotSupported('orWhereExists'),
        orWhereBetween: subqueryNotSupported('orWhereBetween'),
        orWhereRaw: subqueryNotSupported('orWhereRaw'),
        whereJsonDoesntContain: subqueryNotSupported('whereJsonDoesntContain'),
        whereJsonContainsKey: subqueryNotSupported('whereJsonContainsKey'),
        whereJsonDoesntContainKey: subqueryNotSupported('whereJsonDoesntContainKey'),
        whereJsonLength: subqueryNotSupported('whereJsonLength'),
        join: subqueryNotSupported('join'),
        joinSub: subqueryNotSupported('joinSub'),
        innerJoin: subqueryNotSupported('innerJoin'),
        leftJoin: subqueryNotSupported('leftJoin'),
        leftJoinSub: subqueryNotSupported('leftJoinSub'),
        rightJoin: subqueryNotSupported('rightJoin'),
        crossJoin: subqueryNotSupported('crossJoin'),
        crossJoinSub: subqueryNotSupported('crossJoinSub'),
        groupBy: subqueryNotSupported('groupBy'),
        groupByRaw: subqueryNotSupported('groupByRaw'),
        having: subqueryNotSupported('having'),
        havingRaw: subqueryNotSupported('havingRaw'),
        addSelect: subqueryNotSupported('addSelect'),
        select: subqueryNotSupported('select'),
        selectAll: subqueryNotSupported('selectAll'),
        orderByDesc: subqueryNotSupported('orderByDesc'),
        inRandomOrder: subqueryNotSupported('inRandomOrder'),
        reorder: subqueryNotSupported('reorder'),
        orderByRaw: subqueryNotSupported('orderByRaw'),
        union: subqueryNotSupported('union'),
        unionAll: subqueryNotSupported('unionAll'),
        forPage: subqueryNotSupported('forPage'),
        selectAllRelations: subqueryNotSupported('selectAllRelations'),
        with: subqueryNotSupported('with'),
        value: subqueryNotSupported('value'),
        pluck: subqueryNotSupported('pluck'),
        cursorPaginate: subqueryNotSupported('cursorPaginate'),
        paginate: subqueryNotSupported('paginate'),
        simplePaginate: subqueryNotSupported('simplePaginate'),
        chunk: subqueryNotSupported('chunk'),
        chunkById: subqueryNotSupported('chunkById'),
        eachById: subqueryNotSupported('eachById'),
        avg: subqueryNotSupported('avg'),
        sum: subqueryNotSupported('sum'),
        max: subqueryNotSupported('max'),
        min: subqueryNotSupported('min'),
        find: subqueryNotSupported('find'),
        findOrFail: subqueryNotSupported('findOrFail'),
        findMany: subqueryNotSupported('findMany'),
        latest: subqueryNotSupported('latest'),
        oldest: subqueryNotSupported('oldest'),
        lazy: subqueryNotSupported('lazy'),
        lazyById: subqueryNotSupported('lazyById'),
        pipe: (fn: any) => fn(base),
        when: subqueryNotSupported('when'),
        tap: () => base as any,
        dump: () => base as any,
        dd: () => { throw new Error('Dump and Die') },
        explain: () => Promise.resolve([]),
        simple: () => (build() as any).simple(),
        toText: () => text,
        toParams: () => [...params],
        withTimeout: () => base as any,
        abort: () => base as any,
        lockForUpdate: () => base as any,
        sharedLock: () => base as any,
        withCTE: () => base as any,
        withRecursive: () => base as any,
        cache: () => base as any,
        clone: () => base as any,
        withTrashed: () => base as any,
        onlyTrashed: () => base as any,
        scope: () => base as any,
        // Type-only properties
        get rows() { return [] as any },
        get row() { return undefined as any },
        }
        return base
      }

      return makeSub(baseText, [], subParams) as any
    },
    insertInto<TTable extends keyof DB & string>(table: TTable) {
      let built: any
      let sqlText = ''
      const params: any[] = []
      /** The `id` of each row handed to `values()`, where the caller set one. */
      let insertedKeys: unknown[] = []
      // Set when `values()` is handed an empty batch. There is no statement to
      // run in that case, so every terminal below answers from here instead of
      // executing a stand-in query. See #1097.
      let noRows = false

      /**
       * What the dialect returns for an insert that affected no rows.
       *
       * Postgres gives `[]` for an insert without RETURNING, so an empty batch
       * is indistinguishable from a real one that inserted nothing — which is
       * the point. The bun:sqlite wrapper reports `{ changes, lastInsertRowid }`
       * instead, so it gets zeros.
       */
      const emptyInsertResult = (): any => (isPostgres ? [] : { changes: 0, lastInsertRowid: 0 })

      /**
       * The `.returning(...)` / `.returningAll()` surface for an empty batch.
       *
       * Mirrors the real one's method set so `.returning('id').first()` still
       * resolves rather than throwing "first is not a function". No rows were
       * inserted, so the row accessors answer empty and the *OrFail pair throws
       * the same message they throw when a real RETURNING comes back empty.
       */
      const emptyReturningBuilder = (): any => {
        const noRow = async (): Promise<any> => undefined
        const noRowOrFail = async (): Promise<any> => {
          throw new Error('Insert with RETURNING returned no rows')
        }
        return {
          where: () => emptyReturningBuilder(),
          andWhere: () => emptyReturningBuilder(),
          orWhere: () => emptyReturningBuilder(),
          orderBy: () => emptyReturningBuilder(),
          limit: () => emptyReturningBuilder(),
          offset: () => emptyReturningBuilder(),
          toSQL: () => makeExecutableQuery(null as any, '') as any,
          execute: async () => [],
          get: async () => [],
          first: noRow,
          executeTakeFirst: noRow,
          firstOrFail: noRowOrFail,
          executeTakeFirstOrThrow: noRowOrFail,
        }
      }
      const isPostgres = config.dialect === 'postgres'

      /**
       * `.returning(...)` on MySQL, which has no RETURNING clause.
       *
       * The insert runs as written; the rows come back from a second statement
       * keyed on what the server assigned. `LAST_INSERT_ID()` is scoped to this
       * connection and reports the *first* id a multi-row insert generated, and
       * InnoDB allocates that statement's ids consecutively - so `affectedRows`
       * gives the range. That is documented behaviour under the default
       * `innodb_autoinc_lock_mode`, and it is the same assumption every MySQL
       * ORM makes for this.
       *
       * An insert that supplied its own keys gets `0` back, since nothing was
       * generated. Those rows are read by the keys they were given instead,
       * which is exact.
       */
      const mysqlReturningBuilder = (cols: string[]): any => {
        const key = 'id'
        /*
         * Flattened, because `.returning(['id', 'uuid'])` arrives as one array
         * argument rather than as two. The Postgres path joins straight into
         * the statement, where an array-of-array flattens to the same text by
         * accident; quoting each name does not, and produced the single
         * identifier `id,uuid,kind` - "Unknown column" naming all of them at
         * once.
         */
        const names = (cols as unknown[]).flat(2).map(String).filter(Boolean)
        const wanted = names.length > 0 && !names.includes('*') ? names.map(column => quoteId(column)).join(', ') : '*'

        const run = async (): Promise<any[]> => {
          const inserted = await runWithHooks<any>(_sql.unsafe(sqlText, params), 'insert')
          const first = Number((inserted as any)?.lastInsertRowid ?? 0)
          const affected = Math.max(1, Number((inserted as any)?.affectedRows ?? 1))

          const given = insertedKeys.filter(value => value !== undefined && value !== null)

          const read = first > 0
            ? _sql.unsafe(
                `SELECT ${wanted} FROM ${quoteId(String(table))} WHERE ${quoteId(key)} >= ? AND ${quoteId(key)} < ? ORDER BY ${quoteId(key)} ASC`,
                [first, first + affected],
              )
            : given.length > 0
              ? _sql.unsafe(
                  `SELECT ${wanted} FROM ${quoteId(String(table))} WHERE ${quoteId(key)} IN (${given.map(() => '?').join(', ')}) ORDER BY ${quoteId(key)} ASC`,
                  given,
                )
              : null

          if (!read)
            return []

          const rows = await read.execute()

          return Array.isArray(rows) ? rows : []
        }

        const runFirst = async (): Promise<any> => (await run())[0]

        return {
          where: () => this,
          andWhere: () => this,
          orWhere: () => this,
          orderBy: () => this,
          limit: () => this,
          offset: () => this,
          toSQL: () => makeExecutableQuery(_sql.unsafe(sqlText, params), sqlText) as any,
          execute: run,
          get: run,
          first: runFirst,
          executeTakeFirst: runFirst,
          async firstOrFail() {
            const row = await runFirst()
            if (!row)
              throw new Error('Insert with RETURNING returned no rows')
            return row
          },
          async executeTakeFirstOrThrow() {
            const row = await runFirst()
            if (!row)
              throw new Error('Insert with RETURNING returned no rows')
            return row
          },
        }
      }

      // Quote identifier based on dialect. SQLite supports double-quoted
      // identifiers per the SQL standard; emitting them (with internal
      // quote-doubling) closes a SQL-injection vector that existed when
      // column/table names came from user input. Previously the SQLite
      // branch was a no-op (`(id) => id`), so any caller that
      // interpolated `Object.keys(req.body)` straight into an INSERT
      // could smuggle SQL through the identifier slot
      // (stacksjs/stacks#1858 Q-7).
      const quoteId = isPostgres
        ? (id: string): string => `"${String(id).replace(/"/g, '""')}"`
        : isMysqlLike(config.dialect)
          ? (id: string): string => `\`${String(id).replace(/`/g, '``')}\``
          : (id: string): string => `"${String(id).replace(/"/g, '""')}"`

      // Get placeholder based on dialect
      const getPlaceholder = isPostgres
        ? (index: number): string => `$${index + 1}`
        : (_index: number): string => '?'

      return {
        values(data: Partial<any> | Partial<any>[]) {
          const rows = reshapeTemporal(String(table), Array.isArray(data) ? data : [data])
          const rowCount = rows.length

          // Kept for MySQL's `.returning(...)`, which reads the rows back: an
          // insert that supplied its own keys generates nothing, so
          // `LAST_INSERT_ID()` is 0 and these are what identify the rows.
          insertedKeys = rows.map(row => (row as any)?.id)
          if (rowCount === 0) {
            // Inserting no rows is a no-op, not a query. This used to run
            // `SELECT 1` as a stand-in, which meant `.execute()` resolved to a
            // fabricated row — `[{ '?column?': 1 }]` on Postgres, `[{ '1': 1 }]`
            // on SQLite — so a caller checking `result.length` saw 1 where the
            // truth was 0, a query hook fired for an insert that never
            // happened, and `.returning(...)` appended RETURNING to `SELECT 1`
            // and died on a syntax error. See #1097.
            //
            // `values(rows)` where `rows` came back empty is ordinary calling
            // code — the seeder scaffold this package generates is written that
            // way — so this answers empty rather than throwing.
            noRows = true
            built = null
            sqlText = ''
            params.length = 0
            return this
          }
          noRows = false

          const firstRow = rows[0]
          const keys = Object.keys(firstRow)
          const colCount = keys.length

          // Pre-allocate params array
          const totalParams = rowCount * colCount
          params.length = totalParams

          // Build column list for both single and multi-row paths
          const columnList = isPostgres
            ? keys.map(k => quoteId(k)).join(',')
            : keys.join(',')

          if (rowCount === 1) {
            // Ultra-fast path for single row - build SQL in one shot
            if (!isPostgres) {
              // SQLite/MySQL: `?` placeholders. Quote the table + column
              // identifiers (like the multi-row and Postgres paths) — the
              // previous unquoted form let a column name smuggle SQL through
              // this common single-row path. See stacksjs/bun-query-builder#1033.
              let cols = quoteId(keys[0])
              let placeholders = '?'
              params[0] = firstRow[keys[0]]
              for (let c = 1; c < colCount; c++) {
                cols += `,${quoteId(keys[c])}`
                placeholders += ',?'
                params[c] = firstRow[keys[c]]
              }
              sqlText = `INSERT INTO ${quoteId(table)}(${cols})VALUES(${placeholders})`
            }
            else {
              // PostgreSQL: quoted identifiers + $N placeholders
              sqlText = `INSERT INTO ${quoteId(table)}(${columnList})VALUES(`
              for (let c = 0; c < colCount; c++) {
                if (c > 0)
                  sqlText += ','
                sqlText += getPlaceholder(c)
                params[c] = firstRow[keys[c]]
              }
              sqlText += ')'
            }
          }
          else {
            // Multi-row path
            const columnList = keys.map(k => quoteId(k)).join(',')
            sqlText = `INSERT INTO ${quoteId(table)}(${columnList})VALUES`
            let pidx = 0
            for (let r = 0; r < rowCount; r++) {
              const row = rows[r]
              if (r === 0) {
                sqlText += '('
              }
              else {
                sqlText += '),('
              }

              for (let c = 0; c < colCount; c++) {
                if (c > 0)
                  sqlText += ','
                sqlText += getPlaceholder(pidx)
                params[pidx++] = row[keys[c]]
              }
            }
            sqlText += ')'
          }

          // Defer unsafe() call - execute() will use _prepareStatement if available
          if (!_sql._prepareStatement) {
            built = _sql.unsafe(sqlText, params)
          }
          return this
        },
        returning(...cols: (keyof any & string)[]) {
          // Nothing was inserted, so there is nothing to return. Without this
          // the RETURNING clause was appended to the `SELECT 1` stand-in and
          // the statement failed to parse.
          if (noRows)
            return emptyReturningBuilder()

          /*
           * MySQL has no RETURNING, so the read is a second statement.
           *
           * Postgres and SQLite both take `INSERT ... RETURNING`; MySQL does
           * not, and emitted there it is a syntax error at the end of an
           * otherwise valid insert - "check the manual ... near 'RETURNING id'".
           * The application cannot avoid it either: an insert whose id nothing
           * can read is an insert whose row nothing can reference, so every
           * create path in a codebase uses it.
           *
           * So on MySQL the insert runs as written and the row is read back by
           * the key the server just assigned. `LAST_INSERT_ID()` is per
           * connection and per statement, which is what makes this safe under
           * concurrency: another session's insert cannot be seen here.
           */
          if (isMysqlLike(config.dialect))
            return mysqlReturningBuilder(cols)

          // Append RETURNING clause to the existing SQL
          const returningSql = `${sqlText} RETURNING ${cols.join(', ')}`
          const q = _sql.unsafe(returningSql, params)
          // The return type is SelectQueryBuilder, so the row-fetching methods
          // (get/first/firstOrFail/executeTakeFirst) must exist at runtime —
          // previously only execute()/toSQL() did, so the typed
          // `.returning('id').first()` threw "first is not a function".
          const runFirst = async () => {
            const rows = await runWithHooks<any[]>(q, 'insert')
            return Array.isArray(rows) ? rows[0] : rows
          }
          return {
            where: () => this,
            andWhere: () => this,
            orWhere: () => this,
            orderBy: () => this,
            limit: () => this,
            offset: () => this,
            toSQL: () => makeExecutableQuery(q, returningSql) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
            get: () => runWithHooks<any[]>(q, 'insert'),
            first: runFirst,
            executeTakeFirst: runFirst,
            async firstOrFail() {
              const row = await runFirst()
              if (!row)
                throw new Error('Insert with RETURNING returned no rows')
              return row
            },
            async executeTakeFirstOrThrow() {
              const row = await runFirst()
              if (!row)
                throw new Error('Insert with RETURNING returned no rows')
              return row
            },
          }
        },
        toSQL() {
          if (noRows)
            return makeExecutableQuery(null as any, '') as any
          if (!built) built = _sql.unsafe(sqlText, params)
          return makeExecutableQuery(built, sqlText) as any
        },
        execute() {
          if (noRows)
            return Promise.resolve(emptyInsertResult())
          // Ultra-fast path: use _prepareStatement to skip unsafe() and runWithHooks overhead
          const hooks = activeHooks()
          const hasHooks = hooks && (hooks.onQueryStart || hooks.onQueryEnd || hooks.onQueryError || hooks.startSpan || hooks.beforeCreate || hooks.afterCreate || hasSlowQueryHook(hooks))
          if (!hasHooks) {
            const prepareFn = _sql._prepareStatement
            if (prepareFn) {
              const stmt = prepareFn(sqlText)
              return params.length > 0 ? stmt.run(...params) : stmt.run()
            }
          }
          if (!built) built = _sql.unsafe(sqlText, params)
          return runWithHooks(built, 'insert')
        },
        async executeTakeFirst() {
          if (noRows)
            return emptyInsertResult()
          if (!built) built = _sql.unsafe(sqlText, params)
          const result = await runWithHooks(built, 'insert')
          return result
        },
        async executeTakeFirstOrThrow() {
          if (noRows)
            throw new Error('Insert failed')
          if (!built) built = _sql.unsafe(sqlText, params)
          const result = await runWithHooks(built, 'insert')
          if (!result)
            throw new Error('Insert failed')
          return result
        },
        returningAll() {
          // As in returning(): no rows inserted, nothing to return.
          if (noRows)
            return emptyReturningBuilder()
          const returningSql = `${sqlText} RETURNING *`
          const q = _sql.unsafe(returningSql, params)
          const runFirst = async () => {
            const result = await runWithHooks<any[]>(q, 'insert')
            return Array.isArray(result) ? result[0] : result
          }
          return {
            toSQL: () => makeExecutableQuery(q, returningSql) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
            get: () => runWithHooks<any[]>(q, 'insert'),
            first: runFirst,
            executeTakeFirst: runFirst,
            async firstOrFail() {
              const row = await runFirst()
              if (!row)
                throw new Error('Insert with RETURNING returned no rows')
              return row
            },
            async executeTakeFirstOrThrow() {
              const row = await runFirst()
              if (!row)
                throw new Error('Insert with RETURNING returned no rows')
              return row
            },
          } as any
        },
      } as any as TypedInsertQueryBuilder<DB, TTable>
    },
    updateTable(table) {
      let built: any
      const params: any[] = []

      // Quote identifier with internal-quote doubling so identifiers
      // containing quote characters can't terminate the quoted string
      // (stacksjs/stacks#1858 Q-7 defense-in-depth).
      const quoteId = (identifier: string): string => {
        const s = String(identifier)
        if (isMysqlLike(config.dialect))
          return `\`${s.replace(/`/g, '``')}\``
        return `"${s.replace(/"/g, '""')}"`
      }

      let sqlText = `UPDATE ${quoteId(String(table))}`

      /**
       * Whether this builder has already emitted a predicate — which is the
       * thing the keyword actually depends on.
       *
       * It used to be inferred by testing the whole statement for
       * `/\bWHERE\b/`, and plenty of text that is not this builder's predicate
       * satisfies that: a subquery inside `set()`, a table named `where`, a
       * column named `where`. The first real predicate then came out as `AND`
       * and fused onto the SET expression:
       *
       *     SET "flag" = (SELECT ... WHERE x.id > 3) AND "id" = ?
       *
       * which leaves the UPDATE with no WHERE at all. Postgres rejects that
       * only when the types happen not to line up; where the SET target is
       * boolean, or on SQLite, it runs against every row and writes the
       * predicate into the value. See #1113.
       *
       * A boolean cannot be fooled by any of that.
       */
      let hasPredicate = false
      const appendPredicate = (predicate: string): void => {
        sqlText = `${sqlText} ${hasPredicate ? 'AND' : 'WHERE'} ${predicate}`
        hasPredicate = true
      }

      return {
        set(values) {
          const shaped = reshapeTemporal(String(table), [values as Record<string, unknown>])[0] as typeof values
          const keys = Object.keys(shaped)
          const len = keys.length
          const setClauses: string[] = Array.from({ length: len })
          for (let i = 0; i < len; i++) {
            const key = keys[i]
            const value = (shaped as any)[key]
            if (isRawExpression(value)) {
              setClauses[i] = `${quoteId(key)} = ${value.raw}`
            }
            else if (isBoundSqlExpression(value)) {
              const expression = renderBoundSqlExpression(value, params.length + 1)
              setClauses[i] = `${quoteId(key)} = ${expression.text}`
              params.push(...expression.parameters)
            }
            else {
              setClauses[i] = `${quoteId(key)} = ${getPlaceholder(params.length + 1)}`
              params.push(value)
            }
          }
          sqlText = `${sqlText} SET ${setClauses.join(', ')}`
          built = _sql.unsafe(sqlText, params)
          return this
        },
        where(expr: any, op?: string, value?: any) {
          // Handle 3-arg format: where('column', '=', value)
          if (op !== undefined && (typeof expr === 'string' || isRawExpression(expr) || isBoundSqlExpression(expr))) {
            const safeOperator = assertSafeWhereOperator(op, 'updateTable.where')
            let left: string
            if (typeof expr === 'string') {
              left = quoteId(expr)
            }
            else if (isRawExpression(expr)) {
              left = expr.raw
            }
            else {
              const expression = renderBoundSqlExpression(expr, params.length + 1)
              left = expression.text
              params.push(...expression.parameters)
            }
            // IN takes a list, not a value. Parity with the select builder
            // (~line 4401): without this the array is bound to one placeholder
            // and the statement is `col IN $1`, which every server rejects.
            // The select builder was fixed for this in #1013 and writes were
            // left behind, so `.where('id', 'in', ids)` on an update or a
            // delete failed while the same call on a select worked - which
            // reads as a bug in the caller rather than in the builder.
            if (safeOperator.toLowerCase() === 'in' || safeOperator.toLowerCase() === 'not in') {
              const values = Array.isArray(value) ? value : [value]
              const placeholders = getPlaceholders(values.length, params.length + 1)
              appendPredicate(`${left} ${safeOperator.toUpperCase()} (${placeholders})`)
              params.push(...values)
              built = _sql.unsafe(sqlText, params)
              return this
            }

            const paramIndex = params.length + 1
            appendPredicate(`${left} ${safeOperator} ${getPlaceholder(paramIndex)}`)
            params.push(value)
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // Handle array format: where(['column', 'op', value])
          if (Array.isArray(expr)) {
            const [col, op, val] = expr
            const safeOperator = assertSafeWhereOperator(op, 'updateTable.where')

            if (safeOperator.toLowerCase() === 'in' || safeOperator.toLowerCase() === 'not in') {
              const values = Array.isArray(val) ? val : [val]
              const placeholders = getPlaceholders(values.length, params.length + 1)
              appendPredicate(`${quoteId(String(col))} ${safeOperator.toUpperCase()} (${placeholders})`)
              params.push(...values)
              built = _sql.unsafe(sqlText, params)
              return this
            }

            const paramIndex = params.length + 1
            appendPredicate(`${quoteId(String(col))} ${safeOperator} ${getPlaceholder(paramIndex)}`)
            params.push(val)
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // A lone SQL fragment: `where(raw('id = 1'))`, `where(sql\`...\`)`.
          // The declared signature accepts SqlFragment, so this is an
          // advertised call — and it matched no branch, fell through to the
          // bare `return this` below, and left the UPDATE with no WHERE at all.
          // Every row was rewritten, silently, and the full count was reported
          // as success. Handled before the object branch because a bound
          // expression is an object and would otherwise be read as the column
          // map `{ sql: ... }`. See #1101.
          if (isRawExpression(expr)) {
            appendPredicate(expr.raw)
            built = _sql.unsafe(sqlText, params)
            return this
          }
          if (isBoundSqlExpression(expr)) {
            const rendered = renderBoundSqlExpression(expr, params.length + 1)
            appendPredicate(rendered.text)
            params.push(...rendered.parameters)
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // Handle object format: where({ column: value })
          if (expr && typeof expr === 'object') {
            const keys = Object.keys(expr)
            if (keys.length === 0)
              throw new TypeError('[query-builder] updateTable.where({}): an empty object is not a filter. Pass a condition, or drop the where() call if updating every row is intended.')
            const conditions = keys.map(key => renderColumnCondition(quoteId(key), (expr as any)[key], params))
            appendPredicate(conditions.join(' AND '))
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // Nothing above could turn this into a predicate. Refuse it.
          //
          // Returning `this` unchanged meant `where(undefined)` and
          // `where(null)` produced an UPDATE with no WHERE, so a filter the
          // caller believed they had applied rewrote the whole table without
          // an error. A write builder is the wrong place to read "I could not
          // understand your filter" as "match every row". The select builder
          // dropped this same fall-through in #1083; the write builders kept
          // it. See #1101.
          throw new TypeError(`[query-builder] updateTable.where(): expected a condition, got ${expr === null ? 'null' : typeof expr}. Refusing to run an UPDATE with no WHERE — drop the where() call if updating every row is intended.`)
        },
        whereNull(column: string) {
          appendPredicate(`${quoteId(String(column))} IS NULL`)
          built = _sql.unsafe(sqlText, params)
          return this
        },
        whereNotNull(column: string) {
          appendPredicate(`${quoteId(String(column))} IS NOT NULL`)
          built = _sql.unsafe(sqlText, params)
          return this
        },
        returning(...cols) {
          const parent: any = this
          // Render at execute time, not here.
          //
          // This used to freeze the statement text immediately and return an
          // object whose where/andWhere/orWhere/orderBy/limit/offset were
          // literally `() => obj` — so every filter applied after returning()
          // was discarded and the UPDATE ran against the whole table, silently,
          // while `.executeTakeFirst()` handed back a row it had never filtered
          // to. `returning()` is typed as SelectQueryBuilder, which declares all
          // of those, so the broken order type-checks. See #1110.
          //
          // Deferring also fixes the aliasing form, where the returning handle
          // is held while the parent gains a predicate.
          const retText = () => `${sqlText} RETURNING ${cols.join(', ')}`
          const build = () => (params.length > 0 ? _sql.unsafe(retText(), params) : _sql.unsafe(retText()))

          /*
           * MySQL has no RETURNING on an UPDATE either, so the rows are read
           * after the write, by the predicate the write used.
           *
           * The predicate has to still select them - an update that changes a
           * column the WHERE tests would return nothing here - which is the one
           * shape this cannot serve and Postgres can. It is also a shape almost
           * nobody writes: the predicate is nearly always a key.
           */
          const runMysql = async (): Promise<any[]> => {
            const hasWhere = /\sWHERE\s/i.test(sqlText)
            const where = hasWhere ? sqlText.slice(sqlText.search(/\sWHERE\s/i) + 1) : ''
            // The SET clause's parameters come first in `params`; the predicate
            // only needs its own, so the SET's are dropped from the front.
            const predicateParams = params.slice(params.length - (where.match(/\?|\$\d+/g)?.length ?? 0))
            const key = quoteId('id')

            /*
             * The rows are identified *before* the update, not after.
             *
             * Reading afterwards with the same predicate looks equivalent and
             * is not: an update whose predicate tests a column it is about to
             * change matches nothing the second time. `spendRecoveryCode` is
             * exactly that shape - `SET used_at = now() ... WHERE used_at IS
             * NULL`, whose whole purpose is that it can only match once - and
             * it silently reported that no code had been spent, which reads as
             * a wrong recovery code to whoever typed it.
             */
            const found = await (predicateParams.length > 0
              ? _sql.unsafe(`SELECT ${key} FROM ${quoteId(String(table))}${hasWhere ? ` ${where}` : ''}`, predicateParams)
              : _sql.unsafe(`SELECT ${key} FROM ${quoteId(String(table))}${hasWhere ? ` ${where}` : ''}`)).execute().catch(() => [])

            const ids = (Array.isArray(found) ? found : []).map((row: any) => row?.id).filter((id: unknown) => id !== undefined && id !== null)

            await runWithHooks<any>(params.length > 0 ? _sql.unsafe(sqlText, params) : _sql.unsafe(sqlText), 'update')

            if (ids.length === 0)
              return []

            const selected = `SELECT ${cols.join(', ')} FROM ${quoteId(String(table))} WHERE ${key} IN (${ids.map(() => '?').join(', ')})`
            const rows = await _sql.unsafe(selected, ids).execute()

            return Array.isArray(rows) ? rows : []
          }

          const run = (): Promise<any[]> => (isMysqlLike(config.dialect)
            ? runMysql()
            : runWithHooks<any[]>(build(), 'update'))

          const runFirst = async () => {
            const rows = await run()
            return Array.isArray(rows) ? rows[0] : rows
          }
          // Not expressible on this builder. Silently ignoring them is what
          // made a `.limit(1)` destructive write hit every row.
          const unsupported = (name: string) => (): never => {
            throw new TypeError(`[query-builder] updateTable.returning(...).${name}() is not supported — an UPDATE cannot be ordered or limited through this builder. Apply the filter with where() instead.`)
          }
          const obj: any = {
            // Delegate to the builder that owns the statement, then keep
            // chaining from here. Consecutive predicates join with AND, which
            // is what andWhere means.
            where: (...args: any[]) => { parent.where(...args); return obj },
            andWhere: (...args: any[]) => { parent.where(...args); return obj },
            whereNull: (...args: any[]) => { parent.whereNull(...args); return obj },
            whereNotNull: (...args: any[]) => { parent.whereNotNull(...args); return obj },
            orWhere: unsupported('orWhere'),
            orderBy: unsupported('orderBy'),
            limit: unsupported('limit'),
            offset: unsupported('offset'),
            toSQL: () => makeExecutableQuery(build(), retText()) as any,
            execute: run,
            // returning() is typed as SelectQueryBuilder — expose the
            // row-fetching methods so `.returning('id').first()` works.
            get: run,
            first: runFirst,
            executeTakeFirst: runFirst,
            async firstOrFail() {
              const row = await runFirst()
              if (!row)
                throw new Error('Update with RETURNING returned no rows')
              return row
            },
            async executeTakeFirstOrThrow() {
              const row = await runFirst()
              if (!row)
                throw new Error('Update with RETURNING returned no rows')
              return row
            },
          }
          return obj
        },
        toSQL() {
          if (!built) {
            built = params.length > 0
              ? _sql.unsafe(sqlText, params)
              : _sql.unsafe(sqlText)
          }
          return makeExecutableQuery(built, sqlText) as any
        },
        async execute() {
          const result = await runWithHooks(built, 'update')
          return mutationCount(result)
        },
        async executeTakeFirst() {
          const result = mutationCount(await runWithHooks(built, 'update'))
          return { numUpdatedRows: result }
        },
        async executeTakeFirstOrThrow() {
          const result = mutationCount(await runWithHooks(built, 'update'))
          if (result === 0)
            throw new Error('No rows updated')
          return { numUpdatedRows: result }
        },
        returningAll() {
          // Deferred for the same reason as returning(): holding this handle
          // while the parent gains a predicate must not execute the statement
          // as it stood beforehand. See #1110.
          const retAllText = () => `${sqlText} RETURNING *`
          const build = () => (params.length > 0 ? _sql.unsafe(retAllText(), params) : _sql.unsafe(retAllText()))
          return {
            toSQL: () => makeExecutableQuery(build(), retAllText()) as any,
            execute: () => runWithHooks<any[]>(build(), 'update'),
            async executeTakeFirst() {
              const result = await runWithHooks<any[]>(build(), 'update')
              return Array.isArray(result) ? result[0] : result
            },
            async executeTakeFirstOrThrow() {
              const result = await runWithHooks<any[]>(build(), 'update')
              const first = Array.isArray(result) ? result[0] : result
              if (!first)
                throw new Error('Update with RETURNING failed')
              return first
            },
          } as any
        },
      }
    },
    deleteFrom(table) {
      // Quote identifier with internal-quote doubling — see
      // `updateTable` / `insertInto` quoteId for the rationale
      // (stacksjs/stacks#1858 Q-7).
      const quoteId = (identifier: string): string => {
        const s = String(identifier)
        if (isMysqlLike(config.dialect))
          return `\`${s.replace(/`/g, '``')}\``
        return `"${s.replace(/"/g, '""')}"`
      }

      const quotedTable = quoteId(String(table))
      let sqlText = `DELETE FROM ${quotedTable}`
      let built: any = null
      const delParams: any[] = []
      let whereCondition: any = null

      // First predicate emits ` WHERE `; subsequent ones emit ` AND `.
      // Without this, chained `.where('a', '=', 1).where('b', '=', 2)`
      // compiled to `... WHERE a = ? WHERE b = ?` and SQLite 500'd
      // with `near "WHERE": syntax error`.
      // See https://github.com/stacksjs/bun-query-builder/issues/1015
      //
      // Tracked as builder state rather than read back out of the statement:
      // `DELETE FROM "where"` matches /\bWHERE\b/ too, and inferring it from
      // the text turned the first predicate into `AND` — `DELETE FROM "where"
      // AND "id" = ?`. Mirrors updateTable(). See #1113.
      let hasPredicate = false
      const appendPredicate = (predicate: string): void => {
        sqlText += ` ${hasPredicate ? 'AND' : 'WHERE'} ${predicate}`
        hasPredicate = true
      }

      const ensureDelBuilt = () => {
        if (built === null) {
          built = delParams.length > 0
            ? _sql.unsafe(sqlText, delParams)
            : _sql.unsafe(sqlText)
        }
        return built
      }

      return {
        where(expr: any, op?: string, value?: any) {
          whereCondition = expr
          // Support 3-arg format: where(column, operator, value)
          if (typeof expr === 'string' && op !== undefined) {
            // Validated rather than interpolated raw. The operator lands in the
            // statement text, so an unchecked one is an injection point in a
            // DELETE — the one statement where getting it wrong is unrecoverable.
            // updateTable has always asserted here; this builder did not.
            const safeOperator = assertSafeWhereOperator(op, 'deleteFrom.where')

            // IN takes a list. Parity with the select builder (~line 4401) and
            // with updateTable: binding an array to a single placeholder emits
            // `col IN $1`, which every server rejects.
            if (safeOperator.toLowerCase() === 'in' || safeOperator.toLowerCase() === 'not in') {
              const values = Array.isArray(value) ? value : [value]
              const placeholders = getPlaceholders(values.length, delParams.length + 1)
              appendPredicate(`${quoteId(expr)} ${safeOperator.toUpperCase()} (${placeholders})`)
              delParams.push(...values)
              built = null
              return this
            }

            const paramIndex = delParams.length + 1
            appendPredicate(`${quoteId(expr)} ${safeOperator} ${getPlaceholder(paramIndex)}`)
            delParams.push(value)
            built = null
            return this
          }
          // Support array format: where(['column', 'op', value])
          if (Array.isArray(expr)) {
            const [col, oper, val] = expr
            const safeOperator = assertSafeWhereOperator(oper, 'deleteFrom.where')

            if (safeOperator.toLowerCase() === 'in' || safeOperator.toLowerCase() === 'not in') {
              const values = Array.isArray(val) ? val : [val]
              const placeholders = getPlaceholders(values.length, delParams.length + 1)
              appendPredicate(`${quoteId(String(col))} ${safeOperator.toUpperCase()} (${placeholders})`)
              delParams.push(...values)
              built = null
              return this
            }

            const paramIndex = delParams.length + 1
            appendPredicate(`${quoteId(String(col))} ${safeOperator} ${getPlaceholder(paramIndex)}`)
            delParams.push(val)
            built = null
            return this
          }
          // A lone SQL fragment, handled before the object branch for the same
          // reason as in updateTable.where: a bound expression is an object and
          // would otherwise be read as the column map `{ sql: ... }`. Rendering
          // it here also fixes it — routed through applyWhere() below, a
          // fragment was interpolated as a bound value, so Postgres rejected
          // `where(raw('id = 1'))` with "invalid input syntax for type
          // boolean". The signature accepts SqlFragment, so it has to work.
          if (isRawExpression(expr)) {
            appendPredicate(expr.raw)
            built = null
            return this
          }
          if (isBoundSqlExpression(expr)) {
            const rendered = renderBoundSqlExpression(expr, delParams.length + 1)
            appendPredicate(rendered.text)
            delParams.push(...rendered.parameters)
            built = null
            return this
          }

          // Object format: where({ id: 1 })
          if (expr && typeof expr === 'object') {
            const keys = Object.keys(expr)
            if (keys.length === 0)
              throw new TypeError('[query-builder] deleteFrom.where({}): an empty object is not a filter. Pass a condition, or drop the where() call if deleting every row is intended.')
            const conditions = keys.map(key => renderColumnCondition(quoteId(key), (expr as any)[key], delParams))
            appendPredicate(conditions.join(' AND '))
            built = null
            return this
          }

          // Nothing above could turn this into a predicate.
          //
          // This previously fell through to applyWhere({}, ..., expr), whose
          // first line is `if (!expr) return q` — so `where(undefined)` and
          // `where(null)` appended nothing and the DELETE removed every row,
          // returning the count as though the filter had been honoured. See
          // #1101, and #1083 where the select builder lost the same
          // fall-through.
          throw new TypeError(`[query-builder] deleteFrom.where(): expected a condition, got ${expr === null ? 'null' : typeof expr}. Refusing to run a DELETE with no WHERE — drop the where() call if deleting every row is intended.`)
        },
        whereNull(column: string) {
          appendPredicate(`${quoteId(String(column))} IS NULL`)
          built = null
          return this
        },
        whereNotNull(column: string) {
          appendPredicate(`${quoteId(String(column))} IS NOT NULL`)
          built = null
          return this
        },
        returning(...cols) {
          const parent: any = this
          // Rendered at execute time. The frozen-text form, with the no-op
          // filter stubs below it, meant `.returning('id').where({ id: 1 })`
          // emptied the table and returned every deleted row as though the
          // filter had applied. See #1110.
          const retText = () => `${sqlText} RETURNING ${cols.join(', ')}`
          const build = () => (delParams.length > 0 ? _sql.unsafe(retText(), delParams) : _sql.unsafe(retText()))
          // Fire the same delete hooks execute() does. Without this, adding
          // `.returning(...)` to a delete skipped beforeDelete/afterDelete
          // entirely, so an application-level delete guard — the usual reason
          // to implement beforeDelete at all — could be walked straight past.
          const runDelete = async (): Promise<any[]> => {
            await activeHooks()?.beforeDelete?.({ table: String(table), where: whereCondition })

            /*
             * MySQL has no RETURNING on a DELETE, so the rows are read *before*
             * the write - the only order that can work, since afterwards they
             * are gone. Both statements carry the same predicate and the same
             * parameters, so what is returned is what was removed.
             */
            const rows = isMysqlLike(config.dialect)
              ? await (async (): Promise<any[]> => {
                  const from = sqlText.slice(sqlText.search(/\sFROM\s/i) + 1)
                  const selected = `SELECT ${cols.join(', ')} ${from}`
                  const found = await (delParams.length > 0 ? _sql.unsafe(selected, delParams) : _sql.unsafe(selected)).execute()

                  await runWithHooks<any>(delParams.length > 0 ? _sql.unsafe(sqlText, delParams) : _sql.unsafe(sqlText), 'delete')

                  return Array.isArray(found) ? found : []
                })()
              : await runWithHooks<any[]>(build(), 'delete')

            try {
              await activeHooks()?.afterDelete?.({ table: String(table), where: whereCondition, result: rows })
            }
            catch {}
            return rows
          }
          const runFirst = async () => {
            const rows = await runDelete()
            return Array.isArray(rows) ? rows[0] : rows
          }
          const unsupported = (name: string) => (): never => {
            throw new TypeError(`[query-builder] deleteFrom.returning(...).${name}() is not supported — a DELETE cannot be ordered or limited through this builder. Narrow it with where() instead.`)
          }
          const obj: any = {
            where: (...args: any[]) => { parent.where(...args); return obj },
            andWhere: (...args: any[]) => { parent.where(...args); return obj },
            whereNull: (...args: any[]) => { parent.whereNull(...args); return obj },
            whereNotNull: (...args: any[]) => { parent.whereNotNull(...args); return obj },
            orWhere: unsupported('orWhere'),
            orderBy: unsupported('orderBy'),
            limit: unsupported('limit'),
            offset: unsupported('offset'),
            toSQL: () => makeExecutableQuery(build(), retText()) as any,
            execute: () => runDelete(),
            // returning() is typed as SelectQueryBuilder — expose row fetchers.
            get: () => runDelete(),
            first: runFirst,
            executeTakeFirst: runFirst,
            async firstOrFail() {
              const row = await runFirst()
              if (!row)
                throw new Error('Delete with RETURNING returned no rows')
              return row
            },
            async executeTakeFirstOrThrow() {
              const row = await runFirst()
              if (!row)
                throw new Error('Delete with RETURNING returned no rows')
              return row
            },
          }
          return obj
        },
        toSQL() {
          return makeExecutableQuery(ensureDelBuilt(), sqlText) as any
        },
        async execute() {
          try {
            await activeHooks()?.beforeDelete?.({ table: String(table), where: whereCondition })
          }
          catch (err) {
            throw err
          }

          const result = mutationCount(await runWithHooks(ensureDelBuilt(), 'delete'))

          try {
            await activeHooks()?.afterDelete?.({ table: String(table), where: whereCondition, result })
          }
          catch {}

          return result
        },
        async executeTakeFirst() {
          const result = mutationCount(await runWithHooks(ensureDelBuilt(), 'delete'))
          return { numDeletedRows: result }
        },
        async executeTakeFirstOrThrow() {
          const result = mutationCount(await runWithHooks(ensureDelBuilt(), 'delete'))
          if (result === 0)
            throw new Error('No rows deleted')
          return { numDeletedRows: result }
        },
        returningAll() {
          // Deferred, as returning() is — see #1110.
          const retAllText = () => `${sqlText} RETURNING *`
          const build = () => (delParams.length > 0 ? _sql.unsafe(retAllText(), delParams) : _sql.unsafe(retAllText()))
          return {
            toSQL: () => makeExecutableQuery(build(), retAllText()) as any,
            execute: () => runWithHooks<any[]>(build(), 'delete'),
            async executeTakeFirst() {
              const result = await runWithHooks<any[]>(build(), 'delete')
              return Array.isArray(result) ? result[0] : result
            },
            async executeTakeFirstOrThrow() {
              const result = await runWithHooks<any[]>(build(), 'delete')
              const first = Array.isArray(result) ? result[0] : result
              if (!first)
                throw new Error('Delete with RETURNING failed')
              return first
            },
          } as any
        },
      }
    },
    table(tableName) {
      const self = this as any
      return {
        insert(data) {
          return self.insertInto(tableName).values(data)
        },
        update(values) {
          return self.updateTable(tableName).set(values)
        },
        delete() {
          return self.deleteFrom(tableName)
        },
        select(...columns) {
          if (columns.length === 0) {
            return self.selectFrom(tableName)
          }
          return self.select(tableName, ...columns)
        },
      }
    },
    sql: _sql,
    raw(strings: TemplateStringsArray, ...values: any[]) {
      return _sql(strings, ...values)
    },
    simple(strings: TemplateStringsArray, ...values: any[]) {
      return (_sql(strings, ...values) as any).simple()
    },
    async advisoryLock(key: number | string): Promise<void> {
      if (config.dialect === 'postgres') {
        const k = advisoryLockKey(key)
        const q = _sql`SELECT pg_advisory_lock(${k})`
        await runWithHooks<any[]>(q, 'raw')
        return
      }
      if (isMysqlLike(config.dialect)) {
        // MySQL has `GET_LOCK(name, timeout)`. Wait indefinitely
        // (timeout=-1) to match Postgres `pg_advisory_lock` semantics.
        const lockName = `bqb:${String(key)}`
        const q = _sql`SELECT GET_LOCK(${lockName}, -1) AS ok`
        await runWithHooks<any[]>(q, 'raw')
        return
      }
      // SQLite has no advisory-lock primitive. Refusing loud is
      // safer than silently returning — distributed-coordination
      // callers would otherwise believe they hold the lock.
      // See stacksjs/stacks#1862 #17.
      throw new Error(`[query-builder] advisoryLock() is not supported on SQLite — use a Postgres or MySQL deployment for distributed locking.`)
    },
    async tryAdvisoryLock(key: number | string): Promise<boolean> {
      if (config.dialect === 'postgres') {
        const k = advisoryLockKey(key)
        const q = _sql`SELECT pg_try_advisory_lock(${k}) as ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Boolean(rows?.[0]?.ok)
      }
      if (isMysqlLike(config.dialect)) {
        // MySQL `GET_LOCK(name, 0)` returns 1 immediately if free, 0
        // if held by another connection.
        const lockName = `bqb:${String(key)}`
        const q = _sql`SELECT GET_LOCK(${lockName}, 0) AS ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Number(rows?.[0]?.ok) === 1
      }
      // SQLite: no primitive. Return false (lock unavailable) so
      // callers fall through to whatever non-distributed path they
      // had. Loud throw would crash apps that gracefully degrade
      // when locks aren't held.
      return false
    },
    async advisoryUnlock(key: number | string): Promise<boolean> {
      // Must run on the same connection that took the lock — hence `_sql`,
      // and hence the requirement that callers hold a reserved builder.
      if (config.dialect === 'postgres') {
        const k = advisoryLockKey(key)
        const q = _sql`SELECT pg_advisory_unlock(${k}) as ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Boolean(rows?.[0]?.ok)
      }
      if (isMysqlLike(config.dialect)) {
        const lockName = `bqb:${String(key)}`
        const q = _sql`SELECT RELEASE_LOCK(${lockName}) AS ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Number(rows?.[0]?.ok) === 1
      }
      // SQLite never took one; mirror tryAdvisoryLock's graceful shape.
      return false
    },
    unsafe(query: string, params?: any[]) {
      // Use this builder's connection. Transaction callbacks receive a
      // builder whose `_sql` is the reserved transaction connection; routing
      // raw SQL through the process-wide pool lets it escape the transaction
      // (and makes row locks such as `FOR UPDATE` ineffective).
      return (_sql as any).unsafe(query, params)
    },
    file(path: string, params?: any[]) {
      return (_sql as any).file(path, params)
    },
    async reserve() {
      const reserved = await (bunSql as any).reserve()
      const qb = createQueryBuilder<DB>({ sql: reserved, meta, schema, hooks: state?.hooks }) as any
      qb.release = () => reserved.release()
      return qb
    },
    async close(opts?: { timeout?: number }) {
      await (bunSql as any).close(opts)
    },
    async listen(channel: string, handler?: (payload: any) => void) {
      // Placeholder until Bun exposes LISTEN/NOTIFY API. Use a polling fallback or raw SQL when available
      // await (bunSql as any)`LISTEN ${bunSql(channel)}`
      if (handler) {
        // Users can wire their own NOTIFY handling with triggers/server side until native support lands
      }
    },
    async unlisten(_channel?: string) {
      // Placeholder for UNLISTEN channel/all
    },
    async notify(_channel: string, _payload?: any) {
      // Placeholder; when Bun exposes, use NOTIFY channel, 'payload'
      // await (bunSql as any)`NOTIFY ${bunSql(channel)}, ${bunSql(JSON.stringify(payload ?? null))}`
    },
    async copyTo(_queryOrTable: string, _options?: Record<string, any>) {
      // Placeholder for future COPY support
      throw new Error('COPY TO is not yet supported by Bun.sql; placeholder')
    },
    async copyFrom(_queryOrTable: string, _source: AsyncIterable<any> | Iterable<any>, _options?: Record<string, any>) {
      // Placeholder for future COPY support
      throw new Error('COPY FROM is not yet supported by Bun.sql; placeholder')
    },
    async ping() {
      try {
        const q = _sql`SELECT 1`
        await runWithHooks<any[]>(q, 'select')
        return true
      }
      catch {
        return false
      }
    },
    async waitForReady(opts?: { attempts?: number, delayMs?: number }) {
      const attempts = Math.max(1, opts?.attempts ?? 10)
      const delay = Math.max(10, opts?.delayMs ?? 100)
      for (let i = 0; i < attempts; i++) {
        if (await (this as any).ping())
          return
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      throw new Error('Database not ready after waiting')
    },
    async transaction(fn, options) {
      const defaults = state?.txDefaults
      const opts: TransactionOptions = { ...defaults, ...options }
      // Use THIS builder's connection (the injected one when present, the same
      // one its reads use), not the always-global `bunSql`. Otherwise a builder
      // created with `createQueryBuilder({ sql })` ran its transactions on a
      // different connection than its queries — which silently breaks when the
      // two aren't the same database (e.g. distinct in-memory sqlite handles).
      const txConn: any = state?.sql ?? bunSql
      // A nested transaction() must open a SAVEPOINT, not a new top-level
      // transaction — Bun's driver throws "cannot call begin inside a
      // transaction" otherwise. The builder handed to a tx callback is flagged
      // with `inTransaction`, so a nested call dispatches to `savepoint`.
      const nested = state?.inTransaction === true
      const txMethod = nested && typeof txConn?.savepoint === 'function' ? 'savepoint' : 'begin'
      const runWith = async (attempt: number): Promise<any> => {
        opts.logger?.({ type: 'start', attempt })
        const start = Date.now()
        return await (txConn as any)[txMethod](async (tx: any) => {
          const qb = createQueryBuilder<DB>({ sql: tx, meta, schema, hooks: state?.hooks, inTransaction: true })

          // Transaction isolation + read-only mode — dialect-specific
          // SQL, with a clear "not supported" path for SQLite. The
          // previous code emitted Postgres syntax verbatim on every
          // dialect AND silently swallowed errors on the read-only
          // path, so callers asking for `readOnly: true` on MySQL
          // silently got a read-write transaction instead. Now each
          // dialect dispatches to its own SQL form; unsupported
          // combinations throw a clear error. See stacksjs/stacks#1862 #14.
          // Skipped for a nested savepoint: isolation is a property of the
          // enclosing transaction and can't be set on a savepoint.
          if (opts?.isolation && !nested) {
            const level = opts.isolation
            const upper = level === 'read committed'
              ? 'READ COMMITTED'
              : level === 'repeatable read'
                ? 'REPEATABLE READ'
                : 'SERIALIZABLE'
            if (config.dialect === 'postgres') {
              await (tx as any).unsafe(`SET TRANSACTION ISOLATION LEVEL ${upper}`)
            }
            else if (isMysqlLike(config.dialect)) {
              // MySQL uses `SET SESSION TRANSACTION ISOLATION LEVEL`
              // — applied per-session before the transaction body.
              // For a per-transaction setting MySQL needs the
              // SET TRANSACTION statement to come BEFORE BEGIN,
              // which `bunSql.begin()` doesn't expose. We fall back
              // to the session-level form, which matches Postgres'
              // transaction-scoped semantics closely enough.
              await (tx as any).unsafe(`SET TRANSACTION ISOLATION LEVEL ${upper}`)
            }
            else {
              // SQLite has only a single isolation level (SERIALIZABLE)
              // — refuse loud rather than silently ignoring a level
              // the caller explicitly asked for.
              if (level !== 'serializable') {
                throw new Error(`[query-builder] transaction({ isolation: '${level}' }) not supported on SQLite (only 'serializable'). Use a Postgres or MySQL deployment for finer-grained isolation.`)
              }
            }
          }
          if (opts?.readOnly) {
            if (config.dialect === 'postgres') {
              await (tx as any).unsafe('SET TRANSACTION READ ONLY')
            }
            else if (isMysqlLike(config.dialect)) {
              await (tx as any).unsafe('SET TRANSACTION READ ONLY')
            }
            else {
              // SQLite has `PRAGMA query_only = ON` for read-only
              // sessions, but that's session-scoped not
              // transaction-scoped. Refuse rather than silently
              // accepting writes inside a "read-only" transaction.
              throw new Error('[query-builder] transaction({ readOnly: true }) not supported on SQLite. Use a Postgres or MySQL deployment.')
            }
          }
          const res = await fn(qb)
          const durationMs = Date.now() - start
          opts.logger?.({ type: 'commit', attempt, durationMs })
          return res
        })
      }
      const retries = Math.max(0, opts?.retries ?? 0)
      let attempt = 0
      // Retry on common serialization/deadlock errors
      for (;;) {
        try {
          const out = await runWith(attempt + 1)
          opts?.afterCommit?.()
          return out
        }
        catch (err: any) {
          const retriable = isRetriableTxError(err) || matchesSqlState(err, opts.sqlStates)
          if (attempt < retries && retriable) {
            attempt++
            opts?.onRetry?.(attempt, err)
            const delay = computeBackoffMs(attempt, opts.backoff)
            if (delay > 0)
              await sleep(delay)
            continue
          }
          try {
            opts.onRollback?.(err)
          }
          catch {}
          try {
            opts.afterRollback?.()
          }
          catch {}
          throw err
        }
      }
    },
    async savepoint(fn) {
      // The guard is `inTransaction` — the flag `transaction()` sets on the
      // builder it hands to its callback — NOT the mere presence of a
      // `.savepoint` method on the connection. Bun's top-level `SQL` object
      // exposes `savepoint` too, so the old check passed OUTSIDE any
      // transaction and issued a bare SAVEPOINT against the pool instead of
      // raising. It only looked correct where the connection was unreachable
      // and the method lookup failed for the wrong reason.
      if (state?.inTransaction !== true)
        throw new Error('savepoint() must be called inside a transaction')
      const s: any = _sql
      if (!s || typeof s.savepoint !== 'function')
        throw new Error('savepoint() is not supported by the active connection')
      return await s.savepoint(async (sp: any) => {
        // Carry the flag: a savepoint body is still inside a transaction, so a
        // nested savepoint()/transaction() from here must nest, not begin.
        const qb = createQueryBuilder<DB>({ sql: sp, meta, schema, hooks: state?.hooks, inTransaction: true })
        return await fn(qb)
      })
    },
    async beginDistributed(name, fn) {
      const txConn: any = state?.sql ?? bunSql
      const res = await (txConn as any).beginDistributed(name, async (tx: any) => {
        const qb = createQueryBuilder<DB>({ sql: tx, meta, schema, hooks: state?.hooks })
        return await fn(qb)
      })
      return res as any
    },
    async commitDistributed(name) {
      await (bunSql as any).commitDistributed(name)
    },
    async rollbackDistributed(name) {
      await (bunSql as any).rollbackDistributed(name)
    },
    setTransactionDefaults(defaults) {
      state = { ...state, txDefaults: { ...state?.txDefaults, ...defaults } }
    },
    transactional(fn, options) {
      return ((...args: unknown[]) => {
        return (this as any).transaction((tx: any) => fn(tx, ...(args as any)), options)
      }) as any
    },
    async insertOrIgnore(table, values) {
      // Built with explicit columns + placeholders rather than Bun's
      // `${sql(table)} ${sql(values)}` helper, which is broken on every dialect
      // (#1052). MySQL uses `INSERT IGNORE`; Postgres/SQLite `ON CONFLICT DO NOTHING`.
      const rows = (Array.isArray(values) ? values : [values]) as Record<string, any>[]
      if (!rows.length)
        return undefined as any
      const { colsSql, valuesSql, params } = buildInsertClause(rows)
      const tbl = quoteInsertIdent(String(table))
      const sqlText = isMysqlLike(config.dialect)
        ? `INSERT IGNORE INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`
        : `INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql} ON CONFLICT DO NOTHING`
      return (_sql.unsafe(sqlText, params) as any).execute()
    },
    async insertGetId(table, values, idColumn = 'id' as any) {
      const { colsSql, valuesSql, params } = buildInsertClause([values as Record<string, any>])
      const tbl = quoteInsertIdent(String(table))
      if (isMysqlLike(config.dialect)) {
        // MySQL has no RETURNING — insert then read LAST_INSERT_ID().
        await (_sql.unsafe(`INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`, params) as any).execute()
        const [row] = await (_sql.unsafe(`SELECT LAST_INSERT_ID() as id`) as any).execute()
        return row?.id
      }
      if (config.dialect === 'sqlite') {
        // The bun:sqlite wrapper returns { changes, lastInsertRowid } rather
        // than RETURNING rows, so read the rowid directly.
        const res = await (_sql.unsafe(`INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`, params) as any).execute()
        if (res?.lastInsertRowid != null)
          return res.lastInsertRowid
        const [row] = await (_sql.unsafe(`SELECT last_insert_rowid() as id`) as any).execute()
        return row?.id
      }
      // Postgres supports RETURNING.
      const [row] = await (_sql.unsafe(`INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql} RETURNING ${quoteInsertIdent(String(idColumn))} as id`, params) as any).execute()
      return row?.id
    },
    async updateOrInsert(table, match, values) {
      const tbl = quoteInsertIdent(String(table))
      const matchKeys = Object.keys(match)
      let idx = 1
      const whereSql = matchKeys.map(k => `${quoteInsertIdent(k)} = ${getPlaceholder(idx++)}`).join(' AND ')
      const whereParams = matchKeys.map(k => (match as any)[k])
      const existsRows = await (_sql.unsafe(`SELECT 1 FROM ${tbl} WHERE ${whereSql} LIMIT 1`, whereParams) as any).execute()
      if ((existsRows as any[]).length) {
        const setKeys = Object.keys(values)
        let i = 1
        const setSql = setKeys.map(k => `${quoteInsertIdent(k)} = ${getPlaceholder(i++)}`).join(', ')
        const whereSql2 = matchKeys.map(k => `${quoteInsertIdent(k)} = ${getPlaceholder(i++)}`).join(' AND ')
        const params = [...setKeys.map(k => (values as any)[k]), ...matchKeys.map(k => (match as any)[k])]
        await (_sql.unsafe(`UPDATE ${tbl} SET ${setSql} WHERE ${whereSql2}`, params) as any).execute()
        return true
      }
      const { colsSql, valuesSql, params } = buildInsertClause([{ ...match, ...values } as Record<string, any>])
      await (_sql.unsafe(`INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`, params) as any).execute()
      return true
    },
    async upsert(table, rows, conflictColumns, mergeColumns) {
      const targetCols = conflictColumns.map(c => String(c))
      const setCols = (mergeColumns ?? []).map(c => String(c))
      const list = rows as Record<string, any>[]
      if (!list.length)
        return undefined as any
      const { colsSql, valuesSql, params } = buildInsertClause(list)
      const tbl = quoteInsertIdent(String(table))
      const insert = `INSERT INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`

      // MySQL uses ON DUPLICATE KEY UPDATE / INSERT IGNORE; Postgres + SQLite
      // use ON CONFLICT ... DO UPDATE / DO NOTHING. Empty mergeColumns => the
      // "do nothing" form (an empty SET is a syntax error). See #1035, #1052.
      if (isMysqlLike(config.dialect)) {
        if (setCols.length === 0)
          return (_sql.unsafe(`INSERT IGNORE INTO ${tbl} (${colsSql}) VALUES ${valuesSql}`, params) as any).execute()
        const updateList = setCols.map(c => `${quoteInsertIdent(c)} = VALUES(${quoteInsertIdent(c)})`).join(', ')
        return (_sql.unsafe(`${insert} ON DUPLICATE KEY UPDATE ${updateList}`, params) as any).execute()
      }

      const targets = targetCols.map(quoteInsertIdent).join(', ')
      if (setCols.length === 0)
        return (_sql.unsafe(`${insert} ON CONFLICT (${targets}) DO NOTHING`, params) as any).execute()
      const updateList = setCols.map(c => `${quoteInsertIdent(c)} = EXCLUDED.${quoteInsertIdent(c)}`).join(', ')
      return (_sql.unsafe(`${insert} ON CONFLICT (${targets}) DO UPDATE SET ${updateList}`, params) as any).execute()
    },
    async save(table, values) {
      const pk = meta?.primaryKeys[String(table)] ?? 'id'
      const id = (values as any)[pk]
      if (id != null) {
        // First check if the row exists
        const existingRow = await (this as any).selectFrom(table).find(id)

        if (existingRow) {
          // Row exists, update it
          await (this as any).updateTable(table).set(values as any).where({ [pk]: id } as any).execute()

          // Retrieve the updated row
          const updatedRow = await (this as any).selectFrom(table).find(id)
          if (!updatedRow)
            throw new Error('save() failed to retrieve updated row')
          return updatedRow
        }
        else {
          // Row doesn't exist, create it
          return await (this as any).create(table, values)
        }
      }
      return await (this as any).create(table, values)
    },
    async remove(table, id) {
      return await (this as any).deleteFrom(table).where({ id } as any).execute()
    },
    async find(table, id) {
      return await (this as any).selectFrom(table).find(id)
    },
    async findOrFail(table, id) {
      return await (this as any).selectFrom(table).findOrFail(id)
    },
    async findMany(table, ids) {
      return await (this as any).selectFrom(table).findMany(ids)
    },
    async latest(table, column) {
      return await (this as any).selectFrom(table).latest(column as any).first()
    },
    async oldest(table, column) {
      return await (this as any).selectFrom(table).oldest(column as any).first()
    },
    skip(table, count) {
      return (this as any).selectFrom(table).offset(count)
    },
    async rawQuery(query: string) {
      const start = Date.now()
      try {
        activeHooks()?.onQueryStart?.({ sql: query, kind: 'raw' })
        const res = await (_sql as any).unsafe(query)
        activeHooks()?.onQueryEnd?.({ sql: query, durationMs: Date.now() - start, kind: 'raw' })
        return res
      }
      catch (err) {
        activeHooks()?.onQueryError?.({ sql: query, error: err, durationMs: Date.now() - start, kind: 'raw' })
        throw err
      }
    },
    async create(table, values) {
      const pk = meta?.primaryKeys[String(table)] ?? 'id'

      // beforeCreate hook
      try {
        await activeHooks()?.beforeCreate?.({ table: String(table), data: values })
      }
      catch (err) {
        throw err
      }

      if (config.dialect === 'postgres') {
        // For PostgreSQL, use RETURNING to get the ID, then fetch the full row
        const q = _sql`INSERT INTO ${_sql(String(table))} ${_sql(values as any)} RETURNING ${_sql(String(pk))} as id`
        const [result] = await q.execute()

        if (!result?.id) {
          console.error(`create() failed to get insert ID for table ${String(table)}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to get insert ID for table ${String(table)}`)
        }

        const row = await (this as any).selectFrom(table).find(result.id)

        if (!row) {
          console.error(`create() failed to retrieve inserted row for table ${String(table)} with id ${result.id}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to retrieve inserted row for table ${String(table)} with id ${result.id}`)
        }

        // afterCreate hook
        try {
          await activeHooks()?.afterCreate?.({ table: String(table), data: values, result: row })
        }
        catch {}

        return row
      }
      else {
        // For MySQL and other databases
        const id = await (this as any).insertGetId(table, values, pk)

        if (id == null) {
          throw new Error(`create() failed to get insert ID for table ${String(table)}`)
        }

        const row = await (this as any).selectFrom(table).find(id)

        if (!row) {
          console.error(`create() failed to retrieve inserted row for table ${String(table)} with id ${id}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to retrieve inserted row for table ${String(table)} with id ${id}`)
        }

        // afterCreate hook
        try {
          await activeHooks()?.afterCreate?.({ table: String(table), data: values, result: row })
        }
        catch {}

        return row
      }
    },
    async createMany(table, rows) {
      if (!rows?.length)
        return

      const firstRow = rows[0]
      const keys = Object.keys(firstRow)
      const colCount = keys.length
      const rowCount = rows.length
      const params = Array.from({ length: rowCount * colCount })

      // Quote table + column identifiers (#1033) — MySQL backticks, else
      // double quotes (Postgres/SQLite).
      const quoteId = isMysqlLike(config.dialect)
        ? (id: string): string => `\`${String(id).replace(/`/g, '``')}\``
        : (id: string): string => `"${String(id).replace(/"/g, '""')}"`
      let sql = `INSERT INTO ${quoteId(String(table))}(${keys.map(quoteId).join(',')})VALUES`
      let pidx = 0
      for (let r = 0; r < rowCount; r++) {
        if (r > 0)
          sql += ','
        sql += '('
        const row = rows[r]
        for (let c = 0; c < colCount; c++) {
          if (c > 0)
            sql += ','
          sql += getPlaceholder(pidx + 1)
          params[pidx++] = row[keys[c]]
        }
        sql += ')'
      }

      return _sql.unsafe(sql, params).execute()
    },
    async insertMany(table, rows) {
      if (!rows?.length)
        return

      const firstRow = rows[0]
      const keys = Object.keys(firstRow)
      const colCount = keys.length
      const rowCount = rows.length
      const totalParams = rowCount * colCount
      const params = new Array(totalParams)

      // Pre-build a single row placeholder template: (?,?,?,?) or ($1,$2,$3,$4)
      const isPositional = config.dialect === 'postgres'
      let rowTemplate: string
      if (!isPositional) {
        // SQLite/MySQL: all placeholders are ?, build once and reuse
        const placeholders = new Array(colCount)
        for (let c = 0; c < colCount; c++) placeholders[c] = '?'
        rowTemplate = `(${placeholders.join(',')})`
      }
      else {
        rowTemplate = '' // not used for postgres
      }

      // Build SQL and collect params
      const sqlParts = new Array(rowCount + 2)
      sqlParts[0] = `INSERT INTO ${table}(${keys.join(',')})VALUES`
      let pidx = 0

      if (!isPositional) {
        // Fast path: reuse the same template for every row
        for (let r = 0; r < rowCount; r++) {
          const row = rows[r]
          sqlParts[r + 1] = rowTemplate
          for (let c = 0; c < colCount; c++) {
            params[pidx++] = row[keys[c]]
          }
        }
        // Join with commas between row templates
        return _sql.unsafe(sqlParts[0] + sqlParts.slice(1, rowCount + 1).join(','), params).execute()
      }

      // Postgres path: positional placeholders
      for (let r = 0; r < rowCount; r++) {
        const row = rows[r]
        const placeholders = new Array(colCount)
        for (let c = 0; c < colCount; c++) {
          placeholders[c] = `$${pidx + 1}`
          params[pidx++] = row[keys[c]]
        }
        sqlParts[r + 1] = `(${placeholders.join(',')})`
      }
      return _sql.unsafe(sqlParts[0] + sqlParts.slice(1, rowCount + 1).join(','), params).execute()
    },
    async updateMany(table, conditions, data) {
      // Ultra-optimized direct SQL construction
      const dataKeys = Object.keys(data)
      const dataLen = dataKeys.length
      if (dataLen === 0)
        return 0

      const params: any[] = []

      // Build SET clause using array join
      const setClauses: string[] = Array.from({ length: dataLen })
      for (let i = 0; i < dataLen; i++) {
        setClauses[i] = `${dataKeys[i]}=${getPlaceholder(i + 1)}`
        params.push((data as any)[dataKeys[i]])
      }

      let sql = `UPDATE ${table} SET ${setClauses.join(',')}`

      // Build WHERE clause.
      //
      // Every branch below either appends a predicate or throws. `conditions`
      // is a required parameter, so there is no shape of it that means "every
      // row" — passing one is the caller saying they have a filter. Anything
      // this cannot turn into a predicate used to fall straight through to an
      // UPDATE with no WHERE, which rewrote the whole table and reported the
      // full count as success. See #1112, and #1101 for the same defect in
      // updateTable().
      if (Array.isArray(conditions)) {
        // Separated by spaces: the three parts used to be concatenated bare,
        // which is fine for `=` and `>=` and produces `namelike?` for every
        // word operator the allowed set contains.
        const safeOperator = assertSafeWhereOperator(String(conditions[1]), 'updateMany')
        sql += ` WHERE ${conditions[0]} ${safeOperator} ${getPlaceholder(params.length + 1)}`
        params.push(conditions[2])
      }
      // A fragment is inside the declared `WhereExpression` type (through
      // `WhereRaw`) and `raw` is a public export, so `updateMany(t, raw('id =
      // 1'), data)` typechecks and reads like the intended way to express a
      // condition this signature cannot otherwise carry. It matched no branch.
      else if (isRawExpression(conditions)) {
        sql += ` WHERE ${conditions.raw}`
      }
      else if (isBoundSqlExpression(conditions)) {
        const rendered = renderBoundSqlExpression(conditions, params.length + 1)
        sql += ` WHERE ${rendered.text}`
        params.push(...rendered.parameters)
      }
      else if (conditions && typeof conditions === 'object' && Object.keys(conditions).length > 0) {
        const whereClauses = Object.keys(conditions).map(key =>
          renderColumnCondition(key, (conditions as any)[key], params))
        sql += ` WHERE ${whereClauses.join(' AND ')}`
      }
      // The empty object is the one that bites in production: `conditions` is
      // usually built from request input, and `updateMany(t, buildFilter(req.query), data)`
      // rewrote every row the moment the filter came back empty.
      else if (conditions && typeof conditions === 'object') {
        throw new TypeError('[query-builder] updateMany(): an empty object is not a filter. Pass a condition, or use updateTable(table).set(data).execute() if updating every row is intended.')
      }
      else {
        throw new TypeError(`[query-builder] updateMany(): expected a condition, got ${conditions === null ? 'null' : typeof conditions}. Refusing to run an UPDATE with no WHERE — use updateTable(table).set(data).execute() if updating every row is intended.`)
      }

      return _sql.unsafe(sql, params).execute()
    },
    async deleteMany(table, ids) {
      if (!Array.isArray(ids) || ids.length === 0)
        return 0
      const pk = meta?.primaryKeys[String(table)] ?? 'id'
      const len = ids.length

      // Direct SQL construction for performance (avoids full query builder overhead)
      if (config.dialect === 'postgres') {
        const placeholders = new Array(len)
        for (let i = 0; i < len; i++) placeholders[i] = `$${i + 1}`
        return _sql.unsafe(`DELETE FROM ${table} WHERE ${pk} IN (${placeholders.join(',')})`, ids).execute()
      }
      // SQLite/MySQL: use ? placeholders
      const placeholders = new Array(len)
      for (let i = 0; i < len; i++) placeholders[i] = '?'
      return _sql.unsafe(`DELETE FROM ${table} WHERE ${pk} IN (${placeholders.join(',')})`, ids).execute()
    },
    async firstOrCreate(table, match, defaults) {
      const existing = await (this as any).selectFrom(table).where(match as any).first()
      if (existing)
        return existing
      return await (this as any).create(table, { ...(match as any), ...(defaults as any) })
    },
    async updateOrCreate(table, match, values) {
      const existing = await (this as any).selectFrom(table).where(match as any).first()
      if (existing) {
        await (this as any).updateTable(table).set(values as any).where(match as any).execute()
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const id = (existing as any)[pk]
        const refreshed = id != null
          ? await (this as any).selectFrom(table).find(id)
          : await (this as any).selectFrom(table).where(match as any).first()
        if (!refreshed)
          throw new Error('updateOrCreate() failed to retrieve updated row')
        return refreshed
      }
      return await (this as any).create(table, { ...(match as any), ...(values as any) })
    },
    async count(table, column) {
      const col = column ? _sql(String(column)) : _sql`*`
      const q = _sql`SELECT COUNT(${col}) as c FROM ${_sql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.c ?? 0) as any)
    },
    async sum(table, column) {
      const q = _sql`SELECT SUM(${_sql(String(column))}) as s FROM ${_sql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.s ?? 0) as any)
    },
    async avg(table, column) {
      const q = _sql`SELECT AVG(${_sql(String(column))}) as a FROM ${_sql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.a ?? 0) as any)
    },
    async min(table, column) {
      const q = _sql`SELECT MIN(${_sql(String(column))}) as m FROM ${_sql(String(table))}`
      const [row] = await (q as any).execute()
      return (row?.m as any)
    },
    async max(table, column) {
      const q = _sql`SELECT MAX(${_sql(String(column))}) as m FROM ${_sql(String(table))}`
      const [row] = await (q as any).execute()
      return (row?.m as any)
    },
    /**
     * Get all relationships defined for a table
     */
    getRelationships(table: string) {
      if (!meta?.relations)
        return {}
      const tableRels = meta.relations[table]
      if (!tableRels)
        return {}

      const result: Record<string, any> = {}
      for (const [type, relations] of Object.entries(tableRels)) {
        if (relations && typeof relations === 'object' && Object.keys(relations).length > 0) {
          result[type] = relations
        }
      }
      return result
    },
    /**
     * Check if a table has a specific relationship
     */
    hasRelationship(table: string, relationName: string): boolean {
      if (!meta?.relations)
        return false
      const rels = meta.relations[table]
      if (!rels)
        return false

      return Object.values(rels).some(
        relMap => relMap && typeof relMap === 'object' && relationName in relMap,
      )
    },
    /**
     * Get the type of a relationship
     */
    getRelationshipType(table: string, relationName: string): string | null {
      if (!meta?.relations)
        return null
      const rels = meta.relations[table]
      if (!rels)
        return null

      for (const [_type, relMap] of Object.entries(rels)) {
        if (relMap && typeof relMap === 'object' && relationName in relMap) {
          return _type
        }
      }
      return null
    },
    /**
     * Get the target table of a relationship
     */
    getRelationshipTarget(table: string, relationName: string): string | null {
      if (!meta?.relations)
        return null
      const rels = meta.relations[table]
      if (!rels)
        return null

      for (const [_type, relMap] of Object.entries(rels)) {
        if (relMap && typeof relMap === 'object' && relationName in relMap) {
          const targetModel = (relMap as any)[relationName]
          if (typeof targetModel === 'string') {
            return meta.modelToTable[targetModel] || targetModel
          }
          else if (targetModel && typeof targetModel === 'object') {
            // BelongsToManyConfig form: { model: 'X', through?, ... }
            // hasOneThrough/hasManyThrough form: { through, target }
            if ('model' in targetModel) {
              return meta.modelToTable[(targetModel as any).model] || (targetModel as any).model
            }
            if ('target' in targetModel) {
              return meta.modelToTable[(targetModel as any).target] || (targetModel as any).target
            }
          }
        }
      }
      return null
    },

  }
}

/**
 * # `clearQueryCache()`
 *
 * Clears all cached query results.
 *
 * @example
 * ```ts
 * clearQueryCache()
 * ```
 */
export function clearQueryCache(): void {
  queryCache.clear()
}

/**
 * # `setQueryCacheMaxSize(size)`
 *
 * Sets the maximum number of cached queries (default 100).
 *
 * @example
 * ```ts
 * setQueryCacheMaxSize(500)
 * ```
 */
export function setQueryCacheMaxSize(size: number): void {
  queryCache.setMaxSize(size)
}
