/**
 * A filter applied after returning() must reach the statement.
 * stacksjs/bun-query-builder#1110.
 *
 * `returning()` froze the statement text at call time and handed back an
 * object whose filter methods were literally no-ops:
 *
 *     { where: () => obj, andWhere: () => obj, orWhere: () => obj,
 *       orderBy: () => obj, limit: () => obj, offset: () => obj }
 *
 * so every filter expressed after it was discarded and the unfiltered
 * statement ran:
 *
 *     updateTable(t).set(v).returning('id').where({ id: 1 })  -> rewrote all rows
 *     deleteFrom(t).returning('id').where({ id: 1 })          -> emptied the table
 *
 * Three things made it worse than a dropped predicate:
 *
 *  - it REPORTED SUCCESS for work it never scoped. `.where('id','=',99)
 *    .executeTakeFirst()` returned a row that cannot match 99, while rewriting
 *    everything.
 *  - the types invite it. `returning()` is declared to return
 *    SelectQueryBuilder, which declares where/andWhere/orWhere/orderBy/limit,
 *    so the broken order type-checks under --strict.
 *  - on the delete side it skipped beforeDelete/afterDelete, so adding
 *    `.returning(...)` walked straight past an application delete guard.
 *
 * The fix defers rendering to execute time and delegates the filters to the
 * builder that owns the statement. Methods that genuinely cannot be expressed
 * on a write (orderBy/limit/offset/orWhere) now throw rather than being
 * ignored — silently ignoring `limit(1)` is what turned a one-row delete into
 * a whole-table one.
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

function rows(): Array<{ id: number, name: string }> {
  const probe = new Database(dbPath)
  const out = probe.query('SELECT id, name FROM t ORDER BY id').all() as any[]
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database }, hooks: (config as any).hooks }
  dir = mkdtempSync(join(tmpdir(), 'qb-1110-'))
  dbPath = join(dir, 'ret.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  seed.run(`INSERT INTO t (id, name) VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')`)
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

describe('UPDATE: a filter after returning() applies (#1110)', () => {
  it('rewrites only the matching row', async () => {
    const returned = await qb().updateTable('t').set({ name: 'X' }).returning('id').where({ id: 1 }).execute()

    expect(returned).toEqual([{ id: 1 }])
    expect(rows().filter(r => r.name === 'X').map(r => r.id)).toEqual([1])
    expect(rows()).toHaveLength(4)
  })

  it('does not report a row it never matched', async () => {
    // The sharp edge: this used to return { id: 1 } while rewriting all four.
    const first = await qb().updateTable('t').set({ name: 'Y' }).returning('id').where('id', '=', 99).executeTakeFirst()

    expect(first).toBeUndefined()
    expect(rows().filter(r => r.name === 'Y')).toHaveLength(0)
  })

  it('still works in the other order', async () => {
    const returned = await qb().updateTable('t').set({ name: 'Z' }).where({ id: 1 }).returning('id').execute()
    expect(returned).toEqual([{ id: 1 }])
    expect(rows().filter(r => r.name === 'Z').map(r => r.id)).toEqual([1])
  })

  it('andWhere and whereNull reach the statement too', async () => {
    const returned = await qb().updateTable('t').set({ name: 'W' })
      .returning('id').where({ id: 2 }).andWhere('name', '=', 'b')
      .execute()

    expect(returned).toEqual([{ id: 2 }])
    expect(rows().filter(r => r.name === 'W').map(r => r.id)).toEqual([2])
  })
})

describe('DELETE: a filter after returning() applies (#1110)', () => {
  it('removes only the matching row', async () => {
    const returned = await qb().deleteFrom('t').returning('id').where({ id: 1 }).execute()

    expect(returned).toEqual([{ id: 1 }])
    expect(rows().map(r => r.id)).toEqual([2, 3, 4])
  })

  it('fires beforeDelete, so a delete guard cannot be walked past', async () => {
    setConfig({ hooks: { beforeDelete: () => { throw new Error('BLOCKED by guard') } } } as any)

    await expect(qb().deleteFrom('t').returning('id').where({ id: 1 }).execute())
      .rejects.toThrow(/BLOCKED by guard/)

    expect(rows()).toHaveLength(4)
  })
})

describe('the returning handle is not a snapshot (#1110)', () => {
  it('picks up a predicate added to the parent after it was taken', async () => {
    const builder = qb().deleteFrom('t')
    const handle = builder.returning('id')
    builder.where({ id: 2 })

    expect(await handle.execute()).toEqual([{ id: 2 }])
    expect(rows().map(r => r.id)).toEqual([1, 3, 4])
  })

  it('applies to returningAll() as well', async () => {
    const builder = qb().deleteFrom('t')
    const handle = builder.returningAll()
    builder.where({ id: 3 })

    const returned = await handle.execute()
    expect(returned.map((r: any) => r.id)).toEqual([3])
    expect(rows().map(r => r.id)).toEqual([1, 2, 4])
  })
})

describe('what a write cannot express now says so (#1110)', () => {
  // Silently ignoring these is what let `.limit(1)` on a delete remove
  // everything while reading like it removed one row.
  for (const method of ['orderBy', 'limit', 'offset', 'orWhere'] as const) {
    it(`deleteFrom.returning(...).${method}() throws instead of being ignored`, () => {
      expect(() => (qb().deleteFrom('t').returning('id') as any)[method]('id'))
        .toThrow(/not supported/)
      expect(rows()).toHaveLength(4)
    })

    it(`updateTable.returning(...).${method}() throws instead of being ignored`, () => {
      expect(() => (qb().updateTable('t').set({ name: 'Q' }).returning('id') as any)[method]('id'))
        .toThrow(/not supported/)
      expect(rows().filter(r => r.name === 'Q')).toHaveLength(0)
    })
  }
})
