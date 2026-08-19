/**
 * `updateMany` runs with the predicate the caller gave it, or not at all.
 * stacksjs/bun-query-builder#1112.
 *
 * The WHERE clause was appended only for an array, or for an object that both
 * lacked a `raw` key and had at least one key. Every other shape produced an
 * UPDATE with no predicate — no error, full affected count reported as
 * success:
 *
 *     updateMany('t', raw('id = 1'), { name: 'T' })   -> all four rows rewritten
 *     updateMany('t', {},            { name: 'T' })   -> all four rows rewritten
 *
 * The fragment form is the one that reads like correct code: `conditions` is
 * declared `WhereExpression`, which includes `WhereRaw`, and `raw` is a public
 * export — so it typechecks and passes review. The empty-object form is the
 * one that reaches production, because `conditions` is typically built from
 * request input and an empty filter is what you get from an empty query
 * string.
 *
 * `conditions` is a required parameter, so no value of it can legitimately
 * mean "every row". Anything unreadable is refused rather than dropped; the
 * caller who really wants an unfiltered update writes
 * `updateTable(t).set(data).execute()`, which says so.
 *
 * The array form also interpolated its operator into the SQL unvalidated,
 * while every other builder ran it through `assertSafeWhereOperator` — see the
 * last block.
 *
 * Assertions are on surviving rows. The bug was damage.
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

function names(): string[] {
  const probe = new Database(dbPath)
  const out = (probe.query('SELECT name FROM t ORDER BY id').all() as any[]).map(r => r.name)
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1112-'))
  dbPath = join(dir, 'many.sqlite')
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

describe('a fragment is honoured as a predicate (#1112)', () => {
  it('raw() updates only the rows it selects', async () => {
    await qb().updateMany('t', raw('id = 1') as any, { name: 'T' })

    // Previously: ['T','T','T','T'].
    expect(names()).toEqual(['T', 'b', 'c', 'd'])
  })

  it('a bound fragment keeps its own parameters ahead of nothing else', async () => {
    await qb().updateMany('t', { sql: 'id > ?', parameters: [2] } as any, { name: 'T' })

    expect(names()).toEqual(['a', 'b', 'T', 'T'])
  })
})

describe('an unreadable condition is refused, not dropped (#1112)', () => {
  it('{} names the problem and rewrites nothing', async () => {
    await expect(qb().updateMany('t', {} as any, { name: 'T' }))
      .rejects.toThrow(/an empty object is not a filter/)

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })

  for (const [label, value] of [['undefined', undefined], ['null', null]] as const) {
    it(`${label} throws and rewrites nothing`, async () => {
      await expect(qb().updateMany('t', value as any, { name: 'T' }))
        .rejects.toThrow(/expected a condition/)

      expect(names()).toEqual(['a', 'b', 'c', 'd'])
    })
  }

  it('the message points at the call that does mean every row', async () => {
    await expect(qb().updateMany('t', {} as any, { name: 'T' }))
      .rejects.toThrow(/updateTable\(table\)\.set\(data\)\.execute\(\)/)
  })
})

describe('the forms that already worked still work (#1112)', () => {
  it('object conditions', async () => {
    await qb().updateMany('t', { id: 2 } as any, { name: 'T' })
    expect(names()).toEqual(['a', 'T', 'c', 'd'])
  })

  it('array conditions', async () => {
    await qb().updateMany('t', ['id', '>=', 3] as any, { name: 'T' })
    expect(names()).toEqual(['a', 'b', 'T', 'T'])
  })

  it('an empty data object is still a no-op', async () => {
    expect(await qb().updateMany('t', { id: 2 } as any, {})).toBe(0)
    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('the array form validates its operator (#1112)', () => {
  // Every other builder routes the operator through assertSafeWhereOperator;
  // this one interpolated it. The array form is exactly the shape a filter DSL
  // builds from request input, so the operator slot is reachable.
  //
  // A payload has to keep the placeholder count at one to get past the driver's
  // arity check — `'>0 OR id>'` does, and rewrote the whole table.
  it('refuses an operator outside the allowed set, and writes nothing', async () => {
    await expect(qb().updateMany('t', ['id', '>0 OR id>', 0] as any, { name: 'PWNED' }))
      .rejects.toThrow(/refusing to use '>0 OR id>' as a SQL operator/)

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('still accepts the operators it is supposed to', async () => {
    await qb().updateMany('t', ['name', 'like', 'c'] as any, { name: 'T' })
    expect(names()).toEqual(['a', 'b', 'T', 'd'])
  })
})
