/**
 * The relation sugar — `with`, `withCount`, `withSum`, `has`, `whereHas`,
 * `selectAllRelations` — builds its JOINs and correlated subqueries from table
 * and key names taken out of the schema, and interpolated every one of them
 * bare. stacksjs/bun-query-builder#1207.
 *
 * So fixing `selectFrom`'s own FROM was not enough: `.with('orders')` on a
 * `user`/`order` pair still emitted
 *
 *     SELECT * FROM "user" LEFT JOIN order ON order.user_id = user.id
 *
 * where only the part the select builder owns had been quoted. Each of these
 * paths names four or five identifiers per statement and any one of them is
 * enough to make it a syntax error.
 *
 * The pairing here is the realistic one rather than a contrived one: a `user`
 * table (Postgres reserves it, SQLite does not) with many `order` rows
 * (reserved everywhere). Run against a real Bun.SQL sqlite connection, because
 * the mock-`sql` relation tests never execute the text they assert — the same
 * gap that hid #1 and #2 in `client.with-eager.e2e.test.ts`.
 */

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'RwUser',
  table: 'user',
  primaryKey: 'id',
  hasMany: { orders: 'RwOrder' },
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
  },
})
const Order = defineModel({
  name: 'RwOrder',
  table: 'order',
  primaryKey: 'id',
  belongsTo: { user: 'RwUser' },
  attributes: {
    id: { validation: { rule: {} as any } },
    // `${singularize('user')}_id` — the FK the relation infers.
    user_id: { validation: { rule: {} as any } },
    total: { validation: { rule: {} as any } },
  },
})

const models = defineModels({ RwUser: User, RwOrder: Order })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: any
let prevSoftDeletes: typeof config.softDeletes

beforeAll(async () => {
  // `config` is a shared module global and other files toggle soft deletes;
  // pinned off so the JOINs don't gain an `AND order.deleted_at IS NULL` for
  // tables without that column. Same reasoning as client.with-eager.e2e.
  prevSoftDeletes = config.softDeletes
  config.softDeletes = { enabled: false, column: 'deleted_at', defaultFilter: false }

  sql = new SQL({ adapter: 'sqlite', filename: ':memory:' } as any)
  await sql`CREATE TABLE "user" (id INTEGER PRIMARY KEY, name TEXT)`
  await sql`CREATE TABLE "order" (id INTEGER PRIMARY KEY, user_id INTEGER, total INTEGER)`
  await sql`INSERT INTO "user" (id, name) VALUES (1, 'ann'), (2, 'bob')`
  await sql`INSERT INTO "order" (id, user_id, total) VALUES (1, 1, 10), (2, 1, 20), (3, 2, 30)`
  db = createQueryBuilder({ schema, meta, sql } as any)
})

afterAll(async () => {
  config.softDeletes = prevSoftDeletes
  await sql.close()
})

describe('relation sugar across reserved-word tables (#1207)', () => {
  it('quotes every identifier in a with() JOIN', () => {
    const text = String(db.selectFrom('user').with('orders').toSQL())
    expect(text).toBe('SELECT * FROM "user" LEFT JOIN "order" ON "order".user_id = "user".id')
  })

  it('executes with() from the parent', async () => {
    // Was `near "order": syntax error`.
    expect((await db.selectFrom('user').with('orders').execute()).length).toBe(3)
  })

  it('executes with() from the child, over the belongsTo', async () => {
    expect((await db.selectFrom('order').with('user').execute()).length).toBe(3)
  })

  it('executes withCount(), which is a correlated subquery', async () => {
    const got = await db.selectFrom('user').withCount('orders').execute()
    expect(got.length).toBe(2)
  })

  it('executes has()', async () => {
    expect((await db.selectFrom('user').has('orders').execute()).length).toBe(2)
  })

  it('executes whereHas() with a constraint callback', async () => {
    // The callback builds its own `target.column op value` fragment, which was
    // the last bare interpolation left in this family.
    const got = await db.selectFrom('user').whereHas('orders', (q: any) => q.where('total', '=', 10)).execute()
    expect(got.length).toBe(1)
  })

  it('quotes both sides in selectAllRelations', () => {
    const text = String(db
      .selectFrom('user')
      .innerJoin('order', 'user.id', '=', 'order.user_id')
      .selectAllRelations()
      .toSQL())
    expect(text).toContain('SELECT "user".*')
    expect(text).toContain('"order".total AS order_total')
    expect(text).toContain('FROM "user"')
  })
})
