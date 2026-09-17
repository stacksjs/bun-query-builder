/**
 * `Model.query().whereRaw(sql, [value])` — stacksjs/bun-query-builder#1146.
 *
 * `whereRaw`/`orWhereRaw` were declared `(fragment, ...params)` and stored the
 * rest array as-is, so the Knex/Laravel array form the docs taught stored
 * `rawParams = [[value]]`. `buildWhereClauses` spreads one level, which left the
 * array as ONE binding, and bun:sqlite read that three ways:
 *
 *  - a read whose only binding it was: `.all([value])` takes a lone array as
 *    the whole bindings list, so it worked by accident;
 *  - a read with any other binding: `expected 2 values, received 1` when the
 *    array came first, `Binding expected string, …` when it did not;
 *  - every write: `SqliteExecutor.run` passes params unspread, so `delete()`,
 *    `update()` and `increment()` threw even with a single binding.
 *
 * It passed every check that used no second filter and returned 500 in
 * production once a country filter added one. The empty array was worse than a
 * throw: `whereRaw('1 = 1', []).where('country', 'US')` bound nothing to
 * `country = ?`, which SQLite reads as NULL, and returned no rows.
 *
 * Most assertions execute, because `toSql()` printed `[["ada"]]` throughout and
 * nobody read it as wrong. The SQL text was always right; only the bindings
 * were not.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel } from '../src'

let db: Database
let User: any

const LOWER_NAME = 'LOWER(name) = ?'

const ids = (rows: any[]): number[] => rows.map(r => Number(r.id ?? r.get?.('id'))).sort((a, b) => a - b)
const remaining = (): number[] =>
  (db.query('SELECT id FROM wrb_users ORDER BY id').all() as { id: number }[]).map(r => r.id)
const scoreOf = (id: number): number =>
  (db.query('SELECT score FROM wrb_users WHERE id = ?').get(id) as { score: number }).score

beforeEach(() => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  db.run(`CREATE TABLE wrb_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0
  )`)
  db.run(`INSERT INTO wrb_users (id, name, country) VALUES (1, 'Ada', 'US'), (2, 'ada', 'UK'), (3, 'Grace', 'US')`)
  configureOrm({ database: db })
  User = createModel({
    name: 'WrbUser',
    table: 'wrb_users',
    primaryKey: 'id',
    attributes: {
      name: { type: 'string', fillable: true },
      country: { type: 'string', fillable: true },
      score: { type: 'number', fillable: true },
    },
  } as any)
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

describe('whereRaw bindings passed as one array (#1146)', () => {
  it('builds the same flat bindings as separate arguments', () => {
    const asArray = User.query().whereRaw(LOWER_NAME, ['ada']).where('country', 'US').toSql()
    const asArgs = User.query().whereRaw(LOWER_NAME, 'ada').where('country', 'US').toSql()

    // Was `[["ada"],"US"]`.
    expect(asArray.params).toEqual(['ada', 'US'])
    expect(asArray).toEqual(asArgs)

    const multi = User.query().whereRaw('LOWER(name) = ? AND country = ?', ['ada', 'UK']).toSql()
    expect(multi.params).toEqual(['ada', 'UK'])
  })

  it('reads with no other binding (the case that worked by accident)', async () => {
    expect(ids(await User.query().whereRaw(LOWER_NAME, ['ada']).get())).toEqual([1, 2])
  })

  it('reads when another clause binds after it', async () => {
    // Threw `SQLite query expected 2 values, received 1`.
    expect(ids(await User.query().whereRaw(LOWER_NAME, ['ada']).where('country', 'US').get())).toEqual([1])
  })

  it('reads when another clause binds before it', async () => {
    // Threw `TypeError: Binding expected string, TypedArray, …`.
    expect(ids(await User.query().where('country', 'US').whereRaw(LOWER_NAME, ['ada']).get())).toEqual([1])
  })

  it('works on the aggregate and paging terminals', async () => {
    const q = () => User.query().where('country', 'US').whereRaw(LOWER_NAME, ['ada'])
    expect(await q().count()).toBe(1)
    expect(await q().exists()).toBe(true)
    expect(await q().pluck('name')).toEqual(['Ada'])
    const page = await q().paginate(1, 10)
    expect(page.data.length).toBe(1)
  })

  it('orWhereRaw takes the array form too', async () => {
    const rows = await User.query().where('country', 'UK').orWhereRaw(LOWER_NAME, ['grace']).get()
    expect(ids(rows)).toEqual([2, 3])
  })

  it('carries through whereGroup into the outer query', async () => {
    const rows = await User.query()
      .whereGroup((b: any) => b.whereRaw(LOWER_NAME, ['ada']))
      .where('country', 'US')
      .get()
    expect(ids(rows)).toEqual([1])
  })

  it('binds several values from one array', async () => {
    const rows = await User.query().whereRaw('LOWER(name) = ? AND country = ?', ['ada', 'UK']).where('id', 2).get()
    // Threw `expected 3 values, received 2`.
    expect(ids(rows)).toEqual([2])
  })
})

describe('whereRaw array bindings on writes (#1146)', () => {
  it('delete() with the array as the only binding', async () => {
    // Threw `Binding expected …` and deleted nothing.
    expect(await User.query().whereRaw(LOWER_NAME, ['grace']).delete()).toBe(1)
    expect(remaining()).toEqual([1, 2])
  })

  it('delete() with another binding', async () => {
    expect(await User.query().where('country', 'UK').whereRaw(LOWER_NAME, ['ada']).delete()).toBe(1)
    expect(remaining()).toEqual([1, 3])
  })

  it('update() puts its SET values ahead of the raw bindings', async () => {
    expect(await User.query().whereRaw(LOWER_NAME, ['ada']).where('country', 'UK').update({ country: 'CA' })).toBe(1)
    const row = db.query('SELECT country FROM wrb_users WHERE id = 2').get() as { country: string }
    expect(row.country).toBe('CA')
  })

  it('increment() and decrement()', async () => {
    await User.query().whereRaw(LOWER_NAME, ['grace']).increment('score', 5)
    await User.query().where('country', 'US').whereRaw(LOWER_NAME, ['ada']).decrement('score', 2)
    expect(scoreOf(3)).toBe(5)
    expect(scoreOf(1)).toBe(-2)
    expect(scoreOf(2)).toBe(0)
  })
})

describe('whereRaw with an empty bindings array (#1146)', () => {
  it('reads return the rows the other clauses select', async () => {
    // Returned [] silently: `country = ?` was bound to nothing, i.e. NULL.
    expect(ids(await User.query().whereRaw('1 = 1', []).where('country', 'US').get())).toEqual([1, 3])
    expect(await User.query().whereRaw('1 = 1', []).where('country', 'US').count()).toBe(2)
  })

  it('writes run', async () => {
    // Threw `expected 0 values, received 1`.
    expect(await User.query().whereRaw('id = 3', []).delete()).toBe(1)
    expect(remaining()).toEqual([1, 2])
  })
})

describe('whereRaw array values inside the bindings (#1146)', () => {
  // Postgres binds an array to a json/jsonb parameter as JSON, so an array
  // meant as ONE value has to survive: wrapped in the bindings array, or passed
  // among separate arguments. orm.where-raw-bindings.pg.test.ts executes these.
  it('a wrapped array stays one binding', () => {
    expect(User.query().whereRaw('tags @> ?', [['bun']]).toSql().params).toEqual([['bun']])
    expect(User.query().whereRaw('country = ? AND tags @> ?', ['US', ['bun']]).toSql().params).toEqual(['US', ['bun']])
  })

  it('an array among separate arguments is unchanged', () => {
    expect(User.query().whereRaw('country = ? AND tags @> ?', 'US', ['bun']).toSql().params).toEqual(['US', ['bun']])
    // Only a LONE array is the bindings list, not one that merely comes first.
    expect(User.query().whereRaw('tags @> ? AND country = ?', ['bun'], 'US').toSql().params).toEqual([['bun'], 'US'])
  })

  it('does not treat a typed array as a bindings list', async () => {
    const blob = new Uint8Array([65, 100, 97]) // 'Ada'
    expect(ids(await User.query().whereRaw('CAST(name AS BLOB) = ?', blob).get())).toEqual([1])
    expect(ids(await User.query().whereRaw('CAST(name AS BLOB) = ?', [blob]).get())).toEqual([1])
  })
})

describe('whereRaw bindings are captured at the call (#1146)', () => {
  it('mutating the array afterwards does not change the query', async () => {
    const bindings = ['grace']
    const q = User.query().whereRaw(LOWER_NAME, bindings)
    bindings[0] = 'ada'
    bindings.push('extra')
    expect(q.toSql().params).toEqual(['grace'])
    expect(ids(await q.get())).toEqual([3])
  })

  it('binds the values of a frozen array', async () => {
    // Before the fix this array reached bun:sqlite whole, as `.all(frozen)`,
    // which segfaults Bun 1.3.14. Its values are now spread into the bindings.
    const rows = await User.query().whereRaw(LOWER_NAME, Object.freeze(['ada'])).get()
    expect(ids(rows)).toEqual([1, 2])
  })

  it('a fragment with no bindings is unchanged', async () => {
    expect(User.query().whereRaw('id = 3').toSql().params).toEqual([])
    expect(await User.query().whereRaw('id = 3').delete()).toBe(1)
  })
})

describe('whereRaw forwarded an undefined bindings argument (#1146)', () => {
  // What `(sql, bindings?) => q.whereRaw(sql, bindings)` passes when called
  // without bindings. It was bound as a value, which failed exactly like the
  // array form: fine alone, a mismatch beside another binding, a throw on writes.
  const forward = (sql: string, bindings?: unknown[]) => User.query().whereRaw(sql, bindings)

  it('is no bindings when the fragment has no placeholder', async () => {
    expect(forward('1 = 1').where('country', 'US').toSql().params).toEqual(['US'])
    expect(ids(await forward('1 = 1').where('country', 'US').get())).toEqual([1, 3])
    expect(await forward('id = 3').delete()).toBe(1)
    expect(User.query().where('id', 1).orWhereRaw('id = 2', undefined).toSql().params).toEqual([1])
  })

  it('stays a NULL binding when the fragment has one', async () => {
    const q = User.query().whereRaw('? IS NULL', undefined).where('country', 'UK')
    expect(q.toSql().params).toEqual([undefined, 'UK'])
    expect(ids(await q.get())).toEqual([2])
  })
})
