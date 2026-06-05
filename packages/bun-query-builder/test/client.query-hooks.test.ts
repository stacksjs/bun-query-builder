/**
 * Coverage for query-hook observability (stacksjs/bun-query-builder#1045):
 * slow-query threshold + onSlowQuery, and `params` populated on hook events.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'
import { config, defaultConfig } from '../src/config'
import { resetConnection } from '../src/db'

describe('query hooks: slow-query + params (#1045)', () => {
  let dir: string
  let saved: Record<string, any>

  beforeEach(async () => {
    // Reset config to a clean baseline so cross-file pollution (a leftover
    // dialect / sql setting) can't corrupt SQL generation, then pin sqlite.
    saved = { ...config }
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    dir = mkdtempSync(join(tmpdir(), 'qb-hooks-'))
    config.dialect = 'sqlite' as any
    config.database.database = join(dir, 't.db')
    resetConnection()
    const db = createQueryBuilder() as any
    await db.unsafe('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
    await db.unsafe(`INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b')`)
  })
  afterEach(() => {
    for (const k of Object.keys(config)) delete (config as any)[k]
    Object.assign(config, saved)
    resetConnection()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fires onSlowQuery (threshold 0 => every query) with sql + duration', async () => {
    const slow: any[] = []
    config.hooks = { slowQueryThresholdMs: 0, onSlowQuery: e => slow.push(e) }
    await (createQueryBuilder() as any).selectFrom('items').where({ id: 1 }).get()
    expect(slow.length).toBeGreaterThan(0)
    expect(typeof slow[0].sql).toBe('string')
    expect(typeof slow[0].durationMs).toBe('number')
    expect(slow[0].kind).toBe('select')
  })

  it('populates params on onQueryEnd (best-effort, sqlite)', async () => {
    const ends: any[] = []
    config.hooks = { onQueryEnd: e => ends.push(e) }
    await (createQueryBuilder() as any).selectFrom('items').where({ id: 2 }).get()
    expect(ends.length).toBeGreaterThan(0)
    expect(ends[ends.length - 1].params).toEqual([2])
  })

  it('does not fire onSlowQuery below the threshold', async () => {
    const slow: any[] = []
    config.hooks = { slowQueryThresholdMs: 999_999, onSlowQuery: e => slow.push(e) }
    await (createQueryBuilder() as any).selectFrom('items').get()
    expect(slow.length).toBe(0)
  })
})
