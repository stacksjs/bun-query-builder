/**
 * Dynamic whereColumn methods against a REAL database (sqlite via Bun.SQL).
 *
 * Regression guards for two bugs that only surfaced at execution time:
 *
 * 1. The prefix-strip regex was `/^or?where/i` — `o` + optional `r` +
 *    `where` — which never matched plain `whereName`, so the un-stripped
 *    prop snake-cased to `where_name` and EVERY plain dynamic where failed
 *    with "no such column" on a real database. (orWhereX/andWhereX worked,
 *    and mock-based tests never validated column names.)
 *
 * 2. The bound value lived only inside the template-built query; any later
 *    chained call that invalidates the built query (orderBy, limit, ...)
 *    rebuilt from text+whereParams and lost the binding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'DynUser',
  table: 'dyn_users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
    age: { validation: { rule: {} as any } },
    created_at: { validation: { rule: {} as any } },
  },
})

const models = defineModels({ DynUser: User })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>

describe('dynamic whereColumn methods (real sqlite)', () => {
  beforeAll(async () => {
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE dyn_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, created_at TEXT)`
    await sql`INSERT INTO dyn_users (name, age, created_at) VALUES
      ('Ada', 36, '2024-01-01'), ('Bob', 28, '2024-02-01'), ('Ada', 99, '2024-03-01')`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    await sql.close()
  })

  it('plain whereX resolves the actual column (not where_x)', async () => {
    const rows = await db.selectFrom('dyn_users').whereName('Ada').get()
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.name === 'Ada')).toBe(true)
  })

  it('snake_case columns resolve from camelCase method names', async () => {
    const rows = await db.selectFrom('dyn_users').whereCreatedAt('2024-02-01').get()
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Bob')
  })

  it('keeps the binding when chained with orderBy (built-query invalidation)', async () => {
    const rows = await db.selectFrom('dyn_users').whereName('Ada').orderBy('age', 'desc').get()
    expect(rows.map(r => r.age)).toEqual([99, 36])
  })

  it('keeps the binding when chained with limit', async () => {
    const rows = await db.selectFrom('dyn_users').whereName('Ada').limit(1).get()
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Ada')
  })

  it('orWhereX appends an OR branch', async () => {
    const rows = await db.selectFrom('dyn_users').whereAge(28).orWhereAge(99).orderBy('age', 'asc').get()
    expect(rows.map(r => r.age)).toEqual([28, 99])
  })

  it('andWhereX appends an AND branch', async () => {
    const rows = await db.selectFrom('dyn_users').whereName('Ada').andWhereAge(36).get()
    expect(rows.length).toBe(1)
    expect(rows[0].age).toBe(36)
  })

  it('array values produce IN lists that survive rebuilds', async () => {
    const rows = await db.selectFrom('dyn_users').whereAge([28, 36]).orderBy('age', 'asc').get()
    expect(rows.map(r => r.age)).toEqual([28, 36])
  })

  it('mixed dynamic + structured wheres compose', async () => {
    const rows = await db.selectFrom('dyn_users').whereName('Ada').where(['age', '>', 50]).get()
    expect(rows.length).toBe(1)
    expect(rows[0].age).toBe(99)
  })
})
