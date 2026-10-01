/**
 * `unsafe()` refuses `?`-style bindings on Postgres — stacksjs/bun-query-builder#1171.
 *
 * `unsafe('SELECT * FROM users WHERE email = ? LIMIT 1', [email])` typechecks,
 * passes on SQLite and MySQL, and on Postgres reached the server as a bare `?`.
 * Postgres parses that as an operator, hunts for a right operand and rejects the
 * next word, so the error named `LIMIT` while the fault was the `?` 37 characters
 * earlier — and the bound value was never going to arrive. Downstream that took
 * out every login, password recovery, magic link and two-factor exchange in
 * Stacks at once: 126 failures in one CI run, all from this one shape.
 *
 * The check is keyed on bindings arriving with no `$n` in the query, not on the
 * presence of `?`, so a jsonb `?` operator alongside `$1` is still allowed
 * through and raw DDL is never inspected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        email: { type: 'text' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

const REFUSED = /\[query-builder\] unsafe\(\)/

describe('unsafe() placeholder style (#1171)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  describe('Postgres refuses bindings it cannot bind', () => {
    beforeEach(() => { config.dialect = 'postgres' as any })

    it('throws on the exact call from the issue', () => {
      expect(() => qb().unsafe('SELECT * FROM users WHERE email = ? LIMIT 1', ['a@b.c'])).toThrow(REFUSED)
    })

    it('names the real problem rather than the token Postgres would pick', () => {
      let message = ''
      try {
        qb().unsafe('SELECT * FROM users WHERE email = ? LIMIT 1', ['a@b.c'])
      }
      catch (error) {
        message = (error as Error).message
      }
      // The placeholder style the connection expects, and the one that was used.
      expect(message).toContain('$1')
      expect(message).toContain('1 binding supplied')
      // It blames the placeholder, where the server's own error blamed `LIMIT`.
      expect(message).toContain('`?` placeholder')
      expect(message).not.toContain('syntax error')
      // And it says why the same call passes elsewhere, which is the part that
      // makes a one-dialect-only CI failure legible.
      expect(message).toMatch(/SQLite and MySQL/)
    })

    it('throws a TypeError, synchronously, so the stack names the caller', () => {
      // Not a rejected promise: the point is to fail where the query was written.
      expect(() => qb().unsafe('SELECT ?', [1])).toThrow(TypeError)
    })

    it('counts the placeholders and pluralises', () => {
      let message = ''
      try {
        qb().unsafe('SELECT * FROM users WHERE email = ? OR id = ?', ['a@b.c', 1])
      }
      catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('2 bindings supplied')
      expect(message).toContain('2 `?` placeholders')
    })

    it('refuses bindings that nothing in the query references', () => {
      // No `?` either — the values still cannot arrive, and Postgres would have
      // said "bind message supplies 1 parameters, but prepared statement requires 0".
      expect(() => qb().unsafe('SELECT 1', [1])).toThrow(/no \$n placeholder/)
    })
  })

  describe('Postgres leaves correct and unrelated queries alone', () => {
    beforeEach(() => { config.dialect = 'postgres' as any })

    it('accepts $n, in any order', () => {
      // The shape db.d.ts documents. A throw here is the false positive that
      // would matter, so this asserts nothing is thrown at all.
      expect(refusal(() => qb().unsafe('SELECT $2 AS a, $1 AS b', ['ONE', 'TWO']))).toBeNull()
    })

    it('accepts a jsonb ? operator when $n is also present', () => {
      // `data ? 'key'` is a real Postgres operator, not a placeholder. Keying the
      // check on `?` instead of on the absence of $n would reject this.
      expect(refusal(() => qb().unsafe('SELECT * FROM t WHERE data ? \'key\' AND id = $1', [7]))).toBeNull()
    })

    it('never inspects a query with no bindings', () => {
      // Raw DDL, and the `?` in a literal that is data rather than a placeholder.
      expect(refusal(() => qb().unsafe('CREATE TABLE t (id int)'))).toBeNull()
      expect(refusal(() => qb().unsafe('SELECT * FROM users WHERE name = \'what?\''))).toBeNull()
      expect(refusal(() => qb().unsafe('SELECT * FROM users WHERE email = ?', []))).toBeNull()
    })
  })

  describe('other dialects are unaffected', () => {
    it('SQLite and MySQL still take ?', () => {
      for (const d of ['sqlite', 'mysql'] as const) {
        config.dialect = d as any
        expect(refusal(() => qb().unsafe('SELECT * FROM users WHERE email = ? LIMIT 1', ['a@b.c']))).toBeNull()
      }
    })
  })
})

/**
 * The message `fn` threw, or null if it returned.
 *
 * `unsafe` returns a LAZY query: it reaches a database when something awaits it,
 * and not before. So these cases call it and discard the result, which exercises
 * the guard while executing nothing.
 *
 * That is load-bearing, not tidiness. An earlier version of this helper did
 * `void Promise.resolve(out).catch(…)` to ignore driver errors — but
 * `Promise.resolve` calls `.then` on the thenable, so every "leaves it alone"
 * case below really ran, `CREATE TABLE t (id int)` included, against whatever
 * database the environment pointed at. In CI that is the shared `test_db`, and
 * the unawaited queries outlived the file and timed out the next one's
 * `beforeAll` (`closeConnection` → `resetDatabase` → `generateMigration`, on a
 * 5s hook budget). Returning the message instead of swallowing it also means an
 * unexpected throw fails loudly rather than passing as "not refused".
 */
function refusal(fn: () => unknown): string | null {
  try {
    fn()
    return null
  }
  catch (error) {
    return (error as Error).message
  }
}
