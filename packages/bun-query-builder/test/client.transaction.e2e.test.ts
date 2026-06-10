/**
 * Transactions against a REAL sqlite database (Bun.SQL).
 *
 * Regression guard: `db.transaction()` calls `<conn>.begin(...)`, but the
 * SQLite connection wrapper had no `.begin()` — so EVERY `db.transaction()`
 * on the sqlite dialect threw "bunSql.begin is not a function". The only
 * existing transaction "test" lived inside a type-only function (never
 * executed), so this was completely uncovered at runtime.
 *
 * Also guards that transaction() uses THIS builder's injected connection
 * rather than the always-global `bunSql` (otherwise reads and tx-writes hit
 * different in-memory databases).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'TxUser',
  table: 'tx_users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
    age: { validation: { rule: {} as any } },
  },
})
const models = defineModels({ TxUser: User })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>
let prevDialect: typeof config.dialect

describe('transactions (real sqlite)', () => {
  beforeAll(() => {
    prevDialect = config.dialect
    config.dialect = 'sqlite'
    sql = new SQL('sqlite://:memory:')
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  beforeEach(async () => {
    await sql`DROP TABLE IF EXISTS tx_users`
    await sql`CREATE TABLE tx_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)`
  })

  afterAll(async () => {
    config.dialect = prevDialect
    await sql.close()
  })

  it('commits inserts made inside the transaction', async () => {
    await db.transaction!(async (tx: any) => {
      await tx.insertInto('tx_users').values({ name: 'Ada', age: 36 }).execute()
      await tx.insertInto('tx_users').values({ name: 'Bob', age: 28 }).execute()
    })
    expect(await db.selectFrom('tx_users').count()).toBe(2)
  })

  it('rolls back all work when the callback throws', async () => {
    await db.insertInto('tx_users').values({ name: 'Keep', age: 1 }).execute()
    await expect(db.transaction!(async (tx: any) => {
      await tx.insertInto('tx_users').values({ name: 'Drop', age: 2 }).execute()
      throw new Error('boom')
    })).rejects.toThrow('boom')
    // Pre-existing row stays; the transaction's insert is gone.
    expect(await db.selectFrom('tx_users').count()).toBe(1)
    expect(await db.selectFrom('tx_users').where({ name: 'Drop' }).exists()).toBe(false)
    expect(await db.selectFrom('tx_users').where({ name: 'Keep' }).exists()).toBe(true)
  })

  it('returns the callback result', async () => {
    const result = await db.transaction!(async () => 'done')
    expect(result).toBe('done')
  })

  it('reads its own writes inside the transaction', async () => {
    await db.transaction!(async (tx: any) => {
      await tx.insertInto('tx_users').values({ name: 'Cy', age: 42 }).execute()
      const seen = await tx.selectFrom('tx_users').where({ name: 'Cy' }).exists()
      expect(seen).toBe(true)
    })
  })

  it('supports nested transactions via savepoints (inner rollback, outer commit)', async () => {
    await db.transaction!(async (tx: any) => {
      await tx.insertInto('tx_users').values({ name: 'Outer', age: 1 }).execute()
      await expect(tx.transaction(async (tx2: any) => {
        await tx2.insertInto('tx_users').values({ name: 'Inner', age: 2 }).execute()
        throw new Error('inner boom')
      })).rejects.toThrow('inner boom')
      // Outer transaction survives the inner rollback.
    })
    expect(await db.selectFrom('tx_users').where({ name: 'Outer' }).exists()).toBe(true)
    expect(await db.selectFrom('tx_users').where({ name: 'Inner' }).exists()).toBe(false)
  })

  it('commits nested savepoints when both succeed', async () => {
    await db.transaction!(async (tx: any) => {
      await tx.insertInto('tx_users').values({ name: 'A', age: 1 }).execute()
      await tx.transaction(async (tx2: any) => {
        await tx2.insertInto('tx_users').values({ name: 'B', age: 2 }).execute()
      })
    })
    expect(await db.selectFrom('tx_users').count()).toBe(2)
  })
})
