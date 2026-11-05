/**
 * A model may name a column `order`, `group` or `when`, and the ORM quotes such
 * names everywhere a reference reaches SQL — `quoteSqlColumn` exists for
 * exactly that, and WHERE, ORDER BY, SELECT and the SET lists all route through
 * `quotedColumn`.
 *
 * Four call sites did not, and each interpolated the bare name:
 *
 *   - `createTableFromModel`  -> `CREATE TABLE t (order INTEGER, ...)`
 *   - `pluck()`               -> `SELECT order FROM t`
 *   - `avg/sum/max/min()`     -> `SELECT MAX(order) as v FROM t`
 *   - `increment/decrement()` -> `UPDATE t SET order = order + ?`
 *
 * all of which are `near "order": syntax error`. The table helper failing is
 * what makes this worth its own file: the feature was unusable end to end, so
 * the quoting the other paths do had nothing to act on. The migration drivers
 * quoted correctly the whole time (see `SQLiteDriver.createTable`), so only a
 * schema built through the ORM's own helper was affected.
 *
 * The control cases matter as much as the failures: `quoteSqlColumn` must leave
 * an ordinary name bare on SQLite and Postgres, because quoting a column there
 * makes it case-sensitive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

// `order`, `group` and `when` are all in ANSI_RESERVED_WORDS.
const Task = createModel({
  name: 'ResTask',
  table: 'res_tasks',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    order: { type: 'integer', fillable: true },
    group: { type: 'integer', fillable: true },
    when: { type: 'string', fillable: true },
    // A plain name, and one declared camelCase so the snake_case mapping is
    // still exercised alongside the quoting.
    label: { type: 'string', fillable: true },
    sortWeight: { type: 'integer', fillable: true },
  },
} as const)

const T = Task as any

describe('reserved-word columns through the ORM', () => {
  beforeEach(async () => {
    configureOrm({ database: ':memory:' })
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS res_tasks')
    await createTableFromModel(Task.getDefinition())
    await T.create({ order: 3, group: 1, when: 'mon', label: 'a', sortWeight: 10 })
    await T.create({ order: 7, group: 1, when: 'tue', label: 'b', sortWeight: 20 })
    await T.create({ order: 5, group: 2, when: 'wed', label: 'c', sortWeight: 30 })
  })

  afterEach(() => getDatabase().close())

  it('createTableFromModel creates the table at all', async () => {
    // The beforeEach already ran it; assert the columns landed under their own
    // names rather than that it merely did not throw.
    const cols = getDatabase().query('PRAGMA table_info(res_tasks)').all() as { name: string }[]
    const names = cols.map(c => c.name)
    expect(names).toContain('order')
    expect(names).toContain('group')
    expect(names).toContain('when')
    // Declared `sortWeight`, created `sort_weight` — the snake_case mapping is
    // unchanged by the quoting.
    expect(names).toContain('sort_weight')
  })

  it('round-trips a write and a read on a reserved column', async () => {
    const rows = await T.query().where('order', 7).get()
    expect(rows.length).toBe(1)
    expect(rows[0].get('when')).toBe('tue')
  })

  it('pluck reads a reserved column', async () => {
    // The statement needs `"order"`; the result key is `order`. Getting only
    // one of the two right returns [undefined, undefined, undefined].
    expect(await T.query().orderBy('order', 'asc').pluck('order')).toEqual([3, 5, 7])
    expect(await T.query().orderBy('order', 'asc').pluck('when')).toEqual(['mon', 'wed', 'tue'])
  })

  it('pluck still reads a plain and a camelCase column', async () => {
    expect(await T.query().orderBy('order', 'asc').pluck('label')).toEqual(['a', 'c', 'b'])
    expect(await T.query().orderBy('order', 'asc').pluck('sortWeight')).toEqual([10, 30, 20])
  })

  it('the aggregates accept a reserved column', async () => {
    expect(await T.query().max('order')).toBe(7)
    expect(await T.query().min('order')).toBe(3)
    expect(await T.query().sum('order')).toBe(15)
    expect(await T.query().avg('order')).toBe(5)
    expect(await T.query().max('group')).toBe(2)
  })

  it('the aggregates still accept a plain and a camelCase column', async () => {
    expect(await T.query().max('id')).toBe(3)
    expect(await T.query().sum('sortWeight')).toBe(60)
  })

  it('increment and decrement move a reserved column', async () => {
    expect(await T.query().where('id', 1).increment('order', 4)).toBe(1)
    expect(await T.query().where('id', 1).pluck('order')).toEqual([7])

    expect(await T.query().where('id', 1).decrement('order', 2)).toBe(1)
    expect(await T.query().where('id', 1).pluck('order')).toEqual([5])
  })

  it('increment leaves the other columns alone', async () => {
    // `SET order = order + ?` with the wrong name quoted would be a syntax
    // error, but a name quoted into the wrong slot would silently bump
    // something else. Pin the neighbours.
    await T.query().where('id', 1).increment('group', 5)
    const row = await T.query().where('id', 1).first()
    expect(row.get('group')).toBe(6)
    expect(row.get('order')).toBe(3)
    expect(row.get('when')).toBe('mon')
  })

  it('a scoped increment still honours the WHERE', async () => {
    await T.query().where('group', 1).increment('order', 100)
    expect(await T.query().orderBy('id', 'asc').pluck('order')).toEqual([103, 107, 5])
  })

  it('leaves an ordinary column unquoted in the statement it builds', () => {
    // Not cosmetic: a quoted mixed-case identifier is case-sensitive on
    // Postgres, so quoting everything would break models whose columns were
    // created lower-case. Only the reserved words get quotes.
    const { sql } = T.query().where('label', 'a').orderBy('sortWeight', 'asc').toSql()
    expect(sql).toContain('label = ?')
    expect(sql).toContain('sort_weight ASC')
    expect(sql).not.toContain('"label"')
    expect(sql).not.toContain('"sort_weight"')
  })

  it('quotes the reserved ones in the statement it builds', () => {
    const { sql } = T.query().where('order', 1).orderBy('when', 'desc').toSql()
    expect(sql).toContain('"order" = ?')
    expect(sql).toContain('"when" DESC')
  })
})
