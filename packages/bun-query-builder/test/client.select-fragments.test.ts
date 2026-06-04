/**
 * Regression coverage for stacksjs/bun-query-builder#1016.
 *
 * `.select(sql`count(*) as count`)` (and the mixed-array form
 * `.select(['col', sql`...`])`) used to fall through `.join(', ')` and
 * stringify the fragment object to `[object Object]`, which the database
 * rejected with `no such column: object Object`. `select()`/`addSelect()`
 * now unwrap SQL fragments to their text.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        email: { type: 'text' },
      },
    },
  } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

// The `{ sql, parameters }` shape a `sql`...`` tagged template emits
// (matches @stacksjs/database's `sql` helper) — no `.raw`, no `toString`.
const fragment = { sql: 'count(*) as count', parameters: [] as unknown[] }

describe('select() with SQL fragments (#1016)', () => {
  it('unwraps a single fragment instead of emitting [object Object]', () => {
    const sql = String((qb() as any).selectFrom('users').select(fragment).toSQL())
    expect(sql).not.toContain('[object Object]')
    expect(sql).toBe('SELECT count(*) as count FROM users')
  })

  it('unwraps a fragment mixed into an array with plain columns', () => {
    const sql = String((qb() as any).selectFrom('users').select(['name', fragment]).toSQL())
    expect(sql).not.toContain('[object Object]')
    expect(sql).toBe('SELECT name, count(*) as count FROM users')
  })

  it('unwraps a RawExpression ({ raw })', () => {
    const sql = String((qb() as any).selectFrom('users').select({ raw: 'MAX(id) as max_id' }).toSQL())
    expect(sql).toBe('SELECT MAX(id) as max_id FROM users')
  })

  it('unwraps a tagged-template builder exposing raw()', () => {
    const tagged = { sql: 'min(id) as m', raw: () => 'min(id) as m' }
    const sql = String((qb() as any).selectFrom('users').select(tagged).toSQL())
    expect(sql).toBe('SELECT min(id) as m FROM users')
  })

  it('addSelect() unwraps fragments too', () => {
    const sql = String((qb() as any).selectFrom('users').select('name').addSelect(fragment).toSQL())
    expect(sql).not.toContain('[object Object]')
    expect(sql).toBe('SELECT name, count(*) as count FROM users')
  })

  it('still accepts a bare string and string[] (no regression on #1012)', () => {
    expect(String((qb() as any).selectFrom('users').select('name').toSQL())).toBe('SELECT name FROM users')
    expect(String((qb() as any).selectFrom('users').select(['name', 'email']).toSQL())).toBe('SELECT name, email FROM users')
  })
})
