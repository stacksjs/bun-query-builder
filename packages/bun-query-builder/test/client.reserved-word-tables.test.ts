/**
 * The select builder interpolated its table name raw, so a reserved-word table
 * could not be read. stacksjs/bun-query-builder#1207.
 *
 * Three of the four top-level builders already quoted theirs — `insertInto`,
 * `updateTable` and `deleteFrom` each run the table through a local `quoteId`
 * — and `selectFrom` did not:
 *
 *     DELETE FROM "order" WHERE "id" = ?     works
 *     SELECT * FROM order                    near "order": syntax error
 *
 * which took the select, its WHERE, its ORDER BY and all five aggregates with
 * it, since they share that one `FROM`. The JOIN family had it twice over: the
 * joined table and both halves of the ON clause.
 *
 * `user` is the name that makes this matter rather than amuse: Postgres
 * reserves it, SQLite does not, so `selectFrom('user')` works here and fails
 * there. The quoting follows the word list, not one dialect's tolerance, which
 * is why `user` is quoted below even though SQLite would have accepted it bare.
 *
 * The control cases are half the point. On SQLite and Postgres an ordinary
 * table must stay unquoted, because a quoted identifier is case-sensitive on
 * Postgres and `"Users"` would stop matching the `users` the server stored.
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
  // `order` and `group` are reserved everywhere; `user` only on Postgres.
  order: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      total: { type: 'integer' },
      user_id: { type: 'integer' },
    },
  },
  user: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      name: { type: 'string' },
    },
  },
  plain_rows: {
    columns: {
      id: { type: 'integer', isPrimaryKey: true },
      label: { type: 'string' },
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

function rows(table: string): any[] {
  const probe = new Database(dbPath)
  const out = probe.query(`SELECT * FROM "${table}" ORDER BY id`).all() as any[]
  probe.close()
  return out
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1207-'))
  dbPath = join(dir, 'rw.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE "order" (id INTEGER PRIMARY KEY, total INTEGER, user_id INTEGER)')
  seed.run('CREATE TABLE "user" (id INTEGER PRIMARY KEY, name TEXT)')
  seed.run('CREATE TABLE plain_rows (id INTEGER PRIMARY KEY, label TEXT)')
  seed.run(`INSERT INTO "user" (id,name) VALUES (1,'ann'),(2,'bob')`)
  seed.run(`INSERT INTO "order" (id,total,user_id) VALUES (1,10,1),(2,20,1),(3,30,2)`)
  seed.run(`INSERT INTO plain_rows (id,label) VALUES (1,'x')`)
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

describe('selectFrom on a reserved-word table (#1207)', () => {
  it('quotes the table in the text it builds', () => {
    expect(String(qb().selectFrom('order').toSQL())).toBe('SELECT * FROM "order"')
  })

  it('executes a plain select', async () => {
    // Was `SELECT * FROM order` — `near "order": syntax error`.
    expect((await qb().selectFrom('order').execute()).length).toBe(3)
  })

  it('executes with where and orderBy', async () => {
    expect((await qb().selectFrom('order').where({ id: 2 }).execute()).length).toBe(1)
    const ordered = await qb().selectFrom('order').orderBy('total', 'desc').execute()
    expect(ordered.map((r: any) => r.total)).toEqual([30, 20, 10])
  })

  it('executes the aggregates, which share that FROM', async () => {
    expect(await qb().selectFrom('order').count()).toBe(3)
    expect(await qb().selectFrom('order').sum('total')).toBe(60)
    expect(await qb().selectFrom('order').max('total')).toBe(30)
    expect(await qb().selectFrom('order').min('total')).toBe(10)
    expect(await qb().selectFrom('order').avg('total')).toBe(20)
  })

  it('quotes a table SQLite tolerates but Postgres reserves', async () => {
    // SQLite accepts a bare `user`, so this one passed before the fix and the
    // same code failed on Postgres. The word list decides, not the dialect.
    expect(String(qb().selectFrom('user').toSQL())).toBe('SELECT * FROM "user"')
    expect((await qb().selectFrom('user').execute()).length).toBe(2)
  })
})

describe('joins across reserved-word tables (#1207)', () => {
  it('quotes the joined table and both halves of the ON clause', () => {
    const sql = String(qb().selectFrom('order').innerJoin('user', 'order.user_id', '=', 'user.id').toSQL())
    expect(sql).toBe('SELECT * FROM "order" INNER JOIN "user" ON "order".user_id = "user".id')
  })

  it('executes an inner join', async () => {
    const got = await qb().selectFrom('order').innerJoin('user', 'order.user_id', '=', 'user.id').execute()
    expect(got.length).toBe(3)
  })

  it('executes a left join', async () => {
    const got = await qb().selectFrom('order').leftJoin('user', 'order.user_id', '=', 'user.id').execute()
    expect(got.length).toBe(3)
  })

  it('quotes an aliased joined table and leaves the alias bare', () => {
    const sql = String(qb().selectFrom('order').innerJoin('user as u', 'order.user_id', '=', 'u.id').toSQL())
    expect(sql).toContain('INNER JOIN "user" AS u')
    // The alias is the caller's own name for the table, not an identifier the
    // server holds, so it is not a reserved-word risk and stays as written.
    expect(sql).toContain('ON "order".user_id = u.id')
  })

  it('still rejects a non-identifier in the ON clause', () => {
    // joinOnRef validates before it quotes; quoting must not become a way in.
    expect(() => qb().selectFrom('order').innerJoin('user', 'order.user_id); DROP TABLE x --', '=', 'user.id'))
      .toThrow(/identifier/)
  })
})

describe('the bulk helpers on a reserved-word table (#1207)', () => {
  // `createMany` was quoted by #1033 and its three siblings were left behind,
  // so the fix landing on one of four is the recurring shape of this bug.
  it('createMany already quoted and still does', async () => {
    await qb().createMany('order', [{ id: 4, total: 40, user_id: 1 }])
    expect(rows('order').map(r => r.id)).toEqual([1, 2, 3, 4])
  })

  it('insertMany quotes the table and the column list', async () => {
    await qb().insertMany('order', [{ id: 5, total: 50, user_id: 1 }, { id: 6, total: 60, user_id: 2 }])
    expect(rows('order').map(r => r.id)).toEqual([1, 2, 3, 5, 6])
  })

  it('updateMany quotes the table, the SET list and the WHERE keys', async () => {
    await qb().updateMany('order', { user_id: 1 }, { total: 77 })
    expect(rows('order').map(r => r.total)).toEqual([77, 77, 30])
  })

  it('deleteMany quotes the table and the key column', async () => {
    await qb().deleteMany('order', [2, 3])
    expect(rows('order').map(r => r.id)).toEqual([1])
  })
})

describe('the write builders are unchanged (#1207)', () => {
  it('insertInto, updateTable and deleteFrom already quoted and still do', async () => {
    await qb().insertInto('order').values({ id: 9, total: 99, user_id: 1 }).execute()
    expect(rows('order').map(r => r.id)).toEqual([1, 2, 3, 9])

    await qb().updateTable('order').set({ total: 98 }).where({ id: 9 }).execute()
    expect(rows('order').find(r => r.id === 9).total).toBe(98)

    await qb().deleteFrom('order').where({ id: 9 }).execute()
    expect(rows('order').map(r => r.id)).toEqual([1, 2, 3])
  })
})

describe('an ordinary table keeps its unquoted spelling (#1207)', () => {
  it('stays bare on SQLite', async () => {
    expect(String(qb().selectFrom('plain_rows').toSQL())).toBe('SELECT * FROM plain_rows')
    expect((await qb().selectFrom('plain_rows').execute()).length).toBe(1)
  })

  it('stays bare on Postgres, where quoting would make it case-sensitive', () => {
    setConfig({ dialect: 'postgres' } as any)
    const sql = String(qb().selectFrom('plain_rows').toSQL())
    expect(sql).toContain('FROM plain_rows')
    expect(sql).not.toContain('"plain_rows"')
  })

  it('is back-quoted on MySQL, where identifiers are case-insensitive', () => {
    setConfig({ dialect: 'mysql' } as any)
    expect(String(qb().selectFrom('plain_rows').toSQL())).toContain('FROM `plain_rows`')
  })
})
