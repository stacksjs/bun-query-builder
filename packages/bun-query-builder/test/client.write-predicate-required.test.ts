/**
 * A write must never run without the predicate the caller supplied.
 * stacksjs/bun-query-builder#1101 (and the empty-object half of #1095).
 *
 * `updateTable(...).where(x)` and `deleteFrom(...).where(x)` accepted argument
 * shapes they could not turn into a predicate and then returned `this`
 * unchanged. The statement kept no WHERE at all, so it ran against every row
 * and reported the full affected count as success:
 *
 *     deleteFrom(t).where(undefined)                -> deleted all 4 rows
 *     updateTable(t).set(v).where(raw('id = 1'))    -> rewrote all 4 rows
 *
 * The `raw()` case is the serious one, because it is not a mistake the types
 * catch: the declared signature is `WhereExpression | K | SqlFragment` and
 * `raw` is a public export, so that call reads correctly and passes review.
 *
 * Two different remedies, deliberately:
 *  - a fragment is SUPPORTED, because the signature promises it,
 *  - anything the builder genuinely cannot read is REFUSED, because a write
 *    builder is the wrong place to treat "I could not understand your filter"
 *    as "match every row".
 *
 * `where({})` throws with a message naming the problem instead of the SQL
 * syntax error it used to produce — that is #1095, whose reported symptom was
 * always the safe one.
 *
 * Every assertion below checks SURVIVING ROWS, not just that a call threw. The
 * bug was damage, so the table is the thing worth asserting on.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, raw } from '../src'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

const MODELS = {
  t: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' } } },
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

function rows(): Array<{ id: number, name: string }> {
  const probe = new Database(dbPath)
  const out = probe.query('SELECT id, name FROM t ORDER BY id').all() as any[]
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1101-'))
  dbPath = join(dir, 'writes.sqlite')
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
  resetConnection()
  rmSync(dir, { recursive: true, force: true })
})

describe('DELETE refuses to run without a predicate (#1101)', () => {
  for (const [label, value] of [['undefined', undefined], ['null', null]] as const) {
    it(`where(${label}) throws and leaves every row in place`, () => {
      // Synchronously, at the point of the mistake — no statement is ever built.
      expect(() => qb().deleteFrom('t').where(value as any))
        .toThrow(/expected a condition/)

      // The assertion that matters: all four rows are still here.
      expect(rows()).toHaveLength(4)
    })
  }

  it('where({}) names the problem instead of emitting a broken statement', () => {
    expect(() => qb().deleteFrom('t').where({}))
      .toThrow(/an empty object is not a filter/)
    expect(rows()).toHaveLength(4)
  })
})

describe('UPDATE refuses to run without a predicate (#1101)', () => {
  for (const [label, value] of [['undefined', undefined], ['null', null]] as const) {
    it(`where(${label}) throws and rewrites nothing`, () => {
      expect(() => qb().updateTable('t').set({ name: 'X' }).where(value as any))
        .toThrow(/expected a condition/)

      expect(rows().filter(r => r.name === 'X')).toHaveLength(0)
    })
  }

  it('where({}) names the problem instead of emitting a broken statement', () => {
    expect(() => qb().updateTable('t').set({ name: 'X' }).where({}))
      .toThrow(/an empty object is not a filter/)
    expect(rows().filter(r => r.name === 'X')).toHaveLength(0)
  })
})

describe('a SQL fragment is honoured, not dropped (#1101)', () => {
  // The signature accepts SqlFragment, so these have to work — refusing them
  // would swap a silent catastrophe for a broken advertised API.

  it('DELETE where(raw(...)) removes only the matching row', async () => {
    await qb().deleteFrom('t').where(raw('id = 1')).execute()

    // Previously this threw on Postgres (the fragment was bound as a value)
    // and, on the update side, wiped the table.
    expect(rows().map(r => r.id)).toEqual([2, 3, 4])
  })

  it('UPDATE where(raw(...)) rewrites only the matching row', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where(raw('id = 1')).execute()

    const after = rows()
    expect(after.filter(r => r.name === 'X').map(r => r.id)).toEqual([1])
    expect(after).toHaveLength(4)
  })

  it('DELETE honours a parameterised fragment', async () => {
    await qb().deleteFrom('t').where({ sql: 'id = ?', parameters: [2] } as any).execute()
    expect(rows().map(r => r.id)).toEqual([1, 3, 4])
  })

  it('UPDATE honours a parameterised fragment', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where({ sql: 'id = ?', parameters: [2] } as any).execute()
    expect(rows().filter(r => r.name === 'X').map(r => r.id)).toEqual([2])
  })

  it('does not mistake a bound fragment for a column map', async () => {
    // `{ sql, parameters }` is an object, so an ordering slip would render it
    // as `"sql" = ? AND "parameters" = ?` and match nothing — silently.
    await qb().deleteFrom('t').where({ sql: 'id = ?', parameters: [3] } as any).execute()
    expect(rows().map(r => r.id)).toEqual([1, 2, 4])
  })
})

describe('ordinary writes are unaffected (#1101)', () => {
  it('DELETE with an object filter still removes exactly its rows', async () => {
    await qb().deleteFrom('t').where({ id: 1 }).execute()
    expect(rows().map(r => r.id)).toEqual([2, 3, 4])
  })

  it('UPDATE with an object filter still rewrites exactly its rows', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where({ id: 2 }).execute()
    expect(rows().filter(r => r.name === 'X').map(r => r.id)).toEqual([2])
  })

  it('the 3-arg form still works on both builders', async () => {
    await qb().updateTable('t').set({ name: 'X' }).where('id', '=', 3).execute()
    expect(rows().filter(r => r.name === 'X').map(r => r.id)).toEqual([3])

    await qb().deleteFrom('t').where('id', '=', 4).execute()
    expect(rows().map(r => r.id)).toEqual([1, 2, 3])
  })

  it('an intentional unfiltered write is still possible without where()', async () => {
    // Refusing an unreadable filter must not remove the ability to write the
    // whole table on purpose — the point is that it has to be explicit.
    await qb().deleteFrom('t').execute()
    expect(rows()).toHaveLength(0)
  })
})
