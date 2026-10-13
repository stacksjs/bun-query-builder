/**
 * `pool.preparedStatements: false` maps to Bun SQL's `prepare: false`, and so
 * survives a migration that changes a table under `SELECT *`. With prepared
 * statements kept (the driver's default), PostgreSQL refuses the cached
 * statement — "cached plan must not change result type" — and that query
 * fails on its connection until the process restarts.
 */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { resolvePoolOptions } from '../src/db'
import { PG_URL, probePostgres } from './pg'

describe('pool.preparedStatements', () => {
  it('maps to Bun SQL prepare, and only when set', () => {
    expect(resolvePoolOptions({ preparedStatements: false })).toEqual({ prepare: false })
    expect(resolvePoolOptions({ preparedStatements: true })).toEqual({ prepare: true })
    expect(resolvePoolOptions({ max: 4 })).toEqual({ max: 4 })
  })
})

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('a schema change under a repeated query (live Postgres)', () => {
  const table = `qb_prepare_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

  async function afterMigration(prepare: boolean): Promise<string[] | string> {
    const admin = new SQL({ url: PG_URL, max: 1 })
    const sql = new SQL({ url: PG_URL, max: 1, ...resolvePoolOptions({ preparedStatements: prepare }) })
    try {
      await admin.unsafe(`create table ${table} (id int, a int)`)
      await admin.unsafe(`insert into ${table} values (1, 2)`)
      await sql.unsafe(`select * from ${table} where id = $1`, [1])
      await admin.unsafe(`alter table ${table} add column b int`)
      const rows = await sql.unsafe(`select * from ${table} where id = $1`, [1]) as Record<string, unknown>[]
      return Object.keys(rows[0]!)
    }
    catch (error) {
      return (error as Error).message
    }
    finally {
      await admin.unsafe(`drop table if exists ${table}`)
      await sql.close()
      await admin.close()
    }
  }

  it('sees the new column with preparedStatements: false', async () => {
    expect(await afterMigration(false)).toEqual(['id', 'a', 'b'])
  })

  it('is refused with prepared statements kept, which is what the option is for', async () => {
    expect(await afterMigration(true)).toContain('cached plan must not change result type')
  })
})
