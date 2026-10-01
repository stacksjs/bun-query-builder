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
      // The shape db.d.ts documents. Throwing here would be the false positive
      // that matters, so assert the guard specifically, not the connection.
      expect(() => assertOnly(() => qb().unsafe('SELECT $2 AS a, $1 AS b', ['ONE', 'TWO']))).not.toThrow(REFUSED)
    })

    it('accepts a jsonb ? operator when $n is also present', () => {
      // `data ? 'key'` is a real Postgres operator, not a placeholder.
      expect(() => assertOnly(() => qb().unsafe('SELECT * FROM t WHERE data ? \'key\' AND id = $1', [7]))).not.toThrow(REFUSED)
    })

    it('never inspects a query with no bindings', () => {
      // Raw DDL, and the `?` in a literal that is data rather than a placeholder.
      expect(() => assertOnly(() => qb().unsafe('CREATE TABLE t (id int)'))).not.toThrow(REFUSED)
      expect(() => assertOnly(() => qb().unsafe('SELECT * FROM users WHERE name = \'what?\''))).not.toThrow(REFUSED)
      expect(() => assertOnly(() => qb().unsafe('SELECT * FROM users WHERE email = ?', []))).not.toThrow(REFUSED)
    })
  })

  describe('other dialects are unaffected', () => {
    it('SQLite and MySQL still take ?', () => {
      for (const d of ['sqlite', 'mysql'] as const) {
        config.dialect = d as any
        expect(() => assertOnly(() => qb().unsafe('SELECT * FROM users WHERE email = ? LIMIT 1', ['a@b.c'])))
          .not.toThrow(REFUSED)
      }
    })
  })
})

/**
 * Run `fn` and swallow anything that is not this guard's refusal.
 *
 * These cases assert that the GUARD does not fire. Past it the call reaches a
 * connection that no test here configures, so a driver error is expected and
 * says nothing about the thing under test; only a `[query-builder] unsafe()`
 * message would.
 */
function assertOnly(fn: () => unknown): void {
  try {
    const out = fn()
    // A promise that rejects in the driver is not this guard's business either.
    void Promise.resolve(out).catch(() => {})
  }
  catch (error) {
    if (REFUSED.test((error as Error).message))
      throw error
  }
}
