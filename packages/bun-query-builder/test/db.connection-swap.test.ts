/**
 * Replacing the cached connection must not close the one being replaced.
 *
 * `getOrCreateBunSql` rebuilds when the config signature changes. It used to
 * close the old instance on the way, but callers hold query builders that
 * captured it - so a config change in one place left an unrelated cached
 * builder somewhere else throwing `RangeError: Cannot use a closed database`,
 * with nothing connecting the two (stacksjs/stacks#2415).
 *
 * Deciding nobody holds the old connection is not something this function can
 * know. `closeConnection()` / `resetConnection()` are for callers who do.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config, setConfig } from '../src/config'
import { getOrCreateBunSql, resetConnection } from '../src/db'

const dialect = config.dialect
const database = { ...config.database }

afterEach(() => {
  resetConnection()
  setConfig({ dialect, database } as any)
})

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'bqb-swap-')), 'db.sqlite')
}

describe('swapping the cached connection', () => {
  it('leaves the replaced connection usable', async () => {
    setConfig({ dialect: 'sqlite', database: { database: tempDb() } } as any)
    const first = getOrCreateBunSql() as any
    await first.unsafe('create table t (id integer)')

    // A config change elsewhere: the cache rebuilds against the new database.
    setConfig({ dialect: 'sqlite', database: { database: tempDb() } } as any)
    const second = getOrCreateBunSql() as any

    expect(second).not.toBe(first)
    // The point: a caller still holding `first` is unaffected. Before this, the
    // line below threw `Cannot use a closed database`.
    expect(await first.unsafe('select count(*) as n from t')).toEqual([{ n: 0 }])
  })

  it('still hands back the same instance when the config has not changed', () => {
    setConfig({ dialect: 'sqlite', database: { database: tempDb() } } as any)

    expect(getOrCreateBunSql()).toBe(getOrCreateBunSql())
  })

  it('closes on an explicit reset, which is what that API is for', async () => {
    setConfig({ dialect: 'sqlite', database: { database: tempDb() } } as any)
    const sql = getOrCreateBunSql() as any
    await sql.unsafe('create table t (id integer)')

    resetConnection()
    // `resetConnection` closes asynchronously; give it the tick it needs.
    await Bun.sleep(50)

    expect(async () => await sql.unsafe('select 1 as n')).toThrow()
  })
})
