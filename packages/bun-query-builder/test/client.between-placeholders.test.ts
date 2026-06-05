/**
 * Regression coverage for stacksjs/bun-query-builder#1027.
 *
 * whereBetween/whereNotBetween emitted literal `?` placeholders, which are
 * invalid on Postgres ($n) and produced mixed `$1 ... BETWEEN ? AND ?` when
 * combined with another where.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

function qb() {
  const models = { users: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' }, age: { type: 'integer' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('whereBetween placeholders (#1027)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('Postgres: uses $n placeholders, consistent with a preceding where', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).selectFrom('users').where({ name: 'a' }).whereBetween('age', 10, 20).toSQL())
    expect(sql).toContain('BETWEEN $2 AND $3')
    expect(sql).not.toContain('?')
  })

  it('Postgres: whereNotBetween uses $n', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).selectFrom('users').whereNotBetween('age', 10, 20).toSQL())
    expect(sql).toContain('NOT BETWEEN $1 AND $2')
    expect(sql).not.toContain('?')
  })

  it('SQLite/MySQL: still uses ? placeholders', () => {
    config.dialect = 'sqlite' as any
    expect(String((qb() as any).selectFrom('users').whereBetween('age', 10, 20).toSQL())).toContain('BETWEEN ? AND ?')
    config.dialect = 'mysql' as any
    expect(String((qb() as any).selectFrom('users').whereNotBetween('age', 10, 20).toSQL())).toContain('NOT BETWEEN ? AND ?')
  })
})
