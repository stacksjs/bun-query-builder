import type { SupportedDialect } from './types'
/**
 * SQL fragment renderers shared by the select builder (`client.ts`) and the ORM
 * query builder (`orm.ts`).
 *
 * They live here rather than in either builder because the two had independent
 * copies of the same defect: both joined their WHERE terms as flat text, so
 * `orWhere` produced an ungrouped `OR` and SQL's native precedence silently
 * re-associated the chain. Two implementations of one rule is how they drifted;
 * one implementation is how they stop.
 *
 * See stacksjs/bun-query-builder#1083.
 */

/**
 * A single WHERE predicate plus the connector the CALLER asked for.
 *
 * The connector belongs to the term rather than sitting between terms because
 * the first term's connector is meaningless — nothing precedes it — and
 * carrying it anyway is what lets a leading `.orWhere(x)` render as `WHERE x`
 * instead of the `FROM t OR x` syntax error it used to emit.
 */
export interface WhereTerm {
  conn: 'AND' | 'OR'
  sql: string
}

/**
 * Constant predicates, for the cases where a collection is empty.
 *
 * `1 = 0` and `1 = 1` take no parameters and parse identically on SQLite,
 * Postgres and MySQL, which is the point: the alternatives are engine-specific.
 * `IN ()` is the example that motivated these — SQLite parses it and matches
 * nothing, while Postgres and MySQL reject it as a syntax error, so the same
 * call site behaved differently depending on where it ran.
 */
export const FALSE_PREDICATE = '1 = 0'
export const TRUE_PREDICATE = '1 = 1'

/**
 * Render a WHERE body (without the `WHERE` keyword) from an ordered term list.
 *
 * Each MAXIMAL RUN of `OR` terms is bracketed together with the term that opens
 * it, so a chain groups the way it reads:
 *
 *     .where(a).where(b).orWhere(c)   ->  a AND (b OR c)
 *     .where(a).orWhere(b).where(c)   ->  (a OR b) AND c
 *
 * In effect `OR` binds TIGHTER than `AND` in chain order — the inverse of raw
 * SQL. That is a deliberate choice for a fluent builder, and it is already what
 * `whereAny`/`whereAll`/`whereNone` and the ORM's `whereGroup` do; `orWhere`
 * was the odd one out. Previously the terms were concatenated as flat text and
 * SQL's precedence re-associated `a AND b OR c` to `(a AND b) OR c`, so the
 * first filter stopped applying to any row the `OR` matched — silently, and in
 * the direction that returns MORE rows.
 *
 * The brackets are omitted when the body has a single top-level piece, so a
 * plain two-term `.where(a).orWhere(b)` and any all-`AND` chain still render
 * byte-for-byte as before. The escape hatch for the one shape this rule can no
 * longer express directly — `(a AND b) OR c` — is `whereGroup(cb)`.
 */
export function renderWhereTerms(terms: readonly WhereTerm[]): string {
  if (terms.length === 0)
    return ''

  const runs: WhereTerm[][] = []
  for (const term of terms) {
    if (term.conn === 'OR' && runs.length > 0)
      runs[runs.length - 1].push(term)
    else
      runs.push([term])
  }

  return runs
    .map((run, i) => {
      const body = run.map(t => t.sql).join(' OR ')
      // A run only needs brackets when there is something outside it to bind
      // against. `(a OR b)` alone and `a OR b` alone mean the same thing, and
      // not adding the parens keeps existing emitted SQL unchanged.
      const piece = run.length > 1 && runs.length > 1 ? `(${body})` : body
      return i === 0 ? piece : `${run[0].conn} ${piece}`
    })
    .join(' ')
}

/**
 * Render `col IN (…)` / `col NOT IN (…)`, including the empty case.
 *
 * An empty `IN` is FALSE (nothing is a member of the empty set) and an empty
 * `NOT IN` is TRUE (everything is a non-member). Those constants are not
 * interchangeable and the mirror is easy to get backwards: writing FALSE for
 * `NOT IN` would silently drop every row from any query whose exclusion list
 * happened to come back empty — the same shape of silent, widening-or-narrowing
 * failure as the `IN ()` bug itself.
 */
export function renderInPredicate(column: string, values: any[], negated: boolean, placeholders: string): string {
  if (values.length === 0)
    return negated ? TRUE_PREDICATE : FALSE_PREDICATE
  return `${column} ${negated ? 'NOT IN' : 'IN'} (${placeholders})`
}

/**
 * Rewrite `?` placeholders into the numbered form Postgres requires.
 *
 * Raw SQL written with `?` runs on SQLite and MySQL and is a syntax error on
 * Postgres, which reports it as a problem with whatever token follows: a WHERE
 * built as `project_id = ? AND …` is rejected with `syntax error at or near
 * "AND"`, which sends the reader looking at the wrong part of the query. An
 * application that developed against SQLite therefore finds out at the point
 * its raw queries first meet Postgres, and the error does not name the cause.
 *
 * Only unquoted placeholders are rewritten. A `?` inside a string literal, a
 * quoted identifier, or a dollar-quoted block is data and is left exactly as
 * written — the naive global replace is the reason this needs to be a function
 * with tests rather than one line at a call site.
 *
 * Dialects that already take `?` get the string back unchanged, so this is safe
 * to apply unconditionally.
 */
export function toDialectPlaceholders(sql: string, dialect: SupportedDialect): string {
  if (dialect !== 'postgres')
    return sql

  let out = ''
  let index = 0
  let position = 0

  while (position < sql.length) {
    const char = sql[position]!

    // Single-quoted string literal, with '' as the escape.
    if (char === '\'') {
      const end = closingQuote(sql, position, '\'')
      out += sql.slice(position, end)
      position = end
      continue
    }

    // Double-quoted identifier, with "" as the escape.
    if (char === '"') {
      const end = closingQuote(sql, position, '"')
      out += sql.slice(position, end)
      position = end
      continue
    }

    // Dollar-quoted block: $tag$ … $tag$, where the tag may be empty.
    if (char === '$') {
      const tag = sql.slice(position).match(/^\$[A-Z_a-z]\w*\$|^\$\$/)?.[0]
      if (tag) {
        const close = sql.indexOf(tag, position + tag.length)
        const end = close === -1 ? sql.length : close + tag.length
        out += sql.slice(position, end)
        position = end
        continue
      }
    }

    if (char === '?') {
      index++
      out += `$${index}`
      position++
      continue
    }

    out += char
    position++
  }

  return out
}

/** Index just past the closing quote of the literal starting at `start`. */
function closingQuote(sql: string, start: number, quote: string): number {
  let position = start + 1

  while (position < sql.length) {
    if (sql[position] === quote) {
      // A doubled quote is an escaped one, not the end.
      if (sql[position + 1] === quote) {
        position += 2
        continue
      }
      return position + 1
    }
    position++
  }

  return sql.length
}
