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

  it('delivers native completion before the connection can be reset', async () => {
    const ends: string[] = []
    config.hooks = { onQueryEnd: event => ends.push(event.sql) }
    const pending = (createQueryBuilder() as any).selectFrom('items').where({ id: 1 }).execute()
    // SQLite has already executed at this point. Diagnostic consumers must
    // see completion before a synchronous lifecycle boundary can close it.
    expect(ends).toHaveLength(1)
    resetConnection()
    expect(await pending).toHaveLength(1)
    expect(ends).toHaveLength(1)
  })

  it('delivers native errors once while preserving promise rejection', async () => {
    const errors: unknown[] = []
    config.hooks = { onQueryError: event => errors.push(event.error) }
    const pending = (createQueryBuilder() as any).selectFrom('missing_hook_table').execute()
    const observed = errors.slice()
    await expect(pending).rejects.toThrow('missing_hook_table')
    expect(observed).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  it('keeps undefined synchronous driver failures as rejections', async () => {
    const errors: unknown[] = []
    const completed: unknown[] = []
    config.hooks = {
      onQueryEnd: event => completed.push(event),
      onQueryError: event => errors.push(event.error),
    }
    const query = {
      execute: () => Promise.reject(undefined),
      executeSync: () => { throw undefined },
      toString: () => 'SELECT id FROM items',
    }
    const connection = Object.assign(() => query, { unsafe: () => query })
    const pending = (createQueryBuilder({ sql: connection as any }) as any).selectFrom('items').execute()
    const outcome = await pending.then(() => 'resolved', (error: unknown) => ({ error }))
    expect(outcome).toEqual({ error: undefined })
    expect(errors).toEqual([undefined])
    expect(completed).toHaveLength(0)
  })

  it('reports an already-aborted native query once through a rejected Promise', async () => {
    const errors: unknown[] = []
    const completed: unknown[] = []
    config.hooks = {
      onQueryEnd: event => completed.push(event),
      onQueryError: event => errors.push(event.error),
    }
    const controller = new AbortController()
    controller.abort()
    const pending = (createQueryBuilder() as any).selectFrom('items').abort(controller.signal).execute()
    expect(pending).toBeInstanceOf(Promise)
    const observed = errors.slice()
    await expect(pending).rejects.toMatchObject({ code: 'EBQBABORT' })
    expect(observed).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(completed).toHaveLength(0)
  })

  it('completes native queries with a timeout and reports hooks once', async () => {
    const completed: unknown[] = []
    const errors: unknown[] = []
    config.hooks = {
      onQueryEnd: event => completed.push(event),
      onQueryError: event => errors.push(event.error),
    }
    const pending = (createQueryBuilder() as any).selectFrom('items').withTimeout(1000).execute()
    expect(pending).toBeInstanceOf(Promise)
    expect(completed).toHaveLength(1)
    expect(await pending).toHaveLength(2)
    expect(completed).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })
})
