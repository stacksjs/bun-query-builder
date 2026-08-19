/**
 * The select builder's clause keywords follow builder state, not a text scan.
 * stacksjs/bun-query-builder#1120 and #1122.
 *
 * Two sites picked a keyword by searching the statement built so far — the
 * same defect #1113 fixed in the write builders, in a builder that kept it:
 *
 *     const kw = SQL_PATTERNS.WHERE.test(text) ? 'AND' : 'WHERE'   // :3482
 *     const kw = /\bHAVING\b/i.test(text) ? 'AND' : 'HAVING'       // :5617, :5650
 *
 * #1120 — the WHERE branch is reached only after a set operator, and by then
 * `text` holds the LEFT select including its WHERE. So a predicate on the left
 * was read as one on the right:
 *
 *     SELECT * FROM a WHERE y = $1 UNION SELECT * FROM b AND x = $2
 *
 * #1122 — `text` also holds the select list, so a raw fragment that merely
 * contains the word `having` made the first real HAVING emit as AND, fusing it
 * onto the GROUP BY list.
 *
 * Both emit invalid SQL rather than running against the wrong rows, so unlike
 * #1113 these assert on the emitted statement — that is where the defect lives.
 * The union cases also execute, because a keyword decision that produces valid
 * SQL can still produce the wrong ROWS, and only running it settles that.
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
  a: { columns: { id: { type: 'integer', isPrimaryKey: true }, x: { type: 'integer' }, y: { type: 'integer' } } },
  b: { columns: { id: { type: 'integer', isPrimaryKey: true }, x: { type: 'integer' }, y: { type: 'integer' } } },
  users: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' } } },
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

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1120-'))
  dbPath = join(dir, 'sel.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER)')
  seed.run('CREATE TABLE b (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER)')
  seed.run('INSERT INTO a (id,x,y) VALUES (1,1,2),(2,5,9)')
  seed.run('INSERT INTO b (id,x,y) VALUES (3,1,4),(4,7,8)')
  seed.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
  seed.run(`INSERT INTO users (id,name) VALUES (1,'a'),(2,'b'),(3,'b')`)
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

describe('a predicate after a set operator (#1120)', () => {
  it('a WHERE on the left does not make the right one an AND', () => {
    const sql = String(qb().selectFrom('a').where('y', '=', 2).union(qb().selectFrom('b')).where('x', '=', 1).toSQL())

    // Previously: `... UNION SELECT * FROM b AND x = ?`, which does not parse.
    expect(sql).toContain('UNION SELECT * FROM b WHERE x = ?')
  })

  it('and the statement actually runs', async () => {
    const rows = await qb().selectFrom('a').where('y', '=', 2).union(qb().selectFrom('b')).where('x', '=', 1).execute()

    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 3])
  })

  it('with no predicate on the left, the right one is still WHERE', () => {
    const sql = String(qb().selectFrom('a').union(qb().selectFrom('b')).where('x', '=', 1).toSQL())
    expect(sql).toContain('UNION SELECT * FROM b WHERE x = ?')
  })

  it('when the RIGHT side has its own predicate, AND is correct and is what is emitted', () => {
    const sql = String(qb().selectFrom('a').union(qb().selectFrom('b').where('y', '=', 4)).where('x', '=', 1).toSQL())

    expect(sql).toContain('WHERE y = ? AND x = ?')
  })

  it('intersect behaves the same way', () => {
    const sql = String(qb().selectFrom('a').where('y', '=', 2).intersect(qb().selectFrom('b')).where('x', '=', 1).toSQL())
    expect(sql).toContain('INTERSECT SELECT * FROM b WHERE x = ?')
  })

  it('chained predicates on the tail still join with AND', () => {
    const sql = String(qb().selectFrom('a').where('y', '=', 2).union(qb().selectFrom('b')).where('x', '=', 1).where('y', '=', 4).toSQL())
    expect(sql).toContain('UNION SELECT * FROM b WHERE x = ? AND y = ?')
  })
})

describe('HAVING is chosen from state, not from the select list (#1122)', () => {
  it('havingRaw() after a raw fragment containing the word', () => {
    const sql = String(qb().selectFrom('users').selectRaw(raw("'having a party' as t")).groupBy('id').havingRaw(raw('COUNT(id) > 3')).toSQL())

    // Previously: `... GROUP BY id AND COUNT(id) > 3`.
    expect(sql).toContain('GROUP BY id HAVING COUNT(id) > 3')
  })

  it('having() in its array form, same fragment', () => {
    const sql = String(qb().selectFrom('users').selectRaw(raw("'having a party' as t")).groupBy('id').having(['COUNT(id)', '>', 3]).toSQL())

    expect(sql).toContain('HAVING COUNT(id) > ?')
    expect(sql).not.toContain('GROUP BY id AND')
  })

  it('chained having() calls still join with AND (#1034 stays fixed)', () => {
    const sql = String(qb().selectFrom('users').groupBy('id').having(['COUNT(id)', '>', 1]).having(['COUNT(id)', '<', 9]).toSQL())

    expect(sql).toContain('HAVING COUNT(id) > ?')
    expect(sql).toContain('AND COUNT(id) < ?')
  })

  it('having() then havingRaw() joins with AND', () => {
    const sql = String(qb().selectFrom('users').groupBy('id').having(['COUNT(id)', '>', 1]).havingRaw(raw('COUNT(id) < 9')).toSQL())

    expect(sql).toContain('HAVING COUNT(id) > ?')
    expect(sql).toContain('AND COUNT(id) < 9')
  })

  it('a having that appends nothing does not claim the keyword', () => {
    // The empty-object branch emits no text, so the next call is still the
    // first HAVING rather than a stray AND.
    const sql = String(qb().selectFrom('users').groupBy('id').having({}).havingRaw(raw('COUNT(id) > 3')).toSQL())

    expect(sql).toContain('HAVING COUNT(id) > 3')
  })
})
