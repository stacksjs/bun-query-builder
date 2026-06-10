/**
 * Chained WHERE-clause connectors against a REAL database (sqlite via Bun.SQL).
 *
 * Regression guard: `addWhereText` emitted the caller's prefix verbatim when a
 * WHERE already existed, and several methods pass 'WHERE' to mean "a where-type
 * clause" (whereLike / whereILike / whereExists / dynamic whereX). Chaining any
 * of them after an existing WHERE produced a SECOND `WHERE` keyword
 * (`WHERE a = ? WHERE b = ?`) — invalid SQL that failed on every real driver.
 * The mock-sql tests only substring-checked toSQL, so it went unnoticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'WUser',
  table: 'w_users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
    age: { validation: { rule: {} as any } },
    status: { validation: { rule: {} as any } },
  },
})
const models = defineModels({ WUser: User })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>
let prevDialect: typeof config.dialect
let prevSoftDeletes: typeof config.softDeletes

function countWhere(qb: any): number {
  const s = qb.toSQL()
  const text = typeof s === 'string' ? s : (s?.sql ?? String(s))
  return (text.match(/\bWHERE\b/gi) || []).length
}

describe('chained WHERE connectors (real sqlite)', () => {
  beforeAll(async () => {
    prevDialect = config.dialect
    prevSoftDeletes = config.softDeletes
    config.dialect = 'sqlite'
    config.softDeletes = { enabled: false, column: 'deleted_at', defaultFilter: false }
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE w_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, status TEXT)`
    await sql`INSERT INTO w_users (name, age, status) VALUES
      ('Ada', 36, 'active'), ('Abe', 50, 'active'), ('Bob', 28, 'inactive'), ('Cy', 42, 'active')`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    config.dialect = prevDialect
    config.softDeletes = prevSoftDeletes
    await sql.close()
  })

  it('where().whereLike() emits a single WHERE and filters with AND', async () => {
    const qb = db.selectFrom('w_users').where(['age', '>', 30]).whereLike!('name', '%a%')
    expect(countWhere(qb)).toBe(1)
    const rows = await qb.get() as any[]
    expect(rows.map(r => r.name).sort()).toEqual(['Abe', 'Ada']) // age>30 AND name like %a%
  })

  it('whereX().whereY() dynamic methods chain with AND', async () => {
    const qb = db.selectFrom('w_users').whereAge!(36).whereName!('Ada')
    expect(countWhere(qb)).toBe(1)
    const rows = await qb.get() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Ada')
  })

  it('where().whereX() dynamic after structured where chains with AND', async () => {
    const qb = db.selectFrom('w_users').where(['age', '>', 30]).whereStatus!('active')
    expect(countWhere(qb)).toBe(1)
    const rows = await qb.get() as any[]
    expect(rows.map(r => r.name).sort()).toEqual(['Abe', 'Ada', 'Cy'])
  })

  it('whereLike().whereLike() chains with AND', async () => {
    const qb = db.selectFrom('w_users').whereLike!('name', '%a%').whereLike!('status', '%active%')
    expect(countWhere(qb)).toBe(1)
    const rows = await qb.get() as any[]
    expect(rows.map(r => r.name).sort()).toEqual(['Abe', 'Ada'])
  })

  it('whereLike().orWhereLike() produces an OR branch', async () => {
    const rows = await db.selectFrom('w_users')
      .whereLike!('name', '%be%')
      .orWhereLike!('name', '%bo%')
      .get() as any[]
    expect(rows.map(r => r.name).sort()).toEqual(['Abe', 'Bob'])
  })

  it('where().whereExists() connects with AND, not a second WHERE', async () => {
    const sub = db.selectFrom('w_users').whereColumn!('age', '>', 'id')
    const qb = db.selectFrom('w_users').where(['age', '>', 1]).whereExists!(sub as any)
    const s: any = qb.toSQL()
    const text = typeof s === 'string' ? s : (s?.sql ?? String(s))
    // The outer query must AND the EXISTS onto the existing WHERE (the only
    // other WHERE is legitimately inside the subquery).
    expect(text).toContain('AND EXISTS (')
    expect(text).not.toMatch(/\?\s+WHERE\s+EXISTS/i)
    const rows = await qb.get() as any[]
    expect(rows.length).toBeGreaterThan(0)
  })
})
