/**
 * Regression coverage for stacksjs/bun-query-builder#1033.
 *
 * The single-row SQLite/MySQL INSERT fast path interpolated table + column
 * names unquoted (while the multi-row and Postgres paths quoted them),
 * exposing an identifier-injection slot. createMany() had the same gap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

function qb() {
  const models = { users: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('single-row INSERT identifier quoting (#1033)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('SQLite: quotes table + columns on the single-row fast path', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).insertInto('users').values({ name: 'a' }).toSQL())
    expect(sql).toContain('INSERT INTO "users"("name")')
  })

  it('MySQL: quotes with backticks on the single-row fast path', () => {
    config.dialect = 'mysql' as any
    const sql = String((qb() as any).insertInto('users').values({ name: 'a' }).toSQL())
    expect(sql).toContain('INSERT INTO `users`(`name`)')
  })

  it('multi-row path stays quoted (no regression)', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).insertInto('users').values([{ name: 'a' }, { name: 'b' }]).toSQL())
    expect(sql).toContain('INSERT INTO "users"("name")')
  })
})
