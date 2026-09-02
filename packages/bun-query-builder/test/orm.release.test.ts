/**
 * `configureOrm({ database })` used to be a one-way door.
 *
 * `globalDb` outranks `setConfig()` in `getExecutor`, and nothing could remove
 * it - only repoint it. In a runner that shares one process across many files,
 * the last file to configure the ORM left every later one pinned to a database
 * it owned and usually deleted in its own teardown, so everything afterwards
 * failed with `RangeError: Cannot use a closed database` against a connection
 * it never asked for (stacksjs/stacks#2415).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config, setConfig } from '../src/config'
import { configureOrm, getDatabase, releaseOrm } from '../src/orm'

const dialect = config.dialect
const database = { ...config.database }

afterEach(() => {
  releaseOrm()
  setConfig({ dialect, database } as any)
})

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'bqb-release-')), 'db.sqlite')
}

describe('releaseOrm', () => {
  it('gives resolution back to setConfig', () => {
    const configured = tempDbPath()
    const fallback = tempDbPath()

    setConfig({ dialect: 'sqlite', database: { database: fallback } } as any)
    configureOrm({ database: configured })
    expect(getDatabase().filename).toBe(configured)

    releaseOrm()

    // The override is gone, so the configured connection answers again -
    // rather than a handle this module opened and no caller can reach.
    expect(getDatabase().filename).toBe(fallback)
  })

  it('closes a handle it opened from a path', () => {
    configureOrm({ database: tempDbPath() })
    const opened = getDatabase()

    releaseOrm()

    // `query` on a closed Database throws; that is the observable difference
    // between released and merely forgotten, and a forgotten handle is a file
    // descriptor nobody can close.
    expect(() => opened.query('select 1').get()).toThrow()
  })

  it('leaves a caller-supplied Database open', () => {
    // Bring your own connection, keep your own lifetime: this module did not
    // open it and must not decide when it ends.
    const mine = new Database(':memory:', { create: true })
    configureOrm({ database: mine })

    releaseOrm()

    expect(mine.query('select 1 as n').get()).toEqual({ n: 1 })
    mine.close()
  })

  it('is safe to call when nothing was configured', () => {
    expect(() => releaseOrm()).not.toThrow()
    expect(() => releaseOrm()).not.toThrow()
  })
})
