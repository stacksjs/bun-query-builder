/**
 * The WHERE/AND keyword follows builder state, not a text search.
 * stacksjs/bun-query-builder#1113.
 *
 * Both write builders chose their keyword by testing the statement built so
 * far for `/\bWHERE\b/`:
 *
 *     const getWhereKeyword = () => SQL_PATTERNS.WHERE.test(sqlText) ? 'AND' : 'WHERE'
 *
 * Plenty of text that is not this builder's predicate satisfies that. A
 * subquery inside `set()`, a table named `where`, a column named `where` —
 * each one made the FIRST predicate come out as `AND`, which fuses it onto
 * whatever preceded it:
 *
 *     UPDATE "t" SET "flag" = (SELECT ... WHERE x.id > 3) AND "id" = ?
 *     DELETE FROM "where" AND "id" = ?
 *
 * The DELETE is a syntax error. The UPDATE is worse: it parses, the predicate
 * becomes part of the value being written, and the statement has no WHERE, so
 * it rewrites every row. Postgres only rejects it when the SET target's type
 * happens not to be boolean; SQLite takes it as written.
 *
 * That last case is why the UPDATE assertions here seed a non-zero column and
 * check every row. The reported repro writes `0` to rows that already held
 * `0`, so the damage is invisible unless the fixture makes it visible.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, raw } from '../src'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

// `where` is a legal identifier in every dialect this builder targets, as long
// as it is quoted — and the builder does quote it.
const MODELS = {
  t: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      name: { type: 'string' },
      flag: { type: 'integer' },
    },
  },
  where: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      name: { type: 'string' },
    },
  },
  hasreserved: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      where: { type: 'string' },
    },
  },
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

function all(table: string): any[] {
  const probe = new Database(dbPath)
  const out = probe.query(`SELECT * FROM "${table}" ORDER BY id`).all() as any[]
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1113-'))
  dbPath = join(dir, 'kw.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)')
  // Non-zero flags: an UPDATE that reaches every row has to be visible.
  seed.run(`INSERT INTO t (id,name,flag) VALUES (1,'a',7),(2,'b',7),(3,'c',7),(4,'d',7)`)
  seed.run('CREATE TABLE "where" (id INTEGER PRIMARY KEY, name TEXT)')
  seed.run(`INSERT INTO "where" (id,name) VALUES (1,'a'),(2,'b')`)
  seed.run('CREATE TABLE hasreserved (id INTEGER PRIMARY KEY, "where" TEXT)')
  seed.run(`INSERT INTO hasreserved (id,"where") VALUES (1,'a'),(2,'b')`)
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

describe('a WHERE inside a set() fragment does not steal the keyword (#1113)', () => {
  it('emits WHERE for the predicate, not AND', () => {
    const sql = String(qb()
      .updateTable('t')
      .set({ flag: raw('(SELECT count(*) FROM t x WHERE x.id > 3)') })
      .where({ id: 1 })
      .toSQL())

    expect(sql).toContain(') WHERE "id"')
    expect(sql).not.toContain(') AND "id"')
  })

  it('updates only the row the predicate selects', async () => {
    await qb()
      .updateTable('t')
      .set({ flag: raw('(SELECT count(*) FROM t x WHERE x.id > 3)') })
      .where({ id: 1 })
      .execute()

    // Previously every row was rewritten: the predicate became part of the
    // value, so rows 2-4 were assigned `(1) AND (id = 1)` = 0 and row 1 got 1.
    // Seeding 7 is what makes that visible.
    expect(all('t').map(r => r.flag)).toEqual([1, 7, 7, 7])
  })
})

describe('an identifier named `where` does not steal the keyword (#1113)', () => {
  it('a table named `where` still gets a WHERE clause on DELETE', async () => {
    const sql = String(qb().deleteFrom('where').where({ id: 1 }).toSQL())
    expect(sql).toBe('DELETE FROM "where" WHERE "id" = ?')

    // It used to emit `DELETE FROM "where" AND "id" = ?` — a syntax error.
    await qb().deleteFrom('where').where({ id: 1 }).execute()
    expect(all('where').map(r => r.id)).toEqual([2])
  })

  it('a table named `where` still gets a WHERE clause on UPDATE', async () => {
    await qb().updateTable('where').set({ name: 'X' }).where({ id: 1 }).execute()
    expect(all('where').map(r => r.name)).toEqual(['X', 'b'])
  })

  it('a column named `where` in set() does not absorb the predicate', async () => {
    await qb().updateTable('hasreserved').set({ where: 'X' }).where({ id: 1 }).execute()
    expect(all('hasreserved').map(r => r.where)).toEqual(['X', 'b'])
  })
})

describe('chained predicates still join with AND (#1015 stays fixed)', () => {
  it('UPDATE: second where() is AND', () => {
    const sql = String(qb().updateTable('t').set({ name: 'X' }).where('id', '=', 1).where('name', '=', 'a').toSQL())
    expect(sql).toContain('WHERE "id" = ?')
    expect(sql).toContain('AND "name" = ?')
  })

  it('DELETE: second where() is AND', () => {
    const sql = String(qb().deleteFrom('t').where('id', '=', 1).where('name', '=', 'a').toSQL())
    expect(sql).toContain('WHERE "id" = ?')
    expect(sql).toContain('AND "name" = ?')
  })

  it('DELETE: whereNull then whereNotNull', () => {
    const sql = String(qb().deleteFrom('t').whereNull('name').whereNotNull('flag').toSQL())
    expect(sql).toBe('DELETE FROM "t" WHERE "name" IS NULL AND "flag" IS NOT NULL')
  })

  it('UPDATE: a raw fragment first, then a column predicate', () => {
    const sql = String(qb().updateTable('t').set({ name: 'X' }).where(raw('id > 2')).where('name', '=', 'c').toSQL())
    expect(sql).toContain('WHERE id > 2')
    expect(sql).toContain('AND "name" = ?')
  })

  it('DELETE: a raw fragment carrying its own WHERE is still the first predicate', () => {
    const sql = String(qb().deleteFrom('t').where(raw('id IN (SELECT id FROM t x WHERE x.id > 3)')).whereNotNull('name').toSQL())
    expect(sql).toBe('DELETE FROM "t" WHERE id IN (SELECT id FROM t x WHERE x.id > 3) AND "name" IS NOT NULL')
  })
})
