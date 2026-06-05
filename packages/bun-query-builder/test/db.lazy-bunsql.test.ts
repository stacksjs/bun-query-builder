/**
 * Regression coverage for the lazy `bunSql` proxy callability (discovered while
 * fixing stacksjs/bun-query-builder#1035).
 *
 * The proxy wrapped a `{}` target, so per spec it had no [[Call]] and the
 * `apply` trap was dead — `bunSql`...`` / `bunSql(...)` threw "not a function",
 * silently breaking every method built on the tagged template (upsert /
 * insertOrIgnore / insertGetId / updateOrInsert / save). The target is now a
 * function, so the tagged template works.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bunSql, resetConnection } from '../src/db'
import { config } from '../src/config'

describe('lazy bunSql proxy is callable (#1035 prerequisite)', () => {
  let snapshot: { dialect: string, database: Record<string, unknown> }
  beforeEach(() => { snapshot = { dialect: config.dialect, database: { ...config.database } } })
  afterEach(() => {
    config.dialect = snapshot.dialect as any
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('bunSql`...` builds a runnable query (sqlite) instead of throwing "not a function"', async () => {
    config.dialect = 'sqlite' as any
    config.database.database = ':memory:'
    resetConnection()
    const q = (bunSql as any)`SELECT 1 as one`
    expect(typeof q.execute).toBe('function')
    const rows = await q.execute()
    expect(rows[0]?.one).toBe(1)
  })

  it('bunSql(identifier) is callable (returns a raw marker, not a throw)', () => {
    config.dialect = 'sqlite' as any
    config.database.database = ':memory:'
    resetConnection()
    expect(() => (bunSql as any)('some_column')).not.toThrow()
  })
})
