/**
 * Regression coverage for a real production bug (stacksjs/status#1 Phase 9
 * e2e verification): a Stacks app deployed to Hetzner via ts-cloud runs its
 * web/api/worker/scheduler processes as separate systemd sites, each with
 * its own working directory. When the configured sqlite file's parent
 * directory didn't already exist for a given site, `bun:sqlite`'s
 * `new Database(filename)` threw outright instead of creating it, so a
 * fresh box (or a not-yet-created `database/` dir) failed hard on boot.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { config } from '../src/config'
import { getOrCreateBunSql, resetConnection } from '../src/db'

describe('sqlite database file creation', () => {
  const dir = join(import.meta.dir, '.tmp-sqlite-mkdir-test')
  const dbPath = join(dir, 'nested', 'stacks.sqlite')
  let snapshot: { dialect: string, database: Record<string, unknown> }

  beforeEach(() => {
    snapshot = { dialect: config.dialect, database: { ...config.database } }
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    config.dialect = snapshot.dialect as any
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates missing parent directories instead of throwing', () => {
    expect(existsSync(dir)).toBe(false)

    config.dialect = 'sqlite' as any
    config.database.database = dbPath
    resetConnection()

    expect(() => getOrCreateBunSql()).not.toThrow()
    expect(existsSync(dbPath)).toBe(true)
  })
})
