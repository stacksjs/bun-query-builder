/**
 * Regression coverage for stacksjs/bun-query-builder#1029.
 *
 * union/unionAll appended the other side's SQL text only — dropping its bound
 * params and, on Postgres, colliding placeholders (`WHERE age = $1 UNION ...
 * WHERE age = $1`, right value lost). They now merge params and renumber the
 * right side's `$n` past the left's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

function qb() {
  const models = { users: { columns: { id: { type: 'integer', isPrimaryKey: true }, age: { type: 'integer' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('union/unionAll param merging (#1029)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('Postgres: renumbers the right side placeholders and merges params', () => {
    config.dialect = 'postgres' as any
    const right = (qb() as any).selectFrom('users').where({ age: 2 })
    const merged = (qb() as any).selectFrom('users').where({ age: 1 }).union(right)
    const sql = String(merged.toSQL())
    // Left uses $1, right must be renumbered to $2 (not a duplicate $1).
    expect(sql).toContain('age = $1')
    expect(sql).toContain('age = $2')
    expect((sql.match(/\$1/g) || []).length).toBe(1)
    expect(merged.__rawState().params).toEqual([1, 2])
  })

  it('SQLite: merges both sides params in order', () => {
    config.dialect = 'sqlite' as any
    const right = (qb() as any).selectFrom('users').where({ age: 20 })
    const merged = (qb() as any).selectFrom('users').where({ age: 10 }).unionAll(right)
    const sql = String(merged.toSQL())
    expect(sql).toContain('UNION ALL')
    expect((sql.match(/\?/g) || []).length).toBe(2)
    expect(merged.__rawState().params).toEqual([10, 20])
  })
})
