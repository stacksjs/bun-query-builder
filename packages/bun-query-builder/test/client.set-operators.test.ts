/**
 * Coverage for INTERSECT / EXCEPT set operators (stacksjs/bun-query-builder#1049).
 * They reuse union()'s param-merging seam (#1029).
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

describe('intersect/except set operators (#1049)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('emits INTERSECT and EXCEPT keywords', () => {
    const r1 = (qb() as any).selectFrom('users').where({ age: 2 })
    expect(String((qb() as any).selectFrom('users').where({ age: 1 }).intersect(r1).toSQL())).toContain('INTERSECT')
    const r2 = (qb() as any).selectFrom('users').where({ age: 2 })
    expect(String((qb() as any).selectFrom('users').where({ age: 1 }).except(r2).toSQL())).toContain('EXCEPT')
  })

  it('supports the ALL variants', () => {
    const r1 = (qb() as any).selectFrom('users')
    expect(String((qb() as any).selectFrom('users').intersectAll(r1).toSQL())).toContain('INTERSECT ALL')
    const r2 = (qb() as any).selectFrom('users')
    expect(String((qb() as any).selectFrom('users').exceptAll(r2).toSQL())).toContain('EXCEPT ALL')
  })

  it('Postgres: merges + renumbers params across the operator', () => {
    config.dialect = 'postgres' as any
    const right = (qb() as any).selectFrom('users').where({ age: 2 })
    const merged = (qb() as any).selectFrom('users').where({ age: 1 }).except(right)
    const sql = String(merged.toSQL())
    expect(sql).toContain('age = $1')
    expect(sql).toContain('age = $2')
    expect((sql.match(/\$1/g) || []).length).toBe(1)
    expect(merged.__rawState().params).toEqual([1, 2])
  })
})
