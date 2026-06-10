/**
 * selectFromSub() against a REAL sqlite database (Bun.SQL).
 *
 * Regression guard: selectFromSub() was built on `String(builtQuery)` text
 * manipulation, which on a real driver yields "[object Promise]" (Bun query
 * objects can't be stringified), and it never threaded the subquery's bound
 * params — so `db.selectFromSub(db.selectFrom('x').where(...), 'a')` produced
 * corrupt SQL and `near "?" syntax error`. It is now text+params authoritative,
 * sourcing the subquery's SQL and params from the builder's __rawState().
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'SUser',
  table: 's_users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
    age: { validation: { rule: {} as any } },
  },
})
const models = defineModels({ SUser: User })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: any
let prevDialect: typeof config.dialect

describe('selectFromSub (real sqlite)', () => {
  beforeAll(async () => {
    prevDialect = config.dialect
    config.dialect = 'sqlite'
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE s_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)`
    await sql`INSERT INTO s_users (name, age) VALUES ('Ada', 36), ('Bob', 28), ('Cy', 42), ('Abe', 50)`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    config.dialect = prevDialect
    await sql.close()
  })

  const adults = () => db.selectFrom('s_users').where(['age', '>', 30])

  it('produces real SQL text (not "[object Promise]")', () => {
    const s: any = db.selectFromSub(adults(), 'u').toSQL()
    const text = typeof s === 'string' ? s : s.sql
    expect(text).not.toContain('[object Promise]')
    expect(text).toContain('SELECT * FROM (SELECT * FROM s_users WHERE age >')
    expect(text).toContain(') AS u')
  })

  it('threads the subquery bound params (no near "?" error)', async () => {
    const rows = await db.selectFromSub(adults(), 'u').get()
    expect(rows.map((r: any) => r.name).sort()).toEqual(['Abe', 'Ada', 'Cy'])
  })

  it('applies outer where on top of the subquery (with AND, single WHERE)', async () => {
    const rows = await db.selectFromSub(adults(), 'u').where(['name', '=', 'Ada']).get()
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Ada')
  })

  it('supports outer orderBy + limit', async () => {
    const rows = await db.selectFromSub(adults(), 'u').orderBy('age', 'desc').limit(1).get()
    expect(rows.length).toBe(1)
    expect(rows[0].age).toBe(50)
  })

  it('supports whereIn and object-form where on the outer query', async () => {
    const inRows = await db.selectFromSub(adults(), 'u').where(['age', 'in', [36, 42]]).get()
    expect(inRows.map((r: any) => r.age).sort((a: number, b: number) => a - b)).toEqual([36, 42])
    const objRows = await db.selectFromSub(adults(), 'u').where({ name: 'Cy' }).get()
    expect(objRows.length).toBe(1)
  })

  it('count() / exists() respect threaded params', async () => {
    expect(await db.selectFromSub(adults(), 'u').count()).toBe(3)
    expect(await db.selectFromSub(adults(), 'u').exists()).toBe(true)
    expect(await db.selectFromSub(db.selectFrom('s_users').where(['age', '>', 999]), 'u').exists()).toBe(false)
  })

  it('a param-less subquery still works', async () => {
    expect(await db.selectFromSub(db.selectFrom('s_users'), 'u').count()).toBe(4)
  })

  it('rejects an injection-shaped alias', () => {
    expect(() => db.selectFromSub(adults(), 'u; DROP TABLE s_users')).toThrow(/Invalid identifier/)
  })
})
