/**
 * SQLite `unsafe()` must return rows for anything that produces rows —
 * stacksjs/bun-query-builder#1205.
 *
 * `executeStatement` chose between `query` and `run` by the statement's first
 * word (`SELECT`, `PRAGMA`, or `RETURNING` anywhere in the text), which is a
 * different question from whether the statement yields a result set. A read
 * opening with a CTE or a comment failed that test and went to `run`:
 *
 *   "WITH t AS (SELECT 1 AS one) SELECT one FROM t" -> {"changes":0,"lastInsertRowid":0}
 *   "-- a comment first\nSELECT 1 AS one"           -> {"changes":0,"lastInsertRowid":0}
 *
 * The same SQL returned rows on Postgres, so code written against Postgres
 * destructured the result and threw `TypeError: {} is not iterable`, far from
 * the cause. Found paging the Stacks dashboard's error groups with a window
 * function (stacksjs/stacks#3195).
 *
 * The dispatch now asks the prepared statement for its `columnNames`, which is
 * sqlite's own answer and needs no keyword list.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import { createQueryBuilder, setConfig } from '../src'

let qb: any

beforeAll(() => {
  setConfig({ dialect: 'sqlite', database: { database: ':memory:' } } as any)
  qb = createQueryBuilder()
})

describe('a statement that produces rows returns rows', () => {
  it('a plain SELECT, which already worked', () => {
    // The rows, where the call stands: bun:sqlite answers in place.
    expect(qb.unsafe('SELECT 1 AS one').execute()).toEqual([{ one: 1 }])
  })

  it('a common table expression', async () => {
    // The shape that started the issue: a window-function page query.
    expect(await qb.unsafe('WITH t AS (SELECT 1 AS one) SELECT one FROM t').execute())
      .toEqual([{ one: 1 }])
  })

  it('a statement behind a line comment', async () => {
    expect(await qb.unsafe('-- a comment first\nSELECT 1 AS one').execute())
      .toEqual([{ one: 1 }])
  })

  it('a statement behind a block comment', async () => {
    expect(await qb.unsafe('/* block */ SELECT 1 AS one').execute())
      .toEqual([{ one: 1 }])
  })

  it('a bare VALUES list', async () => {
    const rows = await qb.unsafe('VALUES (1)').execute()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it('the result is iterable, which is how the bug surfaced', async () => {
    // `{ changes, lastInsertRowid }` threw `TypeError: {} is not iterable`
    // rather than reporting anything about the query.
    const [first] = await qb.unsafe('WITH t AS (SELECT 7 AS n) SELECT n FROM t').execute()
    expect(first).toEqual({ n: 7 })
  })
})

describe('a statement that produces no rows still reports its changes', () => {
  it('keeps the write path intact', async () => {
    await qb.unsafe('CREATE TABLE dispatch_t (id INTEGER PRIMARY KEY, v INTEGER)').execute()

    const inserted = await qb.unsafe('INSERT INTO dispatch_t (v) VALUES (1)').execute()
    expect(inserted).toMatchObject({ changes: 1 })

    const updated = await qb.unsafe('UPDATE dispatch_t SET v = v + 1').execute()
    expect(updated).toMatchObject({ changes: 1 })
  })

  it('a CTE wrapping a write has no result set, so it keeps its change count', async () => {
    // The case a keyword rule accepting `WITH` would have broken.
    const result = await qb.unsafe('WITH x AS (SELECT 5 AS v) INSERT INTO dispatch_t (v) SELECT v FROM x').execute()
    expect(result).toMatchObject({ changes: 1 })
    expect(Array.isArray(result)).toBe(false)
  })

  it('a write with RETURNING does produce rows', async () => {
    const rows = await qb.unsafe('INSERT INTO dispatch_t (v) VALUES (9) RETURNING v').execute()
    expect(rows).toEqual([{ v: 9 }])
  })
})
