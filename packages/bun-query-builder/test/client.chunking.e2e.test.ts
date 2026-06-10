/**
 * chunk() / chunkById() / eachById() / cursorPaginate() against a REAL
 * database (sqlite via Bun.SQL). These iterate by re-querying, so they only
 * work correctly end to end — the mock-sql tests never caught:
 *
 * - chunk() looped forever when the row count was an exact multiple of the
 *   chunk size: paginate() CLAMPS an out-of-range page back to the last page,
 *   so a full final page never triggered the old `data.length < size` stop.
 *
 * - cursorPaginate() set nextCursor to the peek row (the perPage+1'th row
 *   fetched only to detect "has more"), so the next page queried
 *   `col > <peek>` and SKIPPED that row — dropping one row at every page
 *   boundary and silently truncating chunkById()/eachById().
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const Row = defineModel({
  name: 'CRow',
  table: 'c_rows',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    n: { validation: { rule: {} as any } },
  },
})
const models = defineModels({ CRow: Row })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>
let prevDialect: typeof config.dialect
let prevSoftDeletes: typeof config.softDeletes

async function seed(count: number) {
  await sql`DELETE FROM c_rows`
  for (let i = 1; i <= count; i++)
    await sql`INSERT INTO c_rows (id, n) VALUES (${i}, ${`r${i}`})`
}

describe('chunk / cursor pagination (real sqlite)', () => {
  beforeAll(async () => {
    prevDialect = config.dialect
    prevSoftDeletes = config.softDeletes
    config.dialect = 'sqlite'
    config.softDeletes = { enabled: false, column: 'deleted_at', defaultFilter: false }
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE c_rows (id INTEGER PRIMARY KEY, n TEXT)`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    config.dialect = prevDialect
    config.softDeletes = prevSoftDeletes
    await sql.close()
  })

  it('chunk() covers every row when count is an exact multiple of size', async () => {
    await seed(6)
    let total = 0
    let batches = 0
    await db.selectFrom('c_rows').orderBy('id').chunk!(2, (rows) => {
      total += rows.length
      batches += 1
    })
    expect(total).toBe(6)
    expect(batches).toBe(3)
  })

  it('chunk() handles a non-multiple count and a single short page', async () => {
    await seed(7)
    let total = 0
    let batches = 0
    await db.selectFrom('c_rows').orderBy('id').chunk!(3, (rows) => {
      total += rows.length
      batches += 1
    })
    expect(total).toBe(7)
    expect(batches).toBe(3) // 3 + 3 + 1
  })

  it('chunk() with size larger than total yields one batch', async () => {
    await seed(4)
    let total = 0
    let batches = 0
    await db.selectFrom('c_rows').orderBy('id').chunk!(100, (rows) => {
      total += rows.length
      batches += 1
    })
    expect(total).toBe(4)
    expect(batches).toBe(1)
  })

  it('chunk() over an empty table does not invoke the handler', async () => {
    await seed(0)
    let calls = 0
    await db.selectFrom('c_rows').orderBy('id').chunk!(2, () => { calls += 1 })
    expect(calls).toBe(0)
  })

  it('chunkById() / eachById() cover every row (no boundary skips)', async () => {
    await seed(7)
    const ids: number[] = []
    await db.selectFrom('c_rows').chunkById!(2, 'id', (rows) => {
      for (const r of rows as any[]) ids.push(r.id)
    })
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7])

    let each = 0
    await db.selectFrom('c_rows').eachById!(3, 'id', () => { each += 1 })
    expect(each).toBe(7)
  })

  it('cursorPaginate() walks the full set forward without skipping', async () => {
    await seed(7)
    const seen: number[] = []
    let cursor: any
    for (let i = 0; i < 20; i++) {
      const { data, meta: m } = await db.selectFrom('c_rows').cursorPaginate!(3, cursor, 'id', 'asc')
      for (const r of data as any[]) seen.push(r.id)
      if (!m.nextCursor)
        break
      cursor = m.nextCursor
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('cursorPaginate() walks descending without skipping', async () => {
    await seed(7)
    const seen: number[] = []
    let cursor: any
    for (let i = 0; i < 20; i++) {
      const { data, meta: m } = await db.selectFrom('c_rows').cursorPaginate!(3, cursor, 'id', 'desc')
      for (const r of data as any[]) seen.push(r.id)
      if (!m.nextCursor)
        break
      cursor = m.nextCursor
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1])
  })
})
