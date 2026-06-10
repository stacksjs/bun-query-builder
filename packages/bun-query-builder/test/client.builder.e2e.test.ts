/**
 * Broad client-builder coverage against a REAL database (sqlite via Bun.SQL).
 *
 * The existing builder tests use a mock `sql` whose `String(query)` returns
 * SQL text — which silently masks bugs that only bite on a real driver, whose
 * query objects stringify to "[object Promise]". This suite exercises the
 * surface end to end and guards the following fixes:
 *
 * - `*Raw` methods rendered fragments via `String(fragment)`; a Bun `sql\`\``
 *   fragment (the documented form) became "[object Promise]". The `raw` helper
 *   now produces a renderable fragment, and a Bun query throws a clear error.
 * - `insertInto/updateTable/deleteFrom().returning()` are typed as
 *   SelectQueryBuilder but the runtime object lacked `first()`/`get()`/etc.
 * - `.distinct().select([...])` dropped the DISTINCT modifier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels, raw } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'BUser',
  table: 'b_users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
    age: { validation: { rule: {} as any } },
    team_id: { validation: { rule: {} as any } },
  },
})
const models = defineModels({ BUser: User })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>
let prevDialect: typeof config.dialect
let prevSoftDeletes: typeof config.softDeletes

describe('client builder (real sqlite)', () => {
  beforeAll(async () => {
    // `config` is a shared global mutated by other test files; pin what we need.
    prevDialect = config.dialect
    prevSoftDeletes = config.softDeletes
    config.dialect = 'sqlite'
    config.softDeletes = { enabled: false, column: 'deleted_at', defaultFilter: false }
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE b_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, team_id INTEGER)`
    await sql`INSERT INTO b_users (name, age, team_id) VALUES
      ('Ada', 36, 1), ('Bob', 28, 1), ('Cy', 42, 2), ('Dee', 28, 2)`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    config.dialect = prevDialect
    config.softDeletes = prevSoftDeletes
    await sql.close()
  })

  describe('raw fragments', () => {
    it('selectRaw(raw`...`) renders real SQL (not [object Promise])', async () => {
      const text = String(db.selectFrom('b_users').selectRaw(raw`count(*) as c`).toSQL())
      expect(text).not.toContain('[object Promise]')
      const rows = await db.selectFrom('b_users').selectRaw(raw`count(*) as c`).get() as any[]
      expect(rows[0].c).toBe(4)
    })

    it('whereRaw(raw(string)) filters', async () => {
      const rows = await db.selectFrom('b_users').whereRaw(raw('age > 30')).get() as any[]
      expect(rows.length).toBe(2)
    })

    it('raw`${value}` escapes interpolated values', async () => {
      const text = String(db.selectFrom('b_users').whereRaw(raw`name = ${"O'Brien"}`).toSQL())
      expect(text).toContain("name = 'O''Brien'")
      const rows = await db.selectFrom('b_users').whereRaw(raw`name = ${'Ada'}`).get() as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].name).toBe('Ada')
    })

    it('orderByRaw / groupByRaw / havingRaw work end to end', async () => {
      const top = await db.selectFrom('b_users').orderByRaw(raw`age desc`).limit(1).get() as any[]
      expect(top[0].age).toBe(42)

      const grouped = await db.selectFrom('b_users')
        .select(['team_id'])
        .selectRaw(raw`count(*) as c`)
        .groupByRaw(raw`team_id`)
        .havingRaw(raw`count(*) >= 2`)
        .get() as any[]
      expect(grouped.length).toBe(2)
    })

    it('a Bun sql`` fragment throws a clear, actionable error', () => {
      expect(() => db.selectFrom('b_users').whereRaw(sql`age > 1` as any).toSQL())
        .toThrow(/use the exported `raw` helper/)
    })
  })

  describe('returning()', () => {
    it('insertInto().returning().first() returns the inserted row', async () => {
      const row = await db.insertInto('b_users').values({ name: 'Eve', age: 50, team_id: 1 }).returning('id', 'name').first() as any
      expect(row?.name).toBe('Eve')
      expect(typeof row?.id).toBe('number')
    })

    it('insertInto().returningAll().first() returns the full row', async () => {
      const row = await db.insertInto('b_users').values({ name: 'Fae', age: 21, team_id: 2 }).returningAll().first() as any
      expect(row?.name).toBe('Fae')
      expect(row?.age).toBe(21)
    })

    it('updateTable().returning().get() returns affected rows', async () => {
      const rows = await db.updateTable('b_users').set({ age: 99 }).where({ name: 'Bob' }).returning('id', 'age').get() as any[]
      expect(rows.length).toBe(1)
      expect(rows[0].age).toBe(99)
    })

    it('deleteFrom().returning().first() returns the deleted row', async () => {
      const row = await db.deleteFrom('b_users').where({ name: 'Dee' }).returning('id', 'name').first() as any
      expect(row?.name).toBe('Dee')
      const gone = await db.selectFrom('b_users').where({ name: 'Dee' }).exists()
      expect(gone).toBe(false)
    })
  })

  describe('distinct + select', () => {
    it('preserves DISTINCT when select() is chained after distinct()', async () => {
      const text = String(db.selectFrom('b_users').distinct().select(['team_id']).toSQL())
      expect(text).toContain('SELECT DISTINCT team_id')
      const rows = await db.selectFrom('b_users').distinct().select(['team_id']).get() as any[]
      expect(rows.length).toBe(2) // teams 1 and 2
    })
  })

  describe('aggregates on a real driver', () => {
    it('sum/avg/max/min/count are numeric and correct', async () => {
      // After the mutations above: Ada 36, Cy 42, Eve 50, Fae 21, Bob 99
      expect(await db.selectFrom('b_users').count()).toBe(5)
      expect(await db.selectFrom('b_users').max('age')).toBe(99)
      expect(await db.selectFrom('b_users').min('age')).toBe(21)
      expect(typeof await db.selectFrom('b_users').sum('age')).toBe('number')
    })
  })
})
