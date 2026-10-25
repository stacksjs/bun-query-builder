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

  /**
   * With prepared statements kept, the driver may refuse OR recover — but it
   * must never answer with the pre-migration column set.
   *
   * This used to assert the refusal text outright, which was true of Bun 1.4.3
   * and stopped being true in 1.4.4: the driver now re-prepares and returns the
   * new column list. Reproduced both ways against the same live Postgres, so
   * this is a driver change rather than anything about this library:
   *
   *     bun 1.4.3   3 pass
   *     bun 1.4.4   1 fail   Expected to contain: "cached plan must not change
   *                          result type"   Received: [ "id", "a", "b" ]
   *
   * CI found it before any of us did, on a commit nobody had touched, because
   * `setup-bun` pinned no version — so a Bun release flipped main from green to
   * red with no change in the repository. The pin in ci.yml is the other half
   * of this fix.
   *
   * So the assertion is now the invariant that actually matters, and it holds on
   * both versions. `['id', 'a']` is the dangerous answer: a stale plan served as
   * if current, which would hand an application a row shape its schema no longer
   * has. Refusing is safe and recovering is safe; silently going stale is not.
   */
  it('never serves the pre-migration column set with prepared statements kept', async () => {
    const result = await afterMigration(true)

    if (typeof result === 'string') {
      // Bun 1.4.3 and earlier: PostgreSQL's refusal reaches the caller.
      expect(result).toContain('cached plan must not change result type')
      return
    }

    // Bun 1.4.4 and later: re-prepared, so the new column is visible.
    expect(result).toEqual(['id', 'a', 'b'])
  })
})
