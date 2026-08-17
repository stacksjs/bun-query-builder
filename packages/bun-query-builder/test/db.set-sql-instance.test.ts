/**
 * Regression coverage for setSqlInstance().
 *
 * The connection cache moved from a dialect + database.database pair to a full
 * connection signature (#1041), but setSqlInstance kept assigning to the two
 * removed variables. They were never redeclared, so in an ESM module (always
 * strict mode) the function threw `ReferenceError: _currentDialect is not
 * defined` for every caller — the injection path was entirely unusable.
 *
 * Note that simply deleting those assignments would not have been enough:
 * leaving the signature null reads as "config changed" on the very next
 * getOrCreateBunSql() call, so the injected instance would be discarded before
 * anything could use it. These tests pin both halves.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { config } from '../src/config'
import { closeConnection, getOrCreateBunSql, resetConnection, setSqlInstance } from '../src/db'

describe('setSqlInstance', () => {
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

  it('does not throw (previously a ReferenceError on every call)', () => {
    expect(() => setSqlInstance({ injected: true } as any)).not.toThrow()
  })

  it('makes the injected instance the one handed out', () => {
    const injected = { injected: true } as any
    setSqlInstance(injected)
    expect(getOrCreateBunSql()).toBe(injected)
  })

  it('keeps handing out the injected instance on repeat calls', () => {
    const injected = { injected: true } as any
    setSqlInstance(injected)
    getOrCreateBunSql()
    expect(getOrCreateBunSql()).toBe(injected)
  })

  it('still rebuilds when the connection config changes afterwards', () => {
    const injected = { injected: true } as any
    setSqlInstance(injected)
    config.database.host = 'some-other-host'
    expect(getOrCreateBunSql()).not.toBe(injected)
  })

  it('is discarded by resetConnection()', () => {
    const injected = { injected: true } as any
    setSqlInstance(injected)
    resetConnection()
    expect(getOrCreateBunSql()).not.toBe(injected)
  })

  it('closes the discarded connection', () => {
    let closed = false
    const injected = {
      close: () => {
        closed = true
        return Promise.resolve()
      },
    } as any

    setSqlInstance(injected)
    resetConnection()

    expect(closed).toBeTrue()
  })

  it('can await a fully closed connection', async () => {
    let closed = false
    const injected = {
      close: async () => {
        await Promise.resolve()
        closed = true
      },
    } as any

    setSqlInstance(injected)
    await closeConnection()

    expect(closed).toBeTrue()
  })
})
