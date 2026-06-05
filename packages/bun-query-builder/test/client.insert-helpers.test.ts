/**
 * Coverage for the explicit-INSERT helper methods (stacksjs/bun-query-builder#1052):
 * upsert / insertOrIgnore / insertGetId / updateOrInsert now build parameterized
 * SQL instead of Bun's broken `${sql(table)} ${sql(values)}` composition, so they
 * actually execute on every dialect.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'
import { config, defaultConfig } from '../src/config'
import { resetConnection } from '../src/db'

describe('insert/upsert helper execution (#1052)', () => {
  let dir: string
  let saved: Record<string, any>
  let db: any

  beforeEach(async () => {
    saved = { ...config }
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    dir = mkdtempSync(join(tmpdir(), 'qb-ins-'))
    config.dialect = 'sqlite' as any
    config.database.database = join(dir, 't.db')
    resetConnection()
    db = createQueryBuilder() as any
    await db.unsafe('CREATE TABLE kv (id INTEGER PRIMARY KEY, k TEXT UNIQUE, v TEXT)')
  })
  afterEach(() => {
    for (const k of Object.keys(config)) delete (config as any)[k]
    Object.assign(config, saved)
    resetConnection()
    rmSync(dir, { recursive: true, force: true })
  })

  it('insertGetId returns the new id', async () => {
    const id = await db.insertGetId('kv', { k: 'a', v: '1' })
    expect(id).toBe(1)
  })

  it('insertOrIgnore skips a conflicting row instead of throwing', async () => {
    await db.insertGetId('kv', { k: 'a', v: '1' })
    await db.insertOrIgnore('kv', { k: 'a', v: 'X' }) // duplicate unique k -> ignored
    const rows = await db.unsafe(`SELECT v FROM kv WHERE k = 'a'`)
    expect(rows[0].v).toBe('1')
  })

  it('upsert merges on conflict, and DO NOTHING with no merge columns', async () => {
    await db.insertGetId('kv', { k: 'a', v: '1' })
    await db.upsert('kv', [{ k: 'a', v: '2' }], ['k'], ['v']) // merge -> v = 2
    expect((await db.unsafe(`SELECT v FROM kv WHERE k = 'a'`))[0].v).toBe('2')
    await db.upsert('kv', [{ k: 'a', v: '3' }], ['k']) // no merge -> DO NOTHING
    expect((await db.unsafe(`SELECT v FROM kv WHERE k = 'a'`))[0].v).toBe('2')
  })

  it('updateOrInsert updates an existing match and inserts a new one', async () => {
    await db.insertGetId('kv', { k: 'a', v: '1' })
    await db.updateOrInsert('kv', { k: 'a' }, { v: '9' }) // exists -> update
    await db.updateOrInsert('kv', { k: 'b' }, { v: 'b1' }) // missing -> insert
    const rows = await db.unsafe('SELECT k, v FROM kv ORDER BY k')
    expect(rows).toEqual([{ k: 'a', v: '9' }, { k: 'b', v: 'b1' }])
  })
})
