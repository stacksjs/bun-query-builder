/**
 * `returningAll()` is `returning('*')`, and must stay that way.
 * stacksjs/stacks#2637.
 *
 * It used to be a second implementation that appended ` RETURNING *` itself,
 * and every fix `returning()` earned stopped at its door:
 *
 *  - no MySQL branch, so it emitted `RETURNING *` at a server that has no
 *    RETURNING clause. Every `returningAll()` write on MySQL was a syntax
 *    error rather than a write - and since the statement never ran, nothing
 *    was written either. 63 call sites in Stacks alone, four of them behind
 *    dashboard PATCH routes.
 *  - no delete hooks, so `.returningAll()` on a delete walked straight past
 *    an application `beforeDelete` guard, which is the usual reason to write
 *    one.
 *  - no filter delegation, so a predicate applied after the handle was taken
 *    could not reach the statement (the #1110 shape).
 *  - no row accessors, though the declared return type is SelectQueryBuilder,
 *    which has them - `.returningAll().first()` threw "not a function".
 *
 * These run on SQLite, which takes RETURNING natively, so what they pin is
 * the delegation rather than the MySQL text. The MySQL behaviour was measured
 * directly against MySQL 8.4.5: before, update/insert/delete each raised
 * errno 1064 and left the table untouched; after, each returns its row and
 * the write lands.
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
  dir = mkdtempSync(join(tmpdir(), 'qb-2637-'))
  dbPath = join(dir, 'ret-all.sqlite')
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

describe('returningAll() is returning(\'*\')', () => {
  // The structural guard. Behaviour tests below say what the handle must do;
  // this one says there is only one implementation of it, so a reintroduced
  // bespoke returningAll() fails here rather than silently shedding whatever
  // returning() gains next.
  for (const [name, take] of [
    ['insertInto', (b: any) => b.insertInto('t').values({ name: 'z' })],
    ['updateTable', (b: any) => b.updateTable('t').set({ name: 'z' })],
    ['deleteFrom', (b: any) => b.deleteFrom('t')],
  ] as Array<[string, (b: any) => any]>) {
    it(`${name} hands back the same surface either way`, () => {
      const all = Object.keys(take(qb()).returningAll()).sort()
      const star = Object.keys(take(qb()).returning('*')).sort()

      expect(all).toEqual(star)
      // Row accessors the declared SelectQueryBuilder type promises. The old
      // update/delete handles carried four methods and none of these.
      expect(all).toContain('first')
      expect(all).toContain('get')
      expect(all).toContain('firstOrFail')
    })
  }

  it('returns every column of the updated row, and writes it', async () => {
    const row = await qb().updateTable('t').set({ name: 'X' }).where({ id: 2 }).returningAll().executeTakeFirst()

    expect(row).toEqual({ id: 2, name: 'X' })
    expect(rows().filter(r => r.name === 'X').map(r => r.id)).toEqual([2])
  })

  it('returns every column of the inserted row', async () => {
    const row = await qb().insertInto('t').values({ id: 9, name: 'i' }).returningAll().executeTakeFirst()

    expect(row).toEqual({ id: 9, name: 'i' })
  })

  it('returns every column of the deleted row, and removes it', async () => {
    const row = await qb().deleteFrom('t').where({ id: 3 }).returningAll().executeTakeFirst()

    expect(row).toEqual({ id: 3, name: 'c' })
    expect(rows().map(r => r.id)).toEqual([1, 2, 4])
  })

  it('fires the delete hooks, so a beforeDelete guard still sees it', async () => {
    const seen: string[] = []
    ;(config as any).hooks = {
      beforeDelete: ({ table }: any) => { seen.push(`before:${table}`) },
      afterDelete: ({ table }: any) => { seen.push(`after:${table}`) },
    }

    await qb().deleteFrom('t').where({ id: 1 }).returningAll().execute()

    // Both were absent here while `.returning('id')` fired them, which is the
    // shape that let adding returningAll() bypass a delete guard.
    expect(seen).toEqual(['before:t', 'after:t'])
  })

  it('takes a predicate applied after the handle (#1110)', async () => {
    const builder = qb().deleteFrom('t')
    const handle = builder.returningAll()
    builder.where({ id: 4 })

    expect((await handle.execute()).map((r: any) => r.id)).toEqual([4])
    expect(rows().map(r => r.id)).toEqual([1, 2, 3])
  })

  for (const method of ['orderBy', 'limit', 'offset', 'orWhere'] as const) {
    it(`refuses ${method}() rather than ignoring it`, () => {
      expect(() => (qb().deleteFrom('t').returningAll() as any)[method]('id')).toThrow(/not supported/)
      expect(rows()).toHaveLength(4)
    })
  }
})
