/**
 * An array value in object-form where() means IN, on writes as well as reads.
 * stacksjs/bun-query-builder#1114.
 *
 * The select builder has read `where({ id: [3, 2] })` as `id IN (3, 2)` since
 * #1013/#1083. The write builders bound the whole array to a single
 * placeholder, so the same input meant two different things depending on which
 * statement it was attached to:
 *
 *     selectFrom(t).where({ id: [3, 2] })   -> rows 2 and 3
 *     deleteFrom(t).where({ id: [3, 2] })   -> deletes nothing
 *
 * This is the opposite direction to #1101 — the write is too NARROW, so it
 * destroys nothing. But it fails silently and reports success, and it fails in
 * exactly the case people write it for: the bulk delete of a set of ids.
 *
 * All three write paths now share one renderer with the same semantics. The
 * mixed case matters most for the shared code: the old per-key index
 * arithmetic (`baseIdx + i + 1`) assumed one parameter per key, which an
 * array breaks.
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
  t: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' }, tenant: { type: 'integer' } } },
} as any

let dir: string
let dbPath: string
let snapshot: { dialect: string, database: Record<string, unknown> }

function qb(): any {
  return createQueryBuilder({
    schema: buildDatabaseSchema(MODELS),
    meta: buildSchemaMeta(MODELS),
    autoMigration: { enabled: false } as any,
  })
}

function ids(): number[] {
  const probe = new Database(dbPath)
  const out = (probe.query('SELECT id FROM t ORDER BY id').all() as any[]).map(r => r.id)
  probe.close()
  return out
}

function renamed(): number[] {
  const probe = new Database(dbPath)
  const out = (probe.query(`SELECT id FROM t WHERE name = 'X' ORDER BY id`).all() as any[]).map(r => r.id)
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1114-'))
  dbPath = join(dir, 'arr.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, tenant INTEGER)')
  seed.run(`INSERT INTO t (id,name,tenant) VALUES (1,'a',1),(2,'b',1),(3,'c',1),(4,'d',999)`)
  seed.close()
  setConfig({ dialect: 'sqlite', database: { database: dbPath } } as any)
  resetConnection()
})

afterEach(() => {
  config.dialect = snapshot.dialect as any
  for (const k of Object.keys(config.database)) delete (config.database as any)[k]
  Object.assign(config.database, snapshot.database)
  resetConnection()
  rmSync(dir, { recursive: true, force: true })
})

describe('reads and writes agree on what an array means (#1114)', () => {
  it('SELECT reads it as IN — the behaviour the writes now match', async () => {
    const rows = await qb().selectFrom('t').select('id').where({ id: [3, 2] }).execute()
    expect(rows.map((r: any) => r.id).sort()).toEqual([2, 3])
  })

  it('DELETE removes exactly those rows', async () => {
    await qb().deleteFrom('t').where({ id: [3, 2] }).execute()

    // Previously: deleted nothing, and reported success.
    expect(ids()).toEqual([1, 4])
  })

  it('UPDATE rewrites exactly those rows', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where({ id: [3, 2] }).execute()
    expect(renamed()).toEqual([2, 3])
  })

  it('updateMany does too', async () => {
    await qb().updateMany('t', { id: [3, 2] } as any, { name: 'X' })
    expect(renamed()).toEqual([2, 3])
  })
})

describe('an array alongside a scalar binds in the right order (#1114)', () => {
  // The old code computed each parameter index as `baseIdx + i + 1`, one per
  // key. An array contributes several, so every parameter after it was bound
  // to the wrong placeholder.
  it('DELETE with both a list and a scalar', async () => {
    const sql = String(qb().deleteFrom('t').where({ id: [2, 3], tenant: 1 } as any).toSQL())
    expect(sql).toBe('DELETE FROM "t" WHERE "id" IN (?, ?) AND "tenant" = ?')

    await qb().deleteFrom('t').where({ id: [2, 3], tenant: 1 } as any).execute()
    expect(ids()).toEqual([1, 4])
  })

  it('the scalar still constrains — a row outside the tenant survives', async () => {
    await qb().deleteFrom('t').where({ id: [3, 4], tenant: 1 } as any).execute()

    // id 4 is tenant 999, so only 3 goes.
    expect(ids()).toEqual([1, 2, 4])
  })
})

describe('an empty array matches nothing, never everything (#1114)', () => {
  // The only safe reading on a write: a filter the caller supplied must not
  // widen to "every row" because the collection came back empty. This is what
  // the select builder already does (FALSE_PREDICATE).
  it('DELETE with an empty list deletes nothing', async () => {
    await qb().deleteFrom('t').where({ id: [] } as any).execute()
    expect(ids()).toEqual([1, 2, 3, 4])
  })

  it('and does not drop the other conditions either', async () => {
    await qb().deleteFrom('t').where({ id: [], tenant: 1 } as any).execute()
    expect(ids()).toEqual([1, 2, 3, 4])
  })

  it('UPDATE with an empty list rewrites nothing', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where({ id: [] } as any).execute()
    expect(renamed()).toEqual([])
  })
})

describe('the scalar form is unchanged (#1114)', () => {
  it('DELETE', async () => {
    await qb().deleteFrom('t').where({ id: 2 }).execute()
    expect(ids()).toEqual([1, 3, 4])
  })

  it('UPDATE with two scalars', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where({ id: 2, tenant: 1 } as any).execute()
    expect(renamed()).toEqual([2])
  })
})
