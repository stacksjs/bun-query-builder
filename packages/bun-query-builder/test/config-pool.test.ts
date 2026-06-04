/**
 * Coverage for connection-pool config (stacksjs/bun-query-builder#1014).
 *
 * `DatabaseConfig.pool` lets callers tune the underlying Bun SQL pool. The
 * ergonomic ms-based fields are mapped onto Bun's native (second-resolution)
 * option names by `resolvePoolOptions`, and threaded into `new SQL(...)` for
 * the network dialects.
 */

import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { config } from '../src/config'
import { getBunSql, resetConnection, resolvePoolOptions } from '../src/db'

describe('resolvePoolOptions (#1014)', () => {
  it('returns empty options when no pool config is given', () => {
    expect(resolvePoolOptions(undefined)).toEqual({})
    expect(resolvePoolOptions({})).toEqual({})
  })

  it('maps max straight through', () => {
    expect(resolvePoolOptions({ max: 20 })).toEqual({ max: 20 })
  })

  it('converts ms timeouts to Bun second-resolution option names', () => {
    expect(resolvePoolOptions({
      idleTimeoutMs: 30_000,
      acquireTimeoutMs: 5_000,
      maxLifetimeMs: 600_000,
    })).toEqual({
      idleTimeout: 30,
      connectionTimeout: 5,
      maxLifetime: 600,
    })
  })

  it('rounds sub-second timeout values', () => {
    expect(resolvePoolOptions({ idleTimeoutMs: 1_500 })).toEqual({ idleTimeout: 2 })
    expect(resolvePoolOptions({ idleTimeoutMs: 400 })).toEqual({ idleTimeout: 0 })
  })

  it('does not emit forward-compat fields the driver manages itself', () => {
    // min / autoReconnect are accepted on PoolConfig but not passed to Bun SQL.
    expect(resolvePoolOptions({ max: 5, min: 2, autoReconnect: false } as any)).toEqual({ max: 5 })
  })

  it('combines all supported knobs', () => {
    expect(resolvePoolOptions({ max: 10, idleTimeoutMs: 10_000, acquireTimeoutMs: 2_000, maxLifetimeMs: 60_000 }))
      .toEqual({ max: 10, idleTimeout: 10, connectionTimeout: 2, maxLifetime: 60 })
  })
})

describe('getBunSql with pool config (#1014)', () => {
  let snapshot: { dialect: string, database: Record<string, unknown> }

  beforeEach(() => {
    snapshot = { dialect: config.dialect, database: { ...config.database } }
  })

  afterEach(() => {
    config.dialect = snapshot.dialect as any
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('constructs a network-dialect connection with pool options without throwing', () => {
    config.dialect = 'postgres' as any
    config.database.pool = { max: 7, idleTimeoutMs: 20_000, acquireTimeoutMs: 3_000 }
    resetConnection()
    // Bun's SQL connects lazily, so construction must not throw even without a
    // live server — it just has to accept the pool options.
    let sql: unknown
    expect(() => { sql = getBunSql() }).not.toThrow()
    expect(sql).toBeTruthy()
  })
})
