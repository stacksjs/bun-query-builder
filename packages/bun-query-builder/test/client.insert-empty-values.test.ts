/**
 * `insertInto(t).values([])` must be a no-op, not a stand-in query.
 * stacksjs/bun-query-builder#1097.
 *
 * It ran `SELECT 1` when handed an empty batch, which is invisible in the
 * database — no row is ever written — but wrong at every other layer:
 *
 *  - `.execute()` resolved to a FABRICATED row: `[{ '?column?': 1 }]` on
 *    Postgres, `[{ '1': 1 }]` on SQLite. A caller checking `result.length` saw
 *    1 where the truth was 0.
 *  - a query hook fired, labelled `insert`, for an insert that never happened.
 *  - `.returning(...)` appended RETURNING to `SELECT 1` and died with
 *    `near "RETURNING": syntax error`.
 *
 * It answers empty rather than throwing because `values(rows)` where `rows`
 * came back empty is ordinary calling code — the seeder scaffold this package
 * generates (`actions/seed.ts`) is written exactly that way, so a throw would
 * turn an empty dataset into a failed seed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

const MODELS = {
  t: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' } } },
} as any

// A file rather than `:memory:`: the client opens its own connection from the
// configured path, and a `:memory:` database is per-connection, so the table
// created here would be invisible to it.
let dir: string
let dbPath: string
let snapshot: { dialect: string, database: Record<string, unknown>, hooks: unknown }

function qb(): any {
  return createQueryBuilder({
    schema: buildDatabaseSchema(MODELS),
    meta: buildSchemaMeta(MODELS),
    autoMigration: { enabled: false } as any,
  })
}

/** Row count read through a fresh connection, not the builder's. */
function rowCount(): number {
  const probe = new Database(dbPath)
  const [{ c }] = probe.query('SELECT count(*) c FROM t').all() as any[]
  probe.close()
  return c
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database }, hooks: (config as any).hooks }
  dir = mkdtempSync(join(tmpdir(), 'qb-1097-'))
  dbPath = join(dir, 'empty-values.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  seed.close()
  setConfig({ dialect: 'sqlite', database: { database: dbPath } } as any)
  resetConnection()
})

afterEach(() => {
  config.dialect = snapshot.dialect as any
  for (const k of Object.keys(config.database)) delete (config.database as any)[k]
  Object.assign(config.database, snapshot.database)
  ;(config as any).hooks = snapshot.hooks
  resetConnection()
  rmSync(dir, { recursive: true, force: true })
})

describe('insertInto().values([]) is a no-op (#1097)', () => {
  it('reports nothing inserted instead of a fabricated row', async () => {
    const result: any = await qb().insertInto('t').values([]).execute()

    // The bun:sqlite wrapper reports { changes, lastInsertRowid }; zeros are
    // the honest answer. What must never come back is a row.
    expect(Array.isArray(result)).toBe(false)
    expect(result.changes).toBe(0)

    expect(rowCount()).toBe(0)
  })

  it('does not run a query, so no hook fires', async () => {
    const seen: string[] = []
    setConfig({ hooks: { onQueryStart: () => { seen.push('start') } } } as any)

    await qb().insertInto('t').values([]).execute()

    expect(seen).toEqual([])
  })

  it('emits no SQL', () => {
    const sql = qb().insertInto('t').values([]).toSQL()
    expect(String(sql?.sql ?? '')).toBe('')
  })

  describe('returning()', () => {
    it('resolves empty instead of failing to parse', async () => {
      // Previously: `near "RETURNING": syntax error`, because RETURNING was
      // appended to the `SELECT 1` stand-in.
      const rows = await qb().insertInto('t').values([]).returning('id').execute()
      expect(rows).toEqual([])
    })

    it('keeps the row accessors present and empty', async () => {
      const b = qb().insertInto('t').values([]).returning('id')

      // `.returning(...).first()` exists on the real builder, so it has to
      // exist here too rather than throwing "first is not a function".
      expect(await b.get()).toEqual([])
      expect(await b.first()).toBeUndefined()
      expect(await b.executeTakeFirst()).toBeUndefined()
      await expect(b.firstOrFail()).rejects.toThrow(/returned no rows/)
    })

    it('behaves the same through returningAll()', async () => {
      const rows = await qb().insertInto('t').values([]).returningAll().execute()
      expect(rows).toEqual([])
    })
  })

  it('leaves a non-empty insert alone', async () => {
    const seen: string[] = []
    setConfig({ hooks: { onQueryStart: () => { seen.push('start') } } } as any)

    const result: any = await qb().insertInto('t').values([{ name: 'a' }]).execute()
    expect(result.changes).toBe(1)
    expect(seen.length).toBe(1)

    const rows = await qb().insertInto('t').values([{ name: 'b' }]).returning('id').execute()
    expect(rows).toHaveLength(1)

    expect(rowCount()).toBe(2)
  })

  it('reuses the builder correctly when a later call has rows', async () => {
    // The empty batch sets a flag; a subsequent values() with rows has to clear
    // it, or the second insert would silently do nothing.
    const b = qb().insertInto('t')
    b.values([])
    b.values([{ name: 'later' }])
    const result: any = await b.execute()

    expect(result.changes).toBe(1)
    expect(rowCount()).toBe(1)
  })
})

describe('insertInto().values([]) on Postgres (#1097)', () => {
  it('resolves to [] — what a real insert affecting no rows returns', async () => {
    // No connection is opened: the empty batch short-circuits before touching
    // the driver, which is what makes this assertable without a live server.
    setConfig({ dialect: 'postgres', database: { url: 'postgres://unused:5432/none' } } as any)
    resetConnection()

    const result = await qb().insertInto('t').values([]).execute()

    // Postgres returns [] for an insert without RETURNING, so an empty batch is
    // deliberately indistinguishable from a real one that inserted nothing.
    expect(result).toEqual([])
  })
})
