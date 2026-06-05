/**
 * Regression coverage for stacksjs/bun-query-builder#1041.
 *
 * getOrCreateBunSql cached on dialect + database.database only, so changing
 * host/port/url/credentials/pool via setConfig kept the stale connection. The
 * cache now keys on the full connection signature.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { config } from '../src/config'
import { getOrCreateBunSql, resetConnection } from '../src/db'

describe('connection cache invalidation (#1041)', () => {
  let snapshot: { dialect: string, database: Record<string, unknown> }
  beforeEach(() => {
    snapshot = { dialect: config.dialect, database: { ...config.database } }
    config.dialect = 'sqlite' as any
    config.database.database = ':memory:'
    resetConnection()
  })
  afterEach(() => {
    config.dialect = snapshot.dialect as any
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('returns the cached instance when nothing relevant changed', () => {
    const a = getOrCreateBunSql()
    expect(getOrCreateBunSql()).toBe(a)
  })

  it('rebuilds when host changes (previously ignored)', () => {
    const a = getOrCreateBunSql()
    config.database.host = 'some-other-host'
    expect(getOrCreateBunSql()).not.toBe(a)
  })

  it('rebuilds when pool config changes (previously ignored)', () => {
    const a = getOrCreateBunSql()
    config.database.pool = { max: 25 }
    expect(getOrCreateBunSql()).not.toBe(a)
  })

  it('rebuilds when url changes (previously ignored)', () => {
    const a = getOrCreateBunSql()
    config.database.url = 'sqlite://./other.db'
    expect(getOrCreateBunSql()).not.toBe(a)
  })
})
