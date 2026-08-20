/**
 * Clause placement reads statement structure, not text that merely looks like it.
 * stacksjs/bun-query-builder#1121.
 *
 * Three scanners decided where a clause goes, each with its own idea of what
 * SQL is:
 *
 *     firstTailIndex           paren depth only
 *     insertJoin               paren depth only
 *     computeReorderedClauses  paren depth + string literals
 *
 * A raw fragment is arbitrary caller text, so a keyword inside a string
 * literal or a comment was read as a clause and the splice landed inside it.
 * The statement stayed VALID, which is what made this the worst of the family:
 *
 *     SELECT *, 'a WHERE id = $1 limit 3 b' as t FROM users
 *     SELECT *, 'a INNER JOIN posts ON … where b' as tag FROM users
 *
 * The first has no WHERE and returns every row. The second never joins. Both
 * run without error, so the assertions here are on ROW COUNTS against the
 * control query — the emitted text alone would not prove the filter applied.
 *
 * All three now share one scanner, so they cannot disagree again.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, raw } from '../src'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { scanTopLevelKeywords } from '../src/sql-fragments'

const MODELS = {
  users: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' } } },
  posts: { columns: { id: { type: 'integer', isPrimaryKey: true }, user_id: { type: 'integer' } } },
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
  dir = mkdtempSync(join(tmpdir(), 'qb-1121-'))
  dbPath = join(dir, 'clause.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
  seed.run(`INSERT INTO users (id,name) VALUES (1,'a'),(2,'b'),(3,'c')`)
  seed.run('CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER)')
  seed.run('INSERT INTO posts (id,user_id) VALUES (10,1)')
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

describe('a keyword inside a string literal is not a clause (#1121)', () => {
  it('the WHERE is not spliced into the literal, and the filter applies', async () => {
    const q = () => qb().selectFrom('users').selectRaw(raw("'a limit 3 b' as t")).where('id', '=', 1)

    expect(String(q().toSQL())).toContain("'a limit 3 b' as t")
    expect(String(q().toSQL())).toContain('WHERE id = ?')

    // The assertion that matters: previously 3 rows came back, not 1.
    expect((await q().execute()).map((r: any) => r.id)).toEqual([1])
  })

  it('the JOIN is not spliced into the literal, and the join happens', async () => {
    const q = () => qb().selectFrom('users').selectRaw(raw("'a where b' as tag"))
      .innerJoin('posts', 'posts.user_id', '=', 'users.id')

    expect(String(q().toSQL())).toContain("'a where b' as tag")

    // Previously 3 unjoined rows; the control joins to exactly one.
    expect((await q().execute()).length).toBe(1)
  })

  it('a genuine trailing clause is still found — the WHERE goes before LIMIT', () => {
    const sql = String(qb().selectFrom('users').where('id', '=', 1).limit(2).toSQL())
    expect(sql).toMatch(/WHERE id = \?.*LIMIT 2/)
  })

  it('a subquery\'s own clauses are still ignored', () => {
    const sql = String(qb().selectFrom('users')
      .selectRaw(raw('(SELECT id FROM posts ORDER BY id LIMIT 1) as first_post'))
      .where('id', '=', 1)
      .toSQL())

    expect(sql).toContain('WHERE id = ?')
    expect(sql).toContain('(SELECT id FROM posts ORDER BY id LIMIT 1)')
  })
})

describe('a keyword inside a comment is not a clause (#1121)', () => {
  it('a block comment does not get cut in half', () => {
    const sql = String(qb().selectFrom('users').orderByRaw(raw('id desc /* where clause */')).limit(5).toSQL())

    // Previously: `SELECT * FROM users where clause */ ORDER BY id desc /* LIMIT 5`
    expect(sql).toBe('SELECT * FROM users ORDER BY id desc /* where clause */ LIMIT 5')
  })

  it('and the statement still runs', async () => {
    const rows = await qb().selectFrom('users').orderByRaw(raw('id desc /* where clause */')).limit(5).execute()
    expect(rows.map((r: any) => r.id)).toEqual([3, 2, 1])
  })
})

describe('the shared scanner itself (#1121)', () => {
  const KW = [{ key: 'where', pattern: /WHERE\b/iy }, { key: 'limit', pattern: /LIMIT\b/iy }]
  const keys = (sql: string): string[] => scanTopLevelKeywords(sql, KW).map(h => h.key)

  it('finds a real clause', () => {
    expect(keys('SELECT * FROM t WHERE id = 1 LIMIT 2')).toEqual(['where', 'limit'])
  })

  it('skips single quotes, double quotes and backticks', () => {
    expect(keys(`SELECT 'where', "where", \`where\` FROM t`)).toEqual([])
  })

  it('a doubled quote is an escaped one, not the end of the literal', () => {
    expect(keys(`SELECT 'it''s where' FROM t`)).toEqual([])
  })

  it('skips line comments to end of line, but not past it', () => {
    expect(keys('SELECT 1 -- where\nFROM t WHERE id = 1')).toEqual(['where'])
  })

  it('skips block comments, including nested ones', () => {
    expect(keys('SELECT 1 /* where /* limit */ where */ FROM t WHERE id = 1')).toEqual(['where'])
  })

  it('skips dollar-quoted strings', () => {
    expect(keys('SELECT $$ where $$ FROM t WHERE id = 1')).toEqual(['where'])
    expect(keys('SELECT $tag$ where $tag$ FROM t WHERE id = 1')).toEqual(['where'])
  })

  it('does not mistake a $1 placeholder for a dollar quote', () => {
    // If $1 opened a quoted run, everything after it would be skipped and the
    // real WHERE would be invisible.
    expect(keys('SELECT $1 FROM t WHERE id = $2 LIMIT 1')).toEqual(['where', 'limit'])
  })

  it('ignores anything inside parentheses', () => {
    expect(keys('SELECT (SELECT 1 FROM x WHERE y LIMIT 1) FROM t')).toEqual([])
  })

  it('requires a non-word character before the keyword', () => {
    expect(keys('SELECT * FROM somewhere')).toEqual([])
  })

  it('never matches at index 0', () => {
    expect(keys('WHERE id = 1')).toEqual([])
  })

  it('an unterminated literal swallows the rest rather than resyncing', () => {
    // The alternative — guessing where the caller meant it to end — is how a
    // splice lands inside caller text in the first place.
    expect(keys(`SELECT 'oops FROM t WHERE id = 1`)).toEqual([])
  })
})
