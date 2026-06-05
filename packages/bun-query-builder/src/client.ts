/* eslint-disable regexp/no-super-linear-backtracking */

/* eslint-disable no-useless-catch */
import type { SchemaMeta } from './meta'
import type { ResolvedPivot } from './pivot'
import type { DatabaseSchema } from './schema'
import { config, getPlaceholder, getPlaceholders } from './config'
import type { DriverConnection } from './db'
import { bunSql, getOrCreateBunSql, resetConnection } from './db'
import { resolvePivot } from './pivot'

export { resetConnection }

// Type guard for raw SQL expressions
interface RawExpression {
  raw: string
}

function isRawExpression(expr: unknown): expr is RawExpression {
  return typeof expr === 'object' && expr !== null && 'raw' in expr && typeof (expr as RawExpression).raw === 'string'
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
function renderSelectColumn(col: unknown): string {
  if (typeof col === 'string')
    return col
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

// Simple query cache with TTL support
interface CacheEntry {
  data: any
  expiresAt: number
}

class QueryCache {
  private cache = new Map<string, CacheEntry>()
  private maxSize = 100

  get(key: string): any | null {
    const entry = this.cache.get(key)
    if (!entry)
      return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  set(key: string, data: any, ttlMs: number): void {
    // Simple LRU: if cache is full, delete oldest entry
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey)
        this.cache.delete(firstKey)
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
    this.maxSize = size
  }
}

const queryCache = new QueryCache()

// Where condition helpers
type Primitive = string | number | boolean | bigint | Date | null | undefined
type ValueOrRef = Primitive

export type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in' | 'is' | 'is not'

export interface WhereRaw {
  raw: any
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

export type WhereExpression<TableColumns> =
  | Partial<{ [K in keyof TableColumns & string]: ValueOrRef | ValueOrRef[] }>
  | [key: keyof TableColumns & string, op: WhereOperator, value: ValueOrRef | ValueOrRef[]]
  | WhereRaw

export type QueryResult = any

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
export type ColumnName<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> = keyof DB[TTable]['columns'] & string
// Named row alias to improve IDE hover readability
export type SelectedRow<
  DB extends DatabaseSchema<any>,
  _TTable extends keyof DB & string,
  TSelected,
> = Readonly<TSelected>

type JoinColumn<DB extends DatabaseSchema<any>, TTables extends string> = TTables extends any
  ? `${TTables}.${keyof DB[TTables]['columns'] & string}`
  : never

// Convert snake_case to PascalCase at the type level (e.g. created_at -> CreatedAt)
type SnakeToPascal<S extends string> = S extends `${infer H}_${infer T}`
  ? `${Capitalize<H>}${SnakeToPascal<T>}`
  : Capitalize<S>

// Typed SQL builder (type-level only). We piggy-back on the runtime builder but
// thread a phantom TSql string through method signatures so hovers can show the
// composed SQL at compile-time for common operations.
type _TypedDynamicWhereMethods<
  DB extends DatabaseSchema<any>,
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

export type TypedSelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
  TSql extends string = `SELECT * FROM ${TTable}`,
> = Omit<
  BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined>,
  'toSQL' | 'where' | 'andWhere' | 'orWhere' | 'orderBy' | 'limit'
> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>
& _TypedDynamicWhereMethods<DB, TTable, TSelected, TJoined, TSql>
& {
  toSQL: () => TSql
  where: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${string}`>)
  andWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${string}`>)
  orWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${string}`>)
  orderBy: <C extends keyof DB[TTable]['columns'] & string, D extends 'asc' | 'desc' = 'asc'>(
    column: C,
    direction?: D,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} ORDER BY ${C} ${D}`>
  limit: <N extends number>(n: N) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} LIMIT ${N}`>
}

type DynamicWhereMethods<
  DB extends DatabaseSchema<any>,
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
  DB extends DatabaseSchema<any>,
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
  where: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
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
  whereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  orWhereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  orWhereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereAny: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereAll: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereNone: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  orWhereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  whereNotBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  andWhere: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
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
  orWhere: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
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
  abort?: (signal: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // Joins
  join: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  joinSub: (sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  leftJoinSub: (sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  rightJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoin: <T2 extends keyof DB & string>(table: T2) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoinSub: (sub: { toSQL: () => any }, alias: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  having: (expr: WhereExpression<any>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  select?: (columns: string | SqlFragment | ((keyof DB[TTable]['columns'] & string) | string | SqlFragment)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectAll?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  union: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  unionAll: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  selectAllRelations?: () => SelectQueryBuilder<DB, TTable, any, TJoined>
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
  whereExists?: (subquery: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  with?: (...relations: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
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
  withPivot?: (relation: string, ...columns: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
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
  wherePivot?: (relation: string, column: string, opOrValue: any, value?: any) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `wherePivotIn`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being in a list.
   */
  wherePivotIn?: (relation: string, column: string, values: any[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `wherePivotNotIn`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being not in a list.
   */
  wherePivotNotIn?: (relation: string, column: string, values: any[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `wherePivotNull`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being NULL.
   */
  wherePivotNull?: (relation: string, column: string) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `wherePivotNotNull`
   *
   * Filter a `belongsToMany` query by a column on the pivot table being NOT NULL.
   */
  wherePivotNotNull?: (relation: string, column: string) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `applyPivotColumns`
   *
   * Apply pivot columns to the SELECT clause.
   */
  applyPivotColumns?: () => SelectQueryBuilder<DB, TTable, TSelected, any>
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
  withCTE: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  withRecursive: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  cursorPaginate: (perPage: number, cursor?: string | number, column?: string, direction?: 'asc' | 'desc') => Promise<{ data: any[], meta: { perPage: number, nextCursor: string | number | null } }>
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
  chunk: (size: number, handler: (rows: any[]) => Promise<void> | void) => Promise<void>
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
  chunkById: (size: number, column?: string, handler?: (rows: any[]) => Promise<void> | void) => Promise<void>
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
  eachById: (size: number, column?: string, handler?: (row: any) => Promise<void> | void) => Promise<void>
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
  when: (condition: any, then: (qb: any) => any, otherwise?: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  tap: (fn: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  explain: () => Promise<any[]>
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
  simple: () => any
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
  paginate: (perPage: number, page?: number) => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, page: number, total: number, lastPage: number } }>
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
  find: (id: any) => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  findOrFail: (id: any) => Promise<SelectedRow<DB, TTable, TSelected>>
  findMany: (ids: any[]) => Promise<TSelected[]>
  lazy: () => AsyncIterable<TSelected>
  lazyById: () => AsyncIterable<TSelected>
  pipe: <R>(fn: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => R) => R
  count: () => Promise<number>
  avg: (column: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: (column: keyof DB[TTable]['columns'] & string) => Promise<number>
  max: (column: keyof DB[TTable]['columns'] & string) => Promise<any>
  min: (column: keyof DB[TTable]['columns'] & string) => Promise<any>
  // Type-only convenience properties for IDE hovers; not implemented at runtime
  readonly rows: TSelected[]
  readonly row: TSelected
  values: () => Promise<any[][]>
  /** Return parameter values for debugging/tests. */
  toParams?: () => any[]
  raw: () => Promise<any[][]>
  cancel: () => void
  /** Include soft-deleted rows in results. */
  withTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Only return soft-deleted rows. */
  onlyTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Apply a named scope defined on the model. */
  scope?: (name: string, value?: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
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
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>

export interface InsertQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
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

export interface UpdateQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
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
  set: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `where`
   *
   * Filters rows to update using a flexible expression.
   *
   * @example
   * ```ts
   * const cnt = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * const cnt2 = await db.updateTable('users').set({ active: true }).where('id', '=', 1).execute()
   * ```
   */
  where: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => UpdateQueryBuilder<DB, TTable>
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

export interface DeleteQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  /**
   * # `where`
   *
   * Filters rows to delete using a flexible expression.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ inactive: true }).execute()
   * const count2 = await db.deleteFrom('users').where('id', '=', 1).execute()
   * ```
   */
  where: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => DeleteQueryBuilder<DB, TTable>
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

export interface TableQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
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
  select: (...columns: (keyof DB[TTable]['columns'] & string)[]) => SelectQueryBuilder<DB, TTable, any>
}

export interface QueryBuilder<DB extends DatabaseSchema<any>> {
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
  select: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
    table: TTable,
    ...columns: (K | `${string} as ${string}`)[]
  ) => SelectQueryBuilder<DB, TTable, any>
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
  selectFromSub: (sub: { toSQL: () => any }, alias: string) => SelectQueryBuilder<DB, keyof DB & string, any>
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
  sql: any
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
  raw: (strings: TemplateStringsArray, ...values: any[]) => any
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
  simple: (strings: TemplateStringsArray, ...values: any[]) => any
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
  unsafe: (query: string, params?: any[]) => Promise<any>
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
  file: (path: string, params?: any[]) => Promise<any>
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
  listen: (channel: string, handler?: (payload: any) => void) => Promise<void>
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
  notify: (channel: string, payload?: any) => Promise<void>
  // COPY support (stubs until available)
  /**
   * # `copyTo`
   *
   * Streams out data from a query or table (placeholder).
   */
  copyTo: (queryOrTable: string, options?: Record<string, any>) => Promise<any>
  /**
   * # `copyFrom`
   *
   * Streams data into a table (placeholder).
   */
  copyFrom: (queryOrTable: string, source: AsyncIterable<any> | Iterable<any>, options?: Record<string, any>) => Promise<any>
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
  transactional: <TArgs extends any[], R>(fn: (tx: QueryBuilder<DB>, ...args: TArgs) => Promise<R> | R, options?: TransactionOptions) => (...args: TArgs) => Promise<R>
  // aggregates
  count: <TTable extends keyof DB & string>(table: TTable, column?: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  avg: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  min: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
  max: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
  // dml helpers
  insertOrIgnore: <TTable extends keyof DB & string>(table: TTable, values: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => Promise<any>
  insertGetId: <TTable extends keyof DB & string>(table: TTable, values: Partial<DB[TTable]['columns']>, idColumn?: keyof DB[TTable]['columns'] & string) => Promise<any>
  updateOrInsert: <TTable extends keyof DB & string>(table: TTable, match: Partial<DB[TTable]['columns']>, values: Partial<DB[TTable]['columns']>) => Promise<boolean>
  upsert: <TTable extends keyof DB & string>(table: TTable, rows: Partial<DB[TTable]['columns']>[], conflictColumns: (keyof DB[TTable]['columns'] & string)[], mergeColumns?: (keyof DB[TTable]['columns'] & string)[]) => Promise<any>

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
    ids: any[],
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
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<any>

  /**
   * # `find(table, id)`
   * Fetch by primary key. Returns the row or undefined.
   */
  find: <TTable extends keyof DB & string>(
    table: TTable,
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `findOrFail(table, id)`
   * Fetch by primary key or throw if not found.
   */
  findOrFail: <TTable extends keyof DB & string>(
    table: TTable,
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `findMany(table, ids)`
   * Fetch many by primary keys.
   */
  findMany: <TTable extends keyof DB & string>(
    table: TTable,
    ids: any[],
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
  rawQuery: (query: string) => Promise<any>
  /** Safely wrap/validate an identifier for raw fragments. */
  id?: (name: string) => any
  /** Safely wrap/validate multiple identifiers. */
  ids?: (...names: string[]) => any
  /** Take an advisory lock (PostgreSQL only). */
  advisoryLock?: (key: number | string) => Promise<void>
  /** Try to take an advisory lock and return false if unavailable (PostgreSQL only). */
  tryAdvisoryLock?: (key: number | string) => Promise<boolean>
  /** Get all relationships defined for a table. */
  getRelationships?: (table: string) => Record<string, any>
  /** Check if a table has a specific relationship. */
  hasRelationship?: (table: string, relationName: string) => boolean
  /** Get the type of a relationship (hasMany, belongsTo, etc.). */
  getRelationshipType?: (table: string, relationName: string) => string | null
  /** Get the target model/table of a relationship. */
  getRelationshipTarget?: (table: string, relationName: string) => string | null
}

// Typed INSERT builder to expose a structured SQL literal in hovers
export type TypedInsertQueryBuilder<
  DB extends DatabaseSchema<any>,
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
  sql: any
  meta?: SchemaMeta
  schema?: any
  txDefaults?: TransactionOptions
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
interface TxLoggerEvent { type: 'start' | 'retry' | 'commit' | 'rollback' | 'error', attempt: number, error?: any, durationMs?: number }
export interface TransactionOptions {
  retries?: number
  isolation?: TransactionIsolation
  onRetry?: (attempt: number, error: any) => void
  afterCommit?: () => void
  sqlStates?: string[]
  backoff?: TxBackoff
  logger?: (event: TxLoggerEvent) => void
  /** When true, executes transaction in read-only mode (where supported). */
  readOnly?: boolean
  /** Called when a transaction is rolled back. */
  onRollback?: (error: any) => void
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
function reorderSelectClauses(sql: string): string {
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
    const jitter = Math.random() * ms * 0.2
    ms = ms - jitter / 2
  }
  return Math.floor(ms)
}

// eslint-disable-next-line pickier/no-unused-vars
export function createQueryBuilder<DB extends DatabaseSchema<any>>(state?: Partial<InternalState>): QueryBuilder<DB> {
  // Single boundary cast: `state.sql` is `any` (allows mock/tx injection) and
  // getOrCreateBunSql() returns Bun's `SQL`; both satisfy DriverConnection. With
  // `_sql` typed, the downstream `.unsafe(...)` calls no longer need casts (#1044).
  const _sql: DriverConnection = (state?.sql ?? getOrCreateBunSql()) as unknown as DriverConnection
  const meta = state?.meta
  const schema = state?.schema

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
    const hooks = config.hooks
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

    // Lazy building: don't prepare statement until execution
    // built is initialized lazily to avoid expensive template tag calls on every query
    let built: any = null
    const ensureBuilt = () => {
      if (built === null) {
        const finalText = reorderSelectClauses(text)
        built = whereParams.length > 0
          ? _sql.unsafe(finalText, whereParams)
          : _sql.unsafe(finalText)
      }
      return built
    }

    const addWhereText = (prefix: 'WHERE' | 'AND' | 'OR', clause: string) => {
      const hasWhere = SQL_PATTERNS.WHERE.test(text)
      const p = hasWhere ? prefix : 'WHERE'
      text = `${text} ${p} ${clause}`
    }

    // Append a UNION/UNION ALL (extensible to INTERSECT/EXCEPT) while MERGING
    // the other side's bound params and renumbering its `$n` placeholders past
    // ours on Postgres — previously the set-op appended text only, dropping the
    // right side's params and colliding `$1`. See stacksjs/bun-query-builder#1029.
    const appendSetOp = (op: string, other: { toSQL: () => any, __rawState?: () => { sql: string, params: unknown[] } }) => {
      const st = other.__rawState?.()
      if (st) {
        const offset = whereParams.length
        const otherSql = config.dialect === 'postgres'
          ? st.sql.replace(/\$(\d+)/g, (_m: string, n: string) => `$${Number(n) + offset}`)
          : st.sql
        text += ` ${op} ${otherSql}`
        whereParams.push(...st.params)
      }
      else {
        // Foreign builder without __rawState — fall back to text-only (no param merge).
        text += ` ${op} ${String(other.toSQL())}`
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
    const singularize = (name: string): string => {
      if (config.relations.singularizeStrategy === 'none')
        return name
      return name.endsWith('s') ? name.slice(0, -1) : name
    }

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

    // Track WHERE conditions and parameters for proper merging
    const whereConditions: string[] = []
    const whereParams: unknown[] = []

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

    // Shared OVER (...) builder + window-expression injection for the window
    // functions (rowNumber/rank/... and lag/lead/sumOver/...). See #1050.
    const buildOverClause = (partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]): string => {
      const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
      const parts: string[] = []
      if (cols.length)
        parts.push(`PARTITION BY ${cols.join(', ')}`)
      if (orderBy && orderBy.length)
        parts.push(`ORDER BY ${orderBy.map(([c, d]) => `${c} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`)
      return parts.length ? `OVER (${parts.join(' ')})` : 'OVER ()'
    }
    const addWindowFunction = (fnExpr: string, alias: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]): void => {
      addToSelectClause(`${fnExpr} ${buildOverClause(partitionBy, orderBy)} AS ${alias}`)
    }

    function assertSafeWhereOperator(op: unknown, context: string): string {
      if (typeof op !== 'string')
        throw new TypeError(`[query-builder] ${context}: operator must be a string, got ${typeof op}`)
      const lower = op.toLowerCase()
      if (!SAFE_WHERE_OPERATORS.has(lower))
        throw new TypeError(`[query-builder] ${context}: refusing to use '${op}' as a SQL operator — not in the allowed set (${[...SAFE_WHERE_OPERATORS].join(', ')})`)
      return op
    }

    /**
     * Format a value for safe interpolation into a relationship-subquery
     * fragment. Strings are SQL-escaped (single-quote doubled per ANSI
     * SQL); numbers / booleans / null pass through; everything else
     * is rejected.
     *
     * The previous code interpolated `'${val}'` for strings — naked
     * single quotes, no escaping. A `val` containing `'` terminated
     * the literal early and let an attacker inject SQL. Doubling the
     * internal quote produces a valid SQL string literal regardless
     * of contents. See stacksjs/stacks#1858 Q-1.
     */
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
     * Runtime soft-guard for the `*Raw` family. The TS signature is
     * now `SqlFragment = object` so a bare string `whereRaw('foo')`
     * fails to compile — this guard catches the same case for
     * `as any` casts that bypass the type system, but emits a
     * once-per-process warning rather than throwing to preserve
     * backward compat for callers that legitimately need to
     * interpolate compile-time-known constants (audit log queries,
     * generated migrations, etc.). See stacksjs/stacks#1858 Q-3.
     *
     * The warning surfaces the security concern (bare strings can
     * concatenate user input → SQL injection); callers can silence
     * by switching to a `sql\`...\`` tagged-template fragment.
     */
    function assertSqlFragment(fragment: unknown, context: string): void {
      if (fragment === null || fragment === undefined) {
        throw new TypeError(`[query-builder] ${context}: fragment must be a SqlFragment, got ${fragment}`)
      }
      if (typeof fragment === 'string') {
        warnOnceBareSqlFragment(context)
      }
    }

    // Module-scoped Set so we warn at most once per call site per
    // process lifetime — chatty warnings on every query are useless
    // noise, but a single startup-time warning surfaces the security
    // concern.
    const warnedSqlFragmentContexts = new Set<string>()
    function warnOnceBareSqlFragment(context: string): void {
      if (warnedSqlFragmentContexts.has(context)) return
      warnedSqlFragmentContexts.add(context)
      console.warn(
        `[query-builder] ${context}: bare string passed to a *Raw method. `
        + `Prefer \`sql\`...\`\` tagged-template fragments so values are parameterised `
        + `instead of concatenated — concatenating request input into SQL is an `
        + `injection vector. This will become a hard error in a future release.`,
      )
    }

    function formatSubqueryValue(val: unknown): string {
      if (val === null) return 'NULL'
      if (typeof val === 'number' && Number.isFinite(val)) return String(val)
      if (typeof val === 'boolean') return val ? '1' : '0'
      if (typeof val === 'string') return `'${val.replace(/'/g, '\'\'')}'`
      throw new TypeError(`[query-builder] subquery condition: refusing to interpolate value of type ${typeof val}`)
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
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${op} ${typeof val === 'string' ? `'${val}'` : val}`
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
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${op} ${typeof val === 'string' ? `'${val}'` : val}`
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
        assertSqlFragment(fragment, 'selectRaw(fragment)')
        // Insert raw fragment into SELECT list before FROM
        const fromIdx = text.indexOf(' FROM ')
        if (fromIdx !== -1) {
          text = `${text.substring(0, fromIdx)}, ${String(fragment)}${text.substring(fromIdx)}`
        }
        else {
          text += `, ${String(fragment)}`
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
        // Replace SELECT * with SELECT specific columns, preserving FROM and JOINs
        const fromIndex = text.indexOf(' FROM ')
        if (fromIndex !== -1) {
          text = `SELECT ${rendered.join(', ')}${text.substring(fromIndex)}`
        }
        else {
          text = `SELECT ${rendered.join(', ')} FROM ${table}`
        }
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

          // Helper to build conditional JOIN clause
          const _buildConditionalJoin = (baseJoinCondition: string, targetTable: string): string => {
            let joinCondition = baseJoinCondition

            // Add soft delete filter if enabled
            if (config.softDeletes?.enabled && config.softDeletes?.defaultFilter) {
              const softDeleteColumn = config.softDeletes.column || 'deleted_at'
              joinCondition = `${joinCondition} AND ${targetTable}.${softDeleteColumn} IS NULL`
            }

            if (!condition)
              return joinCondition

            // Create a simple query builder for the condition
            const conditionBuilder = {
              where: (col: string, op: string, val: any) => {
                const valStr = typeof val === 'string' ? `'${val}'` : String(val)
                return `${targetTable}.${col} ${op} ${valStr}`
              },
            }

            try {
              const additionalCondition = condition(conditionBuilder)
              if (additionalCondition && typeof additionalCondition === 'string') {
                return `${joinCondition} AND ${additionalCondition}`
              }
            }
            catch {
              // If condition fails, just use base condition
            }

            return joinCondition
          }

          // Helper to add soft delete check to JOIN
          const addSoftDeleteCheck = (table: string): string => {
            if (config.softDeletes?.enabled && config.softDeletes?.defaultFilter) {
              const softDeleteColumn = config.softDeletes.column || 'deleted_at'
              return ` AND ${table}.${softDeleteColumn} IS NULL`
            }
            return ''
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
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(throughTable)} ON ${sql(`${throughTable}.${fkInThrough}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(finalTable)} ON ${sql(`${finalTable}.${fkInFinal}`)} = ${sql(`${throughTable}.${throughPk}`)}`
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
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(pivot)} ON ${sql(`${pivot}.${fkA}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${childPk}`)} = ${sql(`${pivot}.${fkB}`)}`

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
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(pivotTable)} ON ${sql(`${pivotTable}.${morphId}`)} = ${sql(`${fromTable}.${fromPk}`)} AND ${sql(`${pivotTable}.${morphType}`)} = ${sql(meta.tableToModel[fromTable] || fromTable)} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${childPk}`)} = ${sql(`${pivotTable}.${targetFk}`)}`
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
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(pivotTable)} ON ${sql(`${pivotTable}.${relatedFk}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(relatedTable)} ON ${sql(`${relatedTable}.${relatedPk}`)} = ${sql(`${pivotTable}.${morphId}`)} AND ${sql(`${pivotTable}.${morphType}`)} = ${sql(meta.tableToModel[relatedTable] || relatedTable)}`
            joinedTables.add(pivotTable)
            joinedTables.add(relatedTable)
            return relatedTable
          }

          // belongsTo: parent has fk to child
          const isBt = Boolean(rels?.belongsTo?.[relationKey])
          if (isBt) {
            const fkInParent = `${singularize(childTable)}_id`
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(childTable)} ON ${sql(`${fromTable}.${fkInParent}`)} = ${sql(`${childTable}.${childPk}`)}`
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
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${morphId}`)} = ${sql(`${fromTable}.${fromPk}`)} AND ${sql(`${childTable}.${morphType}`)} = ${sql(meta.tableToModel[fromTable] || fromTable)}`
            joinedTables.add(childTable)
            return childTable
          }

          // hasOne/hasMany: child has fk to parent
          const fkInChild = `${singularize(fromTable)}_id`
          const pk = meta.primaryKeys[fromTable] ?? 'id'
          const softDeleteCheck = addSoftDeleteCheck(childTable)

          if (softDeleteCheck) {
            // Use raw SQL for complex condition
            const currentSql = String(ensureBuilt())
            const joinCondition = `${childTable}.${fkInChild} = ${fromTable}.${pk}${softDeleteCheck}`
            built = sql`${sql(currentSql)} LEFT JOIN ${sql(childTable)} ON ${sql(joinCondition)}`
          }
          else {
            // Use standard JOIN
            built = sql`${ensureBuilt()} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${fkInChild}`)} = ${sql(`${fromTable}.${pk}`)}`
          }

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

        // Update text representation for toSQL()
        text = computeSqlText(ensureBuilt())

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

        built = sql`${ensureBuilt()} WHERE EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `EXISTS (${subquerySQL})`)
        }
        catch {}

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

        built = sql`${ensureBuilt()} WHERE NOT EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)
        }
        catch {}

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

        built = sql`${ensureBuilt()} WHERE EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `EXISTS (${subquerySQL})`)
        }
        catch {}

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

        built = sql`${ensureBuilt()} WHERE NOT EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)
        }
        catch {}

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
        whereConditions.push(clause)
        whereParams.push(val)
        const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${kw} ${clause}`
        built = null
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      wherePivotIn(relation: string, column: string, values: any[]) {
        if (!meta || !Array.isArray(values) || values.length === 0)
          return this as any
        const resolved = resolvePivotLocal(relation)
        if (!resolved) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${String(table)}'`)
        }
        validateIdentifier(resolved.pivotTable, 'wherePivotIn (pivot table)')
        validateIdentifier(column, 'wherePivotIn (column)')
        ensurePivotJoined(resolved)

        const placeholders = getPlaceholders(values.length, whereParams.length + 1)
        const clause = `${resolved.pivotTable}.${column} IN (${placeholders})`
        whereConditions.push(clause)
        whereParams.push(...values)
        const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${kw} ${clause}`
        built = null
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
        whereConditions.push(clause)
        whereParams.push(...values)
        const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${kw} ${clause}`
        built = null
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
        const clause = `${resolved.pivotTable}.${column} IS NULL`
        whereConditions.push(clause)
        const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${kw} ${clause}`
        built = null
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
        const clause = `${resolved.pivotTable}.${column} IS NOT NULL`
        whereConditions.push(clause)
        const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${kw} ${clause}`
        built = null
        if (resolved.hasConfig)
          pivotConfigRelations.add(relation)
        return this as any
      },
      where(expr: any, op?: WhereOperator, value?: any) {
        // Helper to get the correct keyword (WHERE for first condition, AND for subsequent)
        const getWhereKeyword = () => SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'

        if (typeof expr === 'string' && op !== undefined) {
          const operator = String(op).toLowerCase()
          // Keep `.where('col', 'in', vals)` at parity with the
          // array form (`.where(['col', 'in', vals])`, line ~3596).
          // Without this branch, IN-with-string-form emits a single
          // placeholder (`col IN ?`) and SQLite rejects it. See
          // https://github.com/stacksjs/bun-query-builder/issues/1013
          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(value) ? value : [value]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            const clause = `${String(expr)} ${operator.toUpperCase()} (${placeholders})`
            whereConditions.push(clause)
            whereParams.push(...values)
            text = `${text} ${getWhereKeyword()} ${clause}`
            built = null
            return this
          }
          const paramIndex = whereParams.length + 1
          whereConditions.push(`${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`)
          whereParams.push(value)
          // Update built and text immediately
          text = `${text} ${getWhereKeyword()} ${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`
          built = null
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            whereConditions.push(`${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} ${getWhereKeyword()} ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = null
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`${colName} ${operator} ${getPlaceholder(paramIndex)}`)
            whereParams.push(val)
            text = `${text} ${getWhereKeyword()} ${colName} ${operator} ${getPlaceholder(paramIndex)}`
            built = null
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !isRawExpression(expr)) {
          const whereObject = expr as Record<string, unknown>
          const keys = Object.keys(whereObject)
          const conditions: string[] = []

          for (const key of keys) {
            const value = whereObject[key]
            if (Array.isArray(value)) {
              const placeholders = getPlaceholders(value.length, whereParams.length + 1)
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
              whereConditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} ${getWhereKeyword()} ${conditions.join(' AND ')}`
            built = null
          }
          return this
        }

        // Handle raw expressions
        if (isRawExpression(expr)) {
          whereConditions.push(expr.raw)
          text = `${text} ${getWhereKeyword()} ${expr.raw}`
          built = null
          return this
        }

        return this
      },
      // where helpers
      whereNull(column: string) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${keyword} ${String(column)} IS NULL`
        built = null
        return this
      },
      whereNotNull(column: string) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${keyword} ${String(column)} IS NOT NULL`
        built = null
        return this
      },
      whereBetween(column: string, start: any, end: any) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        // Dialect-aware placeholders: Postgres needs `$n`, not `?` (#1027).
        const i = whereParams.length + 1
        text = `${text} ${keyword} ${String(column)} BETWEEN ${getPlaceholder(i)} AND ${getPlaceholder(i + 1)}`
        whereParams.push(start, end)
        built = null
        return this
      },
      whereExists(subquery: { toSQL: () => any }) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text = `${text} ${keyword} EXISTS (${subquery.toSQL()})`
        built = null
        return this
      },
      whereJsonContains(column: string, json: unknown) {
        // Dialect-aware JSON containment. Previously hardcoded Postgres `@>`,
        // which is a syntax error on MySQL/SQLite and ignored the configured
        // `jsonContainsMode`. See stacksjs/bun-query-builder#1026.
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const dialect = config.dialect
        const idx = whereParams.length + 1
        if (dialect === 'postgres') {
          // operator (`@>`, default) or function (`jsonb_contains`) per config.
          if (config.sql?.jsonContainsMode === 'function')
            text += ` ${keyword} jsonb_contains(${column}, ${getPlaceholder(idx)})`
          else
            text += ` ${keyword} ${column} @> ${getPlaceholder(idx)}`
          whereParams.push(JSON.stringify(json))
        }
        else if (dialect === 'mysql') {
          text += ` ${keyword} JSON_CONTAINS(${column}, ${getPlaceholder(idx)})`
          whereParams.push(JSON.stringify(json))
        }
        else {
          // SQLite has no native JSON containment. Use json_each membership,
          // which covers the common "array contains value(s)" case
          // (`whereJsonContains('tags', ['bun'])`). For an array, every listed
          // value must be present.
          if (Array.isArray(json)) {
            const conds = json.map((_, i) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${getPlaceholder(idx + i)})`)
            text += ` ${keyword} (${conds.join(' AND ')})`
            for (const v of json) whereParams.push(v as any)
          }
          else if (json !== null && typeof json === 'object') {
            throw new Error('[query-builder] whereJsonContains: object containment is not supported on SQLite — pass a scalar or array, or use whereJsonPath.')
          }
          else {
            text += ` ${keyword} EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${getPlaceholder(idx)})`
            whereParams.push(json as any)
          }
        }
        built = null
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
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const idx = whereParams.length + 1
        if (dialect === 'postgres') {
          text += ` ${keyword} ${path} ${op} ${getPlaceholder(idx)}`
        }
        else if (dialect === 'mysql') {
          text += ` ${keyword} JSON_EXTRACT(${path}) ${op} ${getPlaceholder(idx)}`
        }
        else {
          text += ` ${keyword} json_extract(${path}) ${op} ${getPlaceholder(idx)}`
        }
        whereParams.push(value)
        built = null
        return this as any
      },
      // The LIKE/ILIKE family keeps a `built` tagged-template representation AND
      // a `text`/`whereParams` shadow. Each must push the pattern into
      // `whereParams` (with a dialect-aware placeholder), or a later `built =
      // null` invalidation rebuilds from `text` with the pattern missing and
      // the placeholders misaligned. See stacksjs/bun-query-builder#1028.
      whereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
        built = sql`${ensureBuilt()} WHERE ${expr}`
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        return this as any
      },
      whereILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres') {
          built = sql`${ensureBuilt()} WHERE ${sql(String(column))} ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} ILIKE ${ph}`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
          built = sql`${ensureBuilt()} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) LIKE LOWER(${ph})`)
        }
        whereParams.push(pattern)
        return this as any
      },
      orWhereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
        built = sql`${ensureBuilt()} OR ${expr}`
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        return this as any
      },
      orWhereILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres') {
          built = sql`${ensureBuilt()} OR ${sql(String(column))} ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} ILIKE ${ph}`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
          built = sql`${ensureBuilt()} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) LIKE LOWER(${ph})`)
        }
        whereParams.push(pattern)
        return this as any
      },
      whereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} NOT LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = sql`${ensureBuilt()} WHERE ${expr}`
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        return this as any
      },
      whereNotILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres') {
          built = sql`${ensureBuilt()} WHERE ${sql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} NOT ILIKE ${ph}`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = sql`${ensureBuilt()} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) NOT LIKE LOWER(${ph})`)
        }
        whereParams.push(pattern)
        return this as any
      },
      orWhereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} NOT LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = sql`${ensureBuilt()} OR ${expr}`
        const ph = getPlaceholder(whereParams.length + 1)
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? ph : `LOWER(${ph})`}`)
        whereParams.push(pattern)
        return this as any
      },
      orWhereNotILike(column: string, pattern: string) {
        const ph = getPlaceholder(whereParams.length + 1)
        if (config.dialect === 'postgres') {
          built = sql`${ensureBuilt()} OR ${sql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} NOT ILIKE ${ph}`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = sql`${ensureBuilt()} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) NOT LIKE LOWER(${ph})`)
        }
        whereParams.push(pattern)
        return this as any
      },
      whereAny(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0) return this as any
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        text += ` ${keyword} (${conds.join(' OR ')})`
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        built = null
        return this as any
      },
      whereAll(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0) return this as any
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        text += ` ${keyword} (${conds.join(' AND ')})`
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        built = null
        return this as any
      },
      whereNone(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0) return this as any
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const idx = whereParams.length + 1
        const conds = cols.map((c, i) => `${c} ${op} ${getPlaceholder(idx + i)}`)
        text += ` ${keyword} NOT (${conds.join(' OR ')})`
        for (let i = 0; i < cols.length; i++) whereParams.push(value)
        built = null
        return this as any
      },
      whereNotBetween(column: string, start: any, end: any) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const i = whereParams.length + 1
        text += ` ${keyword} ${column} NOT BETWEEN ${getPlaceholder(i)} AND ${getPlaceholder(i + 1)}`
        whereParams.push(start, end)
        built = null
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
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const idx = whereParams.length + 1
        text += ` ${keyword} ${column} ${op} ${getPlaceholder(idx)}`
        whereParams.push(dateString)
        built = null
        return this as any
      },
      whereRaw(fragment: any) {
        assertSqlFragment(fragment, 'whereRaw(fragment)')
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text += ` ${keyword} ${String(fragment)}`
        built = null
        return this as any
      },
      whereColumn(left: string, op: WhereOperator, right: string) {
        validateIdentifier(left, 'whereColumn(left)')
        validateIdentifier(right, 'whereColumn(right)')
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        text += ` ${keyword} ${left} ${op} ${right}`
        built = null
        return this as any
      },
      orWhereColumn(left: string, op: WhereOperator, right: string) {
        validateIdentifier(left, 'orWhereColumn(left)')
        validateIdentifier(right, 'orWhereColumn(right)')
        text += ` OR ${left} ${op} ${right}`
        built = null
        return this as any
      },
      whereIn(column: string, values: any[] | { toSQL: () => any }) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          text += ` ${keyword} ${column} IN (${placeholders})`
          whereParams.push(...values)
        }
        else {
          text += ` ${keyword} ${column} IN (${String((values as any).toSQL())})`
        }
        built = null
        return this as any
      },
      orWhereIn(column: string, values: any[] | { toSQL: () => any }) {
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          text += ` OR ${column} IN (${placeholders})`
          whereParams.push(...values)
        }
        else {
          text += ` OR ${column} IN (${String((values as any).toSQL())})`
        }
        built = null
        return this as any
      },
      whereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          text += ` ${keyword} ${column} NOT IN (${placeholders})`
          whereParams.push(...values)
        }
        else {
          text += ` ${keyword} ${column} NOT IN (${String((values as any).toSQL())})`
        }
        built = null
        return this as any
      },
      orWhereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        if (Array.isArray(values)) {
          const placeholders = getPlaceholders(values.length, whereParams.length + 1)
          text += ` OR ${column} NOT IN (${placeholders})`
          whereParams.push(...values)
        }
        else {
          text += ` OR ${column} NOT IN (${String((values as any).toSQL())})`
        }
        built = null
        return this as any
      },
      whereNested(fragment: any) {
        const keyword = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'
        const inner = fragment.toSQL ? String(fragment.toSQL()) : String(fragment)
        text += ` ${keyword} (${inner})`
        built = null
        return this as any
      },
      orWhereNested(fragment: any) {
        const inner = fragment.toSQL ? String(fragment.toSQL()) : String(fragment)
        text += ` OR (${inner})`
        built = null
        return this as any
      },
      andWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          const paramIndex = whereParams.length + 1
          whereConditions.push(`${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`)
          whereParams.push(value)
          text = `${text} AND ${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`
          built = null
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            whereConditions.push(`${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} AND ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = null
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`${colName} ${operator} ${getPlaceholder(paramIndex)}`)
            whereParams.push(val)
            text = `${text} AND ${colName} ${operator} ${getPlaceholder(paramIndex)}`
            built = null
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const conditions: string[] = []

          for (const key of keys) {
            const value = (expr as any)[key]
            if (Array.isArray(value)) {
              const placeholders = getPlaceholders(value.length, whereParams.length + 1)
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
              whereConditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} AND ${conditions.join(' AND ')}`
            built = null
          }
          return this
        }

        // Handle raw expressions
        if (expr && typeof (expr as any).raw !== 'undefined') {
          whereConditions.push((expr as any).raw)
          text = `${text} AND ${(expr as any).raw}`
          built = null
          return this
        }

        return this
      },
      orWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          const paramIndex = whereParams.length + 1
          whereConditions.push(`OR ${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`)
          whereParams.push(value)
          text = `${text} OR ${String(expr)} ${String(op)} ${getPlaceholder(paramIndex)}`
          built = null
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = getPlaceholders(values.length, whereParams.length + 1)
            whereConditions.push(`OR ${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} OR ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = null
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`OR ${colName} ${operator} ${getPlaceholder(paramIndex)}`)
            whereParams.push(val)
            text = `${text} OR ${colName} ${operator} ${getPlaceholder(paramIndex)}`
            built = null
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const conditions: string[] = []

          for (const key of keys) {
            const value = (expr as any)[key]
            if (Array.isArray(value)) {
              const placeholders = getPlaceholders(value.length, whereParams.length + 1)
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`OR ${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = ${getPlaceholder(paramIndex)}`)
              whereConditions.push(`OR ${key} = ${getPlaceholder(paramIndex)}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} OR ${conditions.join(' AND ')}`
            built = null
          }
          return this
        }

        // Handle raw expressions
        if (expr && typeof (expr as any).raw !== 'undefined') {
          whereConditions.push(`OR ${(expr as any).raw}`)
          text = `${text} OR ${(expr as any).raw}`
          built = null
          return this
        }

        return this
      },
      orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
        // Compose-aware: detect an existing ORDER BY clause and append the
        // new column with a comma instead of emitting a second `ORDER BY`,
        // which is invalid SQL. Without this fix, calling .orderBy() twice
        // produced `ORDER BY a ASC ORDER BY b ASC` and SQLite/MySQL/Postgres
        // all rejected it.
        const dir = direction === 'asc' ? 'ASC' : 'DESC'
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${column} ${dir}`
          : `${text} ORDER BY ${column} ${dir}`
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
        insertJoin(`INNER JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      leftJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        insertJoin(`LEFT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      leftJoinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        insertJoin(`LEFT JOIN (${String(sub.toSQL())}) AS ${alias} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(alias)
        return this as any
      },
      rightJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        insertJoin(`RIGHT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`)
        joinedTables.add(table2)
        return this as any
      },
      crossJoin(table2: string) {
        insertJoin(`CROSS JOIN ${table2}`)
        joinedTables.add(table2)
        return this as any
      },
      crossJoinSub(sub: { toSQL: () => any }, alias: string) {
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
            ? `${text}, ${cols.join(', ')}`
            : `${text} GROUP BY ${cols.join(', ')}`
          built = null
        }
        return this as any
      },
      groupByRaw(fragment: any) {
        assertSqlFragment(fragment, 'groupByRaw(fragment)')
        text = SQL_PATTERNS.GROUP_BY.test(text)
          ? `${text}, ${String(fragment)}`
          : `${text} GROUP BY ${String(fragment)}`
        built = null
        return this as any
      },
      having(expr: any) {
        // Chained having() calls join with AND, not a second HAVING keyword
        // (`HAVING a HAVING b` is invalid). See stacksjs/bun-query-builder#1034.
        const kw = /\bHAVING\b/i.test(text) ? 'AND' : 'HAVING'
        // Handle array format: ['COUNT(id)', '>', 3]
        if (Array.isArray(expr)) {
          const paramIdx = whereParams.length + 1
          text = `${text} ${kw} ${expr[0]} ${expr[1]} ${getPlaceholder(paramIdx)}`
          whereParams.push(expr[2])
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
            built = null
          }
        }
        // Handle raw expressions
        else if (expr && typeof (expr as any).raw !== 'undefined') {
          text += ` ${kw} ${(expr as any).raw}`
          built = null
        }
        return this as any
      },
      havingRaw(fragment: any) {
        assertSqlFragment(fragment, 'havingRaw(fragment)')
        const kw = /\bHAVING\b/i.test(text) ? 'AND' : 'HAVING'
        text += ` ${kw} ${String(fragment)}`
        built = null
        return this as any
      },
      orderByRaw(fragment: any) {
        assertSqlFragment(fragment, 'orderByRaw(fragment)')
        text = SQL_PATTERNS.ORDER_BY.test(text)
          ? `${text}, ${String(fragment)}`
          : `${text} ORDER BY ${String(fragment)}`
        built = null
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
        return makeExecutableQuery(ensureBuilt(), reorderSelectClauses(text)) as any
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
      async paginate(perPage: number, page = 1) {
        if (!Number.isFinite(perPage) || perPage <= 0 || !Number.isInteger(perPage))
          throw new TypeError(`[query-builder] paginate(perPage): expected positive integer, got ${perPage}`)
        if (!Number.isFinite(page) || page < 1 || !Number.isInteger(page))
          throw new TypeError(`[query-builder] paginate(page): expected integer >= 1, got ${page}`)

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
        let q = ensureBuilt()
        if (cursor !== undefined && cursor !== null) {
          if (Array.isArray(column)) {
            const cols = column.map(c => sql(String(c)))
            const comp = direction === 'asc' ? sql`>` : sql`<`
            const tupleCols = sql`(${sql(cols as any)})`
            const tupleVals = sql`(${sql(cursor as any)})`
            q = sql`${q} WHERE ${tupleCols} ${comp} ${tupleVals}`
          }
          else {
            q = direction === 'asc'
              ? sql`${q} WHERE ${sql(String(column))} > ${cursor}`
              : sql`${q} WHERE ${sql(String(column))} < ${cursor}`
          }
        }
        if (Array.isArray(column)) {
          const orderParts = column.map(c => sql`${sql(String(c))} ${direction === 'asc' ? sql`ASC` : sql`DESC`}`)
          const orderExpr = orderParts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`))
          q = sql`${q} ORDER BY ${orderExpr} LIMIT ${perPage + 1}`
        }
        else {
          q = sql`${q} ORDER BY ${sql(String(column))} ${direction === 'asc' ? sql`ASC` : sql`DESC`} LIMIT ${perPage + 1}`
        }
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const next = rows.length > perPage
          ? (Array.isArray(column) ? column.map(c => rows[perPage]?.[c]) : rows[perPage]?.[column])
          : null
        const data = rows.slice(0, perPage)
        const prevCursor = data.length ? (Array.isArray(column) ? column.map(c => data[0]?.[c]) : data[0]?.[column]) : null
        return { data, meta: { perPage, nextCursor: next ?? null, prevCursor } }
      },
      async chunk(size: number, handler: (rows: any[]) => Promise<void> | void) {
        let page = 1
        while (true) {
          const { data } = await (this as any).paginate(size, page)
          if (data.length === 0)
            break
          await handler(data as any[])
          if (data.length < size)
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
        return text
      },
      async get() {
        const hooks = config.hooks
        const hasQueryHooks = hooks && (hooks.onQueryStart || hooks.onQueryEnd || hooks.onQueryError || hooks.startSpan || hasSlowQueryHook(hooks))

        // Ultra-fast path: skip unsafe() entirely, use _prepareStatement for direct stmt access
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !hasQueryHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const stmt = prepareFn(text)
            return hydratePivotRows(whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all())
          }
        }

        // Build query at execution time (statement will be cached by db-clients.ts)
        built = whereParams.length > 0
          ? _sql.unsafe(text, whereParams)
          : _sql.unsafe(text)

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
          if (hasCol && !SQL_PATTERNS.DELETED_AT.test(text)) {
            finalQuery = sql`${ensureBuilt()} WHERE ${sql(String(col))} IS ${onlyTrashed ? sql`NOT NULL` : sql`NULL`}`
            addWhereText('WHERE', `${String(col)} IS ${onlyTrashed ? 'NOT ' : ''}NULL`)
          }
        }

        // Check cache if enabled
        if (useCache) {
          const cacheKey = String(finalQuery)
          const cached = queryCache.get(cacheKey)
          if (cached)
            return cached
        }

        const result = await runWithHooks<any[]>(finalQuery, 'select', { signal: abortSignal, timeoutMs })

        // Store in cache if enabled
        if (useCache) {
          const cacheKey = String(finalQuery)
          queryCache.set(cacheKey, result, cacheTtl)
        }

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
        const fHooks = config.hooks
        const fHasQueryHooks = fHooks && (fHooks.onQueryStart || fHooks.onQueryEnd || fHooks.onQueryError || fHooks.startSpan || hasSlowQueryHook(fHooks))
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !fHasQueryHooks) {
          const prepareFn = _sql._prepareStatement
          if (prepareFn) {
            const firstText = text.includes(' LIMIT ') ? text : `${text} LIMIT 1`
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
        const fromIdx = text.indexOf(' FROM ')
        const hasGroupBy = / GROUP BY /i.test(text)
        let countText: string
        if (hasGroupBy) {
          countText = `SELECT COUNT(*) as c FROM (${text}) AS _bqb_count_sub`
        }
        else if (fromIdx !== -1) {
          countText = `SELECT COUNT(*) as c${text.substring(fromIdx)}`
        }
        else {
          countText = `SELECT COUNT(*) as c FROM ${table}`
        }

        // Ultra-fast path
        const cHooks = config.hooks
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
        const fromIdx = text.indexOf(' FROM ')
        const avgText = fromIdx !== -1
          ? `SELECT AVG(${column}) as a${text.substring(fromIdx)}`
          : `SELECT AVG(${column}) as a FROM ${table}`

        // Ultra-fast path
        const aHooks = config.hooks
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
        const fromIdx = text.indexOf(' FROM ')
        const sumText = fromIdx !== -1
          ? `SELECT SUM(${column}) as s${text.substring(fromIdx)}`
          : `SELECT SUM(${column}) as s FROM ${table}`
        const q = whereParams.length > 0
          ? _sql.unsafe(sumText, whereParams)
          : _sql.unsafe(sumText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.s ?? 0)
      },
      async max(column: string) {
        const fromIdx = text.indexOf(' FROM ')
        const maxText = fromIdx !== -1
          ? `SELECT MAX(${column}) as m${text.substring(fromIdx)}`
          : `SELECT MAX(${column}) as m FROM ${table}`
        const q = whereParams.length > 0
          ? _sql.unsafe(maxText, whereParams)
          : _sql.unsafe(maxText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.m
      },
      async min(column: string) {
        const fromIdx = text.indexOf(' FROM ')
        const minText = fromIdx !== -1
          ? `SELECT MIN(${column}) as m${text.substring(fromIdx)}`
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
        return (ensureBuilt() as any).values?.() ?? []
      },
      // Internal: the builder's finalized SQL text + ordered bound params, used
      // by union()/unionAll() on the other side to merge params and renumber
      // placeholders. See stacksjs/bun-query-builder#1029.
      __rawState() {
        return { sql: reorderSelectClauses(text), params: [...whereParams] }
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
          const raw = prop.replace(/^or?where/i, '').replace(/^andwhere/i, '')
          if (!raw)
            return () => receiver
          const lowerFirst = raw.charAt(0).toLowerCase() + raw.slice(1)
          const toSnake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
          const snake = toSnake(raw)
          const tbl = String(table)
          const available: string[] = schema ? Object.keys(((schema as any)[tbl]?.columns) ?? {}) : []
          const chosen = [snake, lowerFirst, lowerFirst.toLowerCase()].find(n => available.includes(n)) ?? snake
          return (value: any) => {
            const expr = Array.isArray(value)
              ? sql`${sql(String(chosen))} IN ${sql(value as any)}`
              : sql`${sql(String(chosen))} = ${value}`
            built = isOr
              ? sql`${ensureBuilt()} OR ${expr}`
              : isAnd
                ? sql`${ensureBuilt()} AND ${expr}`
                : sql`${ensureBuilt()} WHERE ${expr}`
            // update textual representation
            const clause = Array.isArray(value) ? `${String(chosen)} IN (?)` : `${String(chosen)} = ?`
            addWhereText(isOr ? 'OR' : isAnd ? 'AND' : 'WHERE', clause)
            return receiver
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return proxy as any
  }

  return {
    // Create a builder with per-instance option overrides
    configure(opts: Partial<typeof config>) {
      // This keeps types simple; for now, users can set global config via import
      Object.assign(config, opts)
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

      // Create a proper query builder that mimics makeSelect but works with subqueries
      const sql = _sql
      const q = _sql`SELECT * FROM (${sub.toSQL()}) AS ${_sql(alias)}`

      // Build the base API similar to makeSelect
      const base: BaseSelectQueryBuilder<DB, any, any, any> = {
        distinct() {
          const rest = String(q).replace(/^SELECT\s+/i, '')
          const newQ = sql`SELECT DISTINCT ${sql``}${sql(rest)}`
          return createSubQueryBuilder(newQ) as any
        },
        distinctOn(...columns: any[]) {
          const match = /^SELECT\s+(\S+)\s+FROM/i.exec(String(q))
          const body = match ? `${match[1]} FROM` : String(q)
          const newQ = sql`SELECT DISTINCT ON (${sql(columns as any)}) ${sql``}${sql(body)}`
          return createSubQueryBuilder(newQ) as any
        },
        selectRaw(fragment: any) {
          const newQ = sql`${q} , ${fragment}`
          return createSubQueryBuilder(newQ) as any
        },
        where(expr: any, op?: WhereOperator, value?: any) {
          // Apply where condition to the subquery
          const newQ = applyWhereCondition(q, expr, op, value, 'WHERE')
          return createSubQueryBuilder(newQ) as any
        },
        andWhere(expr: any, op?: WhereOperator, value?: any) {
          const newQ = applyWhereCondition(q, expr, op, value, 'AND')
          return createSubQueryBuilder(newQ) as any
        },
        orWhere(expr: any, op?: WhereOperator, value?: any) {
          const newQ = applyWhereCondition(q, expr, op, value, 'OR')
          return createSubQueryBuilder(newQ) as any
        },
        orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
          // Compose-aware on subqueries too — chaining orderBy twice should
          // produce a single comma-separated clause, not two ORDER BYs.
          const dir = direction === 'asc' ? 'ASC' : 'DESC'
          const current = String(q)
          const newQ = SQL_PATTERNS.ORDER_BY.test(current)
            ? sql.unsafe(`${current}, ${column} ${dir}`)
            : sql`${q} ORDER BY ${sql(column)} ${direction === 'asc' ? sql`ASC` : sql`DESC`}`
          return createSubQueryBuilder(newQ) as any
        },
        limit(n: number) {
          // Repeat-call replaces, matching the parent builder's semantics.
          const current = String(q)
          const newQ = SQL_PATTERNS.LIMIT.test(current)
            ? sql.unsafe(current.replace(SQL_PATTERNS.LIMIT, ` LIMIT ${n}`))
            : sql`${q} LIMIT ${n}`
          return createSubQueryBuilder(newQ) as any
        },
        offset(n: number) {
          const current = String(q)
          const newQ = SQL_PATTERNS.OFFSET.test(current)
            ? sql.unsafe(current.replace(SQL_PATTERNS.OFFSET, ` OFFSET ${n}`))
            : sql`${q} OFFSET ${n}`
          return createSubQueryBuilder(newQ) as any
        },
        toSQL() {
          return makeExecutableQuery(q) as any
        },
        async execute() {
          return runWithHooks<any[]>(q, 'select')
        },
        async executeTakeFirst() {
          const rows = await runWithHooks<any[]>(q, 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async executeTakeFirstOrThrow() {
          const rows = await runWithHooks<any[]>(q, 'select')
          const first = Array.isArray(rows) ? rows[0] : rows
          if (!first)
            throw new Error('Record not found')
          return first
        },
        async get() {
          return runWithHooks<any[]>(q, 'select')
        },
        async first() {
          const rows = await runWithHooks<any[]>(q, 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async firstOrFail() {
          const rows = await runWithHooks<any[]>(q, 'select')
          const first = Array.isArray(rows) ? rows[0] : rows
          if (!first)
            throw new Error('No rows found')
          return first
        },
        async exists() {
          const countQ = sql`SELECT EXISTS(${q}) as exists`
          const result = await runWithHooks<any[]>(countQ, 'select')
          return result?.[0]?.exists === true
        },
        async doesntExist() {
          const exists = await this.exists()
          return !exists
        },
        values() {
          return (q as any).values()
        },
        raw() {
          return (q as any).raw()
        },
        cancel() {
          try {
            ;(q as any).cancel()
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
        whereNotNull: subqueryNotSupported('whereNotNull'),
        whereExists: subqueryNotSupported('whereExists'),
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
        count: subqueryNotSupported('count'),
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
        pipe: (fn: any) => fn(this),
        when: subqueryNotSupported('when'),
        tap: () => this as any,
        dump: () => this as any,
        dd: () => { throw new Error('Dump and Die') },
        explain: () => Promise.resolve([]),
        simple: () => (q as any).simple(),
        toText: () => String(q),
        toParams: () => (q as any).values?.() ?? [],
        withTimeout: () => this as any,
        abort: () => this as any,
        lockForUpdate: () => this as any,
        sharedLock: () => this as any,
        withCTE: () => this as any,
        withRecursive: () => this as any,
        cache: () => this as any,
        clone: () => this as any,
        withTrashed: () => this as any,
        onlyTrashed: () => this as any,
        scope: () => this as any,
        // Type-only properties
        get rows() { return [] as any },
        get row() { return undefined as any },
      }

      // Helper function to create a new subquery builder with updated SQL
      function createSubQueryBuilder(newQ: any) {
        return {
          ...base,
          toSQL: () => makeExecutableQuery(newQ) as any,
          execute: () => runWithHooks<any[]>(newQ, 'select'),
          get: () => runWithHooks<any[]>(newQ, 'select'),
          first: async () => {
            const rows = await runWithHooks<any[]>(newQ, 'select')
            return Array.isArray(rows) ? rows[0] : rows
          },
          firstOrFail: async () => {
            const rows = await runWithHooks<any[]>(newQ, 'select')
            const first = Array.isArray(rows) ? rows[0] : rows
            if (!first)
              throw new Error('No rows found')
            return first
          },
          exists: async () => {
            const countQ = sql`SELECT EXISTS(${newQ}) as exists`
            const result = await runWithHooks<any[]>(countQ, 'select')
            return result?.[0]?.exists === true
          },
          doesntExist: async () => {
            const exists = await base.exists()
            return !exists
          },
          values: () => (newQ as any).values(),
          raw: () => (newQ as any).raw(),
          cancel: () => {
            try {
              ;(newQ as any).cancel()
            }
            catch {}
          },
          simple: () => (newQ as any).simple(),
          toText: () => String(newQ),
          toParams: () => (newQ as any).values?.() ?? [],
        }
      }

      // Helper function to apply where conditions
      function applyWhereCondition(query: any, expr: any, op?: WhereOperator, value?: any, prefix: 'WHERE' | 'AND' | 'OR' = 'WHERE') {
        if (typeof expr === 'string' && op !== undefined) {
          const clause = Array.isArray(value) ? `${expr} IN (?)` : `${expr} ${op} ?`
          return sql`${query} ${sql(prefix)} ${sql(clause)}`
        }
        else if (Array.isArray(expr) && expr.length === 3) {
          const [column, operator, val] = expr
          const clause = Array.isArray(val) ? `${column} IN (?)` : `${column} ${operator} ?`
          return sql`${query} ${sql(prefix)} ${sql(clause)}`
        }
        else if (typeof expr === 'object' && expr !== null) {
          const conditions = Object.entries(expr).map(([key, val]) => {
            const clause = Array.isArray(val) ? `${key} IN (?)` : `${key} = ?`
            return sql`${sql(clause)}`
          })
          const combined = conditions.reduce((acc, cond, i) =>
            i === 0 ? cond : sql`${acc} AND ${cond}`,
          )
          return sql`${query} ${sql(prefix)} ${combined}`
        }
        return query
      }

      return base as any
    },
    insertInto<TTable extends keyof DB & string>(table: TTable) {
      let built: any
      let sqlText = ''
      const params: any[] = []
      const isPostgres = config.dialect === 'postgres'

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
        : config.dialect === 'mysql'
          ? (id: string): string => `\`${String(id).replace(/`/g, '``')}\``
          : (id: string): string => `"${String(id).replace(/"/g, '""')}"`

      // Get placeholder based on dialect
      const getPlaceholder = isPostgres
        ? (index: number): string => `$${index + 1}`
        : (_index: number): string => '?'

      return {
        values(data: Partial<any> | Partial<any>[]) {
          const rows = Array.isArray(data) ? data : [data]
          const rowCount = rows.length
          if (rowCount === 0) {
            built = _sql.unsafe('SELECT 1')
            return this
          }

          const firstRow = rows[0]
          const keys = Object.keys(firstRow)
          const colCount = keys.length

          // Pre-allocate params array
          const totalParams = rowCount * colCount
          params.length = totalParams

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
              const columnList = keys.map(k => quoteId(k)).join(',')
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
          // Append RETURNING clause to the existing SQL
          const returningSql = `${sqlText} RETURNING ${cols.join(', ')}`
          const q = _sql.unsafe(returningSql, params)
          return {
            where: () => this,
            andWhere: () => this,
            orWhere: () => this,
            orderBy: () => this,
            limit: () => this,
            offset: () => this,
            toSQL: () => makeExecutableQuery(q, returningSql) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
          }
        },
        toSQL() {
          if (!built) built = _sql.unsafe(sqlText, params)
          return makeExecutableQuery(built, sqlText) as any
        },
        execute() {
          // Ultra-fast path: use _prepareStatement to skip unsafe() and runWithHooks overhead
          const hooks = config.hooks
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
          if (!built) built = _sql.unsafe(sqlText, params)
          const result = await runWithHooks(built, 'insert')
          return result
        },
        async executeTakeFirstOrThrow() {
          if (!built) built = _sql.unsafe(sqlText, params)
          const result = await runWithHooks(built, 'insert')
          if (!result)
            throw new Error('Insert failed')
          return result
        },
        returningAll() {
          const returningSql = `${sqlText} RETURNING *`
          const q = _sql.unsafe(returningSql, params)
          return {
            toSQL: () => makeExecutableQuery(q, returningSql) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
            async executeTakeFirst() {
              const result = await runWithHooks<any[]>(q, 'insert')
              return Array.isArray(result) ? result[0] : result
            },
            async executeTakeFirstOrThrow() {
              const result = await runWithHooks<any[]>(q, 'insert')
              const first = Array.isArray(result) ? result[0] : result
              if (!first)
                throw new Error('Insert with RETURNING failed')
              return first
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
        if (config.dialect === 'mysql')
          return `\`${s.replace(/`/g, '``')}\``
        return `"${s.replace(/"/g, '""')}"`
      }

      let sqlText = `UPDATE ${quoteId(String(table))}`

      return {
        set(values) {
          const keys = Object.keys(values)
          const len = keys.length
          const setClauses: string[] = Array.from({ length: len })
          for (let i = 0; i < len; i++) {
            const key = keys[i]
            setClauses[i] = `${quoteId(key)} = ${getPlaceholder(i + 1)}`
            params.push((values as any)[key])
          }
          sqlText = `${sqlText} SET ${setClauses.join(', ')}`
          built = _sql.unsafe(sqlText, params)
          return this
        },
        where(expr: any, op?: string, value?: any) {
          // Helper to get the correct keyword (WHERE for first condition, AND for subsequent)
          const getWhereKeyword = () => SQL_PATTERNS.WHERE.test(sqlText) ? 'AND' : 'WHERE'

          // Handle 3-arg format: where('column', '=', value)
          if (typeof expr === 'string' && op !== undefined) {
            const paramIndex = params.length + 1
            sqlText = `${sqlText} ${getWhereKeyword()} ${quoteId(expr)} ${op} ${getPlaceholder(paramIndex)}`
            params.push(value)
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // Handle array format: where(['column', 'op', value])
          if (Array.isArray(expr)) {
            const [col, op, val] = expr
            const paramIndex = params.length + 1
            sqlText = `${sqlText} ${getWhereKeyword()} ${quoteId(String(col))} ${String(op)} ${getPlaceholder(paramIndex)}`
            params.push(val)
            built = _sql.unsafe(sqlText, params)
            return this
          }

          // Handle object format: where({ column: value })
          if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const keys = Object.keys(expr)
            const len = keys.length
            const baseIdx = params.length
            const conditions: string[] = Array.from({ length: len })
            for (let i = 0; i < len; i++) {
              conditions[i] = `${quoteId(keys[i])} = ${getPlaceholder(baseIdx + i + 1)}`
              params.push((expr as any)[keys[i]])
            }
            sqlText = `${sqlText} ${getWhereKeyword()} ${conditions.join(' AND ')}`
            built = _sql.unsafe(sqlText, params)
          }
          return this
        },
        returning(...cols) {
          const retText = `${sqlText} RETURNING ${cols.join(', ')}`
          const q = params.length > 0
            ? _sql.unsafe(retText, params)
            : _sql.unsafe(retText)
          const obj: any = {
            where: () => obj,
            andWhere: () => obj,
            orWhere: () => obj,
            orderBy: () => obj,
            limit: () => obj,
            offset: () => obj,
            toSQL: () => makeExecutableQuery(q, retText) as any,
            execute: () => runWithHooks<any[]>(q, 'update'),
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
        execute() {
          return runWithHooks<number>(built, 'update')
        },
        async executeTakeFirst() {
          const result = await runWithHooks<number>(built, 'update')
          return { numUpdatedRows: result }
        },
        async executeTakeFirstOrThrow() {
          const result = await runWithHooks<number>(built, 'update')
          if (result === 0)
            throw new Error('No rows updated')
          return { numUpdatedRows: result }
        },
        returningAll() {
          const retAllText = `${sqlText} RETURNING *`
          const q = params.length > 0
            ? _sql.unsafe(retAllText, params)
            : _sql.unsafe(retAllText)
          return {
            toSQL: () => makeExecutableQuery(q, retAllText) as any,
            execute: () => runWithHooks<any[]>(q, 'update'),
            async executeTakeFirst() {
              const result = await runWithHooks<any[]>(q, 'update')
              return Array.isArray(result) ? result[0] : result
            },
            async executeTakeFirstOrThrow() {
              const result = await runWithHooks<any[]>(q, 'update')
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
        if (config.dialect === 'mysql')
          return `\`${s.replace(/`/g, '``')}\``
        return `"${s.replace(/"/g, '""')}"`
      }

      const quotedTable = quoteId(String(table))
      let sqlText = `DELETE FROM ${quotedTable}`
      let built: any = null
      const delParams: any[] = []
      let whereCondition: any = null

      // First .where() emits ` WHERE `; subsequent calls emit ` AND `.
      // Without this, chained `.where('a', '=', 1).where('b', '=', 2)`
      // compiled to `... WHERE a = ? WHERE b = ?` and SQLite 500'd
      // with `near "WHERE": syntax error`. Mirrors the same helper in
      // updateTable() at line ~5454.
      // See https://github.com/stacksjs/bun-query-builder/issues/1015
      const getWhereKeyword = () => SQL_PATTERNS.WHERE.test(sqlText) ? 'AND' : 'WHERE'

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
            const paramIndex = delParams.length + 1
            sqlText += ` ${getWhereKeyword()} ${quoteId(expr)} ${op} ${getPlaceholder(paramIndex)}`
            delParams.push(value)
            built = null
            return this
          }
          // Support array format: where(['column', 'op', value])
          if (Array.isArray(expr)) {
            const [col, oper, val] = expr
            const paramIndex = delParams.length + 1
            sqlText += ` ${getWhereKeyword()} ${quoteId(String(col))} ${oper} ${getPlaceholder(paramIndex)}`
            delParams.push(val)
            built = null
            return this
          }
          // Object format: where({ id: 1 })
          if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const keys = Object.keys(expr)
            const conditions: string[] = []
            for (const key of keys) {
              const paramIndex = delParams.length + 1
              conditions.push(`${quoteId(key)} = ${getPlaceholder(paramIndex)}`)
              delParams.push((expr as any)[key])
            }
            sqlText += ` ${getWhereKeyword()} ${conditions.join(' AND ')}`
            built = null
            return this
          }
          built = applyWhere(({} as any), ensureDelBuilt(), expr)
          return this
        },
        returning(...cols) {
          const retText = `${sqlText} RETURNING ${cols.join(', ')}`
          const q = delParams.length > 0
            ? _sql.unsafe(retText, delParams)
            : _sql.unsafe(retText)
          const obj: any = {
            where: () => obj,
            andWhere: () => obj,
            orWhere: () => obj,
            orderBy: () => obj,
            limit: () => obj,
            offset: () => obj,
            toSQL: () => makeExecutableQuery(q, retText) as any,
            execute: () => runWithHooks<any[]>(q, 'delete'),
          }
          return obj
        },
        toSQL() {
          return makeExecutableQuery(ensureDelBuilt(), sqlText) as any
        },
        async execute() {
          try {
            await config.hooks?.beforeDelete?.({ table: String(table), where: whereCondition })
          }
          catch (err) {
            throw err
          }

          const result = await runWithHooks<number>(ensureDelBuilt(), 'delete')

          try {
            await config.hooks?.afterDelete?.({ table: String(table), where: whereCondition, result })
          }
          catch {}

          return result
        },
        async executeTakeFirst() {
          const result = await runWithHooks<number>(ensureDelBuilt(), 'delete')
          return { numDeletedRows: result }
        },
        async executeTakeFirstOrThrow() {
          const result = await runWithHooks<number>(ensureDelBuilt(), 'delete')
          if (result === 0)
            throw new Error('No rows deleted')
          return { numDeletedRows: result }
        },
        returningAll() {
          const retAllText = `${sqlText} RETURNING *`
          const q = delParams.length > 0
            ? _sql.unsafe(retAllText, delParams)
            : _sql.unsafe(retAllText)
          return {
            toSQL: () => makeExecutableQuery(q, retAllText) as any,
            execute: () => runWithHooks<any[]>(q, 'delete'),
            async executeTakeFirst() {
              const result = await runWithHooks<any[]>(q, 'delete')
              return Array.isArray(result) ? result[0] : result
            },
            async executeTakeFirstOrThrow() {
              const result = await runWithHooks<any[]>(q, 'delete')
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
        const s = String(key)
        let hash = 7
        for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
        const k = typeof key === 'number' ? key : Math.abs(hash)
        const q = bunSql`SELECT pg_advisory_lock(${k})`
        await runWithHooks<any[]>(q, 'raw')
        return
      }
      if (config.dialect === 'mysql') {
        // MySQL has `GET_LOCK(name, timeout)`. Wait indefinitely
        // (timeout=-1) to match Postgres `pg_advisory_lock` semantics.
        const lockName = `bqb:${String(key)}`
        const q = bunSql`SELECT GET_LOCK(${lockName}, -1) AS ok`
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
        const s = String(key)
        let hash = 7
        for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
        const k = typeof key === 'number' ? key : Math.abs(hash)
        const q = bunSql`SELECT pg_try_advisory_lock(${k}) as ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Boolean(rows?.[0]?.ok)
      }
      if (config.dialect === 'mysql') {
        // MySQL `GET_LOCK(name, 0)` returns 1 immediately if free, 0
        // if held by another connection.
        const lockName = `bqb:${String(key)}`
        const q = bunSql`SELECT GET_LOCK(${lockName}, 0) AS ok`
        const rows = await runWithHooks<any[]>(q, 'raw')
        return Number(rows?.[0]?.ok) === 1
      }
      // SQLite: no primitive. Return false (lock unavailable) so
      // callers fall through to whatever non-distributed path they
      // had. Loud throw would crash apps that gracefully degrade
      // when locks aren't held.
      return false
    },
    unsafe(query: string, params?: any[]) {
      return (bunSql as any).unsafe(query, params)
    },
    file(path: string, params?: any[]) {
      return (bunSql as any).file(path, params)
    },
    async reserve() {
      const reserved = await (bunSql as any).reserve()
      const qb = createQueryBuilder<DB>({ sql: reserved, meta, schema }) as any
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
        const q = bunSql`SELECT 1`
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
      const runWith = async (attempt: number): Promise<any> => {
        opts.logger?.({ type: 'start', attempt })
        const start = Date.now()
        return await (bunSql as any).begin(async (tx: any) => {
          const qb = createQueryBuilder<DB>({ sql: tx, meta, schema })

          // Transaction isolation + read-only mode — dialect-specific
          // SQL, with a clear "not supported" path for SQLite. The
          // previous code emitted Postgres syntax verbatim on every
          // dialect AND silently swallowed errors on the read-only
          // path, so callers asking for `readOnly: true` on MySQL
          // silently got a read-write transaction instead. Now each
          // dialect dispatches to its own SQL form; unsupported
          // combinations throw a clear error. See stacksjs/stacks#1862 #14.
          if (opts?.isolation) {
            const level = opts.isolation
            const upper = level === 'read committed'
              ? 'READ COMMITTED'
              : level === 'repeatable read'
                ? 'REPEATABLE READ'
                : 'SERIALIZABLE'
            if (config.dialect === 'postgres') {
              await (tx as any).unsafe(`SET TRANSACTION ISOLATION LEVEL ${upper}`)
            }
            else if (config.dialect === 'mysql') {
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
            else if (config.dialect === 'mysql') {
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
      const s: any = _sql
      if (!s || typeof s.savepoint !== 'function')
        throw new Error('savepoint() must be called inside a transaction')
      return await s.savepoint(async (sp: any) => {
        const qb = createQueryBuilder<DB>({ sql: sp, meta, schema })
        return await fn(qb)
      })
    },
    async beginDistributed(name, fn) {
      const res = await (bunSql as any).beginDistributed(name, async (tx: any) => {
        const qb = createQueryBuilder<DB>({ sql: tx, meta, schema })
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
      // Dialect-specific "insert ignoring duplicates" syntax. Previously
      // hardcoded `ON CONFLICT DO NOTHING` which works on Postgres +
      // SQLite but is a syntax error on MySQL — the framework's
      // "swap drivers seamlessly" claim broke at this method. MySQL
      // needs `INSERT IGNORE INTO`. See stacksjs/stacks#1862 #15.
      if (config.dialect === 'mysql') {
        const built = bunSql`INSERT IGNORE INTO ${bunSql(String(table))} ${bunSql(values as any)}`
        return (built as any).execute()
      }
      const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} ON CONFLICT DO NOTHING`
      return (built as any).execute()
    },
    async insertGetId(table, values, idColumn = 'id' as any) {
      if (config.dialect === 'mysql') {
        // MySQL doesn't support RETURNING, so we need to insert and then get the last insert ID
        // Use a single query to avoid connection issues
        const insertQuery = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)}`
        const result = await insertQuery.execute()

        // For MySQL, the result should contain the insertId
        if (result && typeof result === 'object' && 'insertId' in result) {
          return result.insertId
        }

        // Fallback: try to get LAST_INSERT_ID() in the same connection
        const [lastIdResult] = await bunSql`SELECT LAST_INSERT_ID() as id`.execute()
        return lastIdResult?.id
      }
      else {
        // PostgreSQL and other databases that support RETURNING
        const q = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} RETURNING ${bunSql(String(idColumn))} as id`
        const [row] = await q.execute()
        return row?.id
      }
    },
    async updateOrInsert(table, match, values) {
      const whereParts = Object.keys(match).map(k => bunSql`${bunSql(String(k))} = ${bunSql((match as any)[k])}`)
      const existsQ = bunSql`SELECT 1 FROM ${bunSql(String(table))} WHERE ${bunSql(whereParts as any)} LIMIT 1`
      const existsRows = await (existsQ as any).execute()
      if (existsRows.length) {
        const upd = bunSql`UPDATE ${bunSql(String(table))} SET ${bunSql(values as any)} WHERE ${bunSql(whereParts as any)}`
        await (upd as any).execute()
        return true
      }
      else {
        const ins = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql({ ...match, ...values } as any)}`
        await (ins as any).execute()
        return true
      }
    },
    async upsert(table, rows, conflictColumns, mergeColumns) {
      const targetCols = conflictColumns.map(c => String(c))
      const setCols = (mergeColumns ?? []).map(c => String(c))

      // MySQL doesn't speak `ON CONFLICT ... DO UPDATE SET ... = EXCLUDED.col`
      // (that's Postgres/SQLite syntax). It uses
      // `ON DUPLICATE KEY UPDATE col = VALUES(col)` instead. The
      // previous shape failed silently on MySQL — see stacksjs/stacks#1862
      // #15 / #16.
      if (config.dialect === 'mysql') {
        // No merge columns → insert-or-ignore (an empty `ON DUPLICATE KEY
        // UPDATE` is a syntax error). MySQL's DO-NOTHING is INSERT IGNORE.
        // See stacksjs/bun-query-builder#1035.
        if (setCols.length === 0) {
          const built = bunSql`INSERT IGNORE INTO ${bunSql(String(table))} ${bunSql(rows as any)}`
          return (built as any).execute()
        }
        // Build the `col = VALUES(col)` list as a raw fragment.
        const updateList = setCols.map(c => `\`${c.replace(/`/g, '``')}\` = VALUES(\`${c.replace(/`/g, '``')}\`)`).join(', ')
        const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(rows as any)} ON DUPLICATE KEY UPDATE ${(bunSql as any).unsafe(updateList)}`
        return (built as any).execute()
      }

      // Postgres / SQLite: build the `col = EXCLUDED.col` pairs as a
      // single raw fragment so `EXCLUDED.col` resolves as a
      // table-qualified column reference instead of being quoted as
      // one identifier (`"EXCLUDED.col"`). The previous form passed
      // `bunSql(\`EXCLUDED.${c}\`)` through `bunSql({...})`, which
      // wrapped the whole "EXCLUDED.col" string as a quoted
      // identifier and broke the conflict-update entirely.
      // No merge columns → DO NOTHING (an empty `DO UPDATE SET` is a syntax
      // error). See stacksjs/bun-query-builder#1035.
      if (setCols.length === 0) {
        const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(rows as any)} ON CONFLICT (${bunSql(targetCols as any)}) DO NOTHING`
        return (built as any).execute()
      }
      const isPostgres = config.dialect === 'postgres'
      const quoteCol = (column: string): string => isPostgres
        ? `"${column.replace(/"/g, '""')}"`
        : `"${column.replace(/"/g, '""')}"` // SQLite supports double quotes
      const updateList = setCols.map(column => `${quoteCol(column)} = EXCLUDED.${quoteCol(column)}`).join(', ')
      const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(rows as any)} ON CONFLICT (${bunSql(targetCols as any)}) DO UPDATE SET ${(bunSql as any).unsafe(updateList)}`
      return (built as any).execute()
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
        config.hooks?.onQueryStart?.({ sql: query, kind: 'raw' })
        const res = await (bunSql as any).unsafe(query)
        config.hooks?.onQueryEnd?.({ sql: query, durationMs: Date.now() - start, kind: 'raw' })
        return res
      }
      catch (err) {
        config.hooks?.onQueryError?.({ sql: query, error: err, durationMs: Date.now() - start, kind: 'raw' })
        throw err
      }
    },
    async create(table, values) {
      const pk = meta?.primaryKeys[String(table)] ?? 'id'

      // beforeCreate hook
      try {
        await config.hooks?.beforeCreate?.({ table: String(table), data: values })
      }
      catch (err) {
        throw err
      }

      if (config.dialect === 'postgres') {
        // For PostgreSQL, use RETURNING to get the ID, then fetch the full row
        const q = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} RETURNING ${bunSql(String(pk))} as id`
        const [result] = await q.execute()

        console.log('resultId', result)

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
          await config.hooks?.afterCreate?.({ table: String(table), data: values, result: row })
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
          await config.hooks?.afterCreate?.({ table: String(table), data: values, result: row })
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
      const quoteId = config.dialect === 'mysql'
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

      // Build WHERE clause
      if (Array.isArray(conditions)) {
        sql += ` WHERE ${conditions[0]}${conditions[1]}${getPlaceholder(params.length + 1)}`
        params.push(conditions[2])
      }
      else if (conditions && typeof conditions === 'object' && !('raw' in conditions)) {
        const condKeys = Object.keys(conditions)
        const condLen = condKeys.length
        if (condLen > 0) {
          const baseIdx = params.length
          const whereClauses: string[] = Array.from({ length: condLen })
          for (let i = 0; i < condLen; i++) {
            whereClauses[i] = `${condKeys[i]}=${getPlaceholder(baseIdx + i + 1)}`
            params.push((conditions as any)[condKeys[i]])
          }
          sql += ` WHERE ${whereClauses.join(' AND ')}`
        }
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
      const col = column ? bunSql(String(column)) : bunSql`*`
      const q = bunSql`SELECT COUNT(${col}) as c FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.c ?? 0) as any)
    },
    async sum(table, column) {
      const q = bunSql`SELECT SUM(${bunSql(String(column))}) as s FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.s ?? 0) as any)
    },
    async avg(table, column) {
      const q = bunSql`SELECT AVG(${bunSql(String(column))}) as a FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.a ?? 0) as any)
    },
    async min(table, column) {
      const q = bunSql`SELECT MIN(${bunSql(String(column))}) as m FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return (row?.m as any)
    },
    async max(table, column) {
      const q = bunSql`SELECT MAX(${bunSql(String(column))}) as m FROM ${bunSql(String(table))}`
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
