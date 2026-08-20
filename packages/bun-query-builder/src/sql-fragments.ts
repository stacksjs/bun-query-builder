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
export function renderInPredicate(column: string, values: readonly unknown[], negated: boolean, placeholders: string): string {
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

/**
 * A top-level keyword found by {@link scanTopLevelKeywords}.
 */
export interface TopLevelKeyword {
  /** The caller's label for the pattern that matched. */
  key: string
  /** Index in the source SQL where the keyword starts. */
  start: number
  /** Length of the matched text. */
  length: number
}

/**
 * Find clause keywords in `sql` that are genuinely clause keywords.
 *
 * Three separate scanners used to answer this question, each with its own idea
 * of what SQL is, and a raw fragment is arbitrary caller text:
 *
 *     firstTailIndex          paren-depth only
 *     insertJoin              paren-depth only
 *     computeReorderedClauses paren-depth + string literals
 *
 * So `selectRaw(raw("'a limit 3 b' as t"))` put the word `limit` where the
 * first two would read it as a LIMIT clause, and the WHERE was spliced into
 * the middle of a string literal — leaving a statement that is still valid,
 * has no WHERE, and returns every row. The JOIN splice had the same hole, and
 * the third scanner missed comments. See stacksjs/bun-query-builder#1121.
 *
 * This skips everything that is not executable statement structure:
 *
 *  - parenthesised sub-expressions, so a subquery's own ORDER BY is not ours
 *  - `'…'`, `"…"` and `` `…` `` runs, where doubling escapes the delimiter
 *  - `-- …` line comments and `/* … *\/` block comments, which nest
 *  - `$$…$$` / `$tag$…$tag$` dollar-quoted strings, without mistaking a `$1`
 *    placeholder for the start of one
 *
 * Backslash escapes inside a literal are deliberately NOT honoured. Whether
 * `'a\'` ends the string depends on the dialect and, on Postgres, on a server
 * setting — so this matches the standard (and what the previous literal-aware
 * scanner did) rather than inventing a rule that would be wrong somewhere.
 *
 * A keyword must be preceded by a non-word character, and never matches at
 * index 0: a statement that opens with a clause keyword has nothing before it
 * for the clause to attach to.
 *
 * @param sql the statement to scan
 * @param keywords patterns to look for. Each MUST carry the sticky (`y`) flag;
 *   they are matched at a position rather than against a slice, and are tried
 *   in the order given — so longer keywords must come before any single-word
 *   prefix of them (`ORDER BY` before a hypothetical `ORDER`).
 * @param limit stop after this many hits. Callers that only want the first
 *   clause boundary pass 1 rather than scanning the rest of the statement.
 */
export function scanTopLevelKeywords(
  sql: string,
  keywords: ReadonlyArray<{ key: string, pattern: RegExp }>,
  limit = Number.POSITIVE_INFINITY,
): TopLevelKeyword[] {
  const hits: TopLevelKeyword[] = []
  let depth = 0

  // charCode comparisons rather than single-character strings and regexes:
  // this walks every character of every statement the builder emits, and
  // `sql[i]` allocates. See the note on the lead-letter check below.
  const isWordCode = (c: number): boolean =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95

  for (let i = 0; i < sql.length; i++) {
    const code = sql.charCodeAt(i)

    // -- line comment: everything to the newline is prose.
    if (code === 45 && sql.charCodeAt(i + 1) === 45) {
      const newline = sql.indexOf('\n', i + 2)
      if (newline === -1)
        return hits
      i = newline
      continue
    }

    // /* block comment */ — Postgres nests these, so a naive indexOf('*\/')
    // would stop at the inner terminator and resume scanning inside prose.
    if (code === 47 && sql.charCodeAt(i + 1) === 42) {
      let nesting = 1
      let j = i + 2
      while (j < sql.length && nesting > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { nesting++; j += 2 }
        else if (sql[j] === '*' && sql[j + 1] === '/') { nesting--; j += 2 }
        else j++
      }
      i = j - 1
      continue
    }

    // Quoted run. A doubled delimiter is an escaped one and stays inside.
    if (code === 39 || code === 34 || code === 96) {
      let j = i + 1
      while (j < sql.length) {
        if (sql.charCodeAt(j) === code) {
          // A doubled delimiter is an escaped one and stays inside.
          if (sql.charCodeAt(j + 1) === code) { j += 2; continue }
          break
        }
        j++
      }
      i = j
      continue
    }

    // Dollar-quoted string. The tag is empty or an identifier, which is what
    // separates `$$…$$` from the `$1` placeholders Postgres binds with.
    if (code === 36) {
      const opening = /^\$(?:[A-Z_][A-Z0-9_]*)?\$/i.exec(sql.slice(i))
      if (opening) {
        const closing = sql.indexOf(opening[0], i + opening[0].length)
        i = closing === -1 ? sql.length : closing + opening[0].length - 1
        continue
      }
    }

    if (code === 40) { depth++; continue }
    if (code === 41) { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0) continue
    if (i === 0) continue

    // Every clause keyword starts with a letter, so this rejects the large
    // majority of positions before any regex runs. The scan replaced three
    // separate ones, two of which jumped between matches of a single
    // alternation regex — without this it walks characters they skipped.
    const upper = code & ~32
    if (upper < 65 || upper > 90) continue
    if (isWordCode(sql.charCodeAt(i - 1))) continue

    for (const { key, pattern } of keywords) {
      pattern.lastIndex = i
      const match = pattern.exec(sql)
      if (!match) continue
      hits.push({ key, start: i, length: match[0].length })
      if (hits.length >= limit)
        return hits
      // Advance past it, so a multi-word keyword is not re-detected mid-match.
      i += match[0].length - 1
      break
    }
  }

  return hits
}
