/**
 * Regression coverage for stacksjs/bun-query-builder#1028.
 *
 * The LIKE/ILIKE helpers bound their pattern only in the `built` tagged-template
 * and pushed nothing to the `text`/whereParams shadow. A later where() that
 * invalidated `built` then rebuilt from `text` with the pattern missing and the
 * placeholders misaligned (e.g. `name ILIKE ? AND age = $1`).
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

describe('LIKE/ILIKE param alignment (#1028)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('Postgres: ILIKE followed by where() keeps sequential $n placeholders (no orphaned ?)', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).selectFrom('users').whereILike('name', 'a%').where({ age: 5 }).toSQL())
    expect(sql).toContain('ILIKE $1')
    expect(sql).toContain('age = $2')
    expect(sql).not.toContain('ILIKE ?')
  })

  it('Postgres: whereLike (case-insensitive) uses LOWER($n)', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).selectFrom('users').whereLike('name', 'x%').toSQL())
    expect(sql).toContain('LIKE LOWER($1)')
    expect(sql).not.toContain('LOWER(?)')
  })

  it('SQLite: keeps ? placeholders and stays aligned with a following where()', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).selectFrom('users').whereILike('name', 'a%').where({ age: 5 }).toSQL())
    expect(sql).toContain('LIKE LOWER(?)')
    expect(sql).toContain('age = ?')
  })

  it('Postgres: whereNotILike + where() aligns placeholders', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).selectFrom('users').whereNotILike('name', 'a%').where({ age: 5 }).toSQL())
    expect(sql).toContain('NOT ILIKE $1')
    expect(sql).toContain('age = $2')
  })
})
