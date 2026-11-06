/**
 * Table names were interpolated bare into every statement the ORM builds, so a
 * model backed by a reserved-word table could not be read or written at all.
 * stacksjs/bun-query-builder#1207.
 *
 * The two halves of the library disagreed. The migration drivers have quoted
 * table names all along:
 *
 *     CREATE TABLE IF NOT EXISTS "order" ( "id" INTEGER PRIMARY KEY ... );
 *
 * and the ORM then addressed that table as `SELECT * FROM order`, which is
 * `near "order": syntax error`. So the generator reported a successful migration
 * for a table nothing could subsequently touch.
 *
 * `user` is the name that makes this more than a curiosity: Postgres reserves
 * it, SQLite does not, and `table: 'user'` is an ordinary thing to write. The
 * fix is driven by the word list rather than by what one dialect tolerates.
 *
 * Column references on the belongsToMany pivot had the same gap and are covered
 * here too, because they share the statements the table fix had to touch —
 * `pivot.column` is one interpolation with two halves, and quoting one of them
 * is not a fix.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel, defineModel, getDatabase } from '../src'
import { config } from '../src/config'

const Order = createModel({
  name: 'ResOrder',
  table: 'order', // reserved on SQLite, Postgres and MySQL
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    total: { type: 'integer', fillable: true },
    note: { type: 'string', fillable: true },
  },
} as const)

const O = Order as any
let dialect: string

describe('a model backed by a reserved-word table', () => {
  beforeEach(async () => {
    dialect = config.dialect
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:', { create: true }) })
    // The helper itself used to fail here: `near "order": syntax error`.
    await createTableFromModel(Order.getDefinition())
    await O.create({ total: 10, note: 'a' })
    await O.create({ total: 20, note: 'b' })
    await O.create({ total: 30, note: 'c' })
  })

  afterEach(() => {
    config.dialect = dialect as any
    getDatabase().close()
  })

  it('creates the table', () => {
    const rows = getDatabase().query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    expect(rows.map(r => r.name)).toContain('order')
  })

  it('reads through get, count, find and first', async () => {
    expect((await O.query().get()).length).toBe(3)
    expect(await O.query().count()).toBe(3)
    expect(await O.query().where('total', 20).count()).toBe(1)
    expect((await O.find(2)).get('note')).toBe('b')
    expect((await O.query().orderBy('total', 'desc').first()).get('total')).toBe(30)
  })

  it('reads through pluck and the aggregates', async () => {
    expect(await O.query().orderBy('total', 'asc').pluck('total')).toEqual([10, 20, 30])
    expect(await O.query().max('total')).toBe(30)
    expect(await O.query().sum('total')).toBe(60)
  })

  it('writes through create, update, increment and delete', async () => {
    expect(await O.query().where('id', 1).update({ note: 'z' })).toBe(1)
    expect((await O.find(1)).get('note')).toBe('z')

    expect(await O.query().where('id', 1).increment('total', 5)).toBe(1)
    expect((await O.find(1)).get('total')).toBe(15)

    expect(await O.query().where('id', 3).delete()).toBe(1)
    expect(await O.query().count()).toBe(2)
  })

  it('writes through the instance save and delete paths', async () => {
    const row = await O.find(2)
    row.set('note', 'saved')
    await row.save()
    expect((await O.find(2)).get('note')).toBe('saved')

    await (await O.find(2)).delete()
    expect(await O.find(2)).toBeUndefined()
  })

  it('refreshes an instance', async () => {
    const row = await O.find(1)
    await O.query().where('id', 1).update({ note: 'elsewhere' })
    expect((await row.refresh()).get('note')).toBe('elsewhere')
  })

  it('truncates', async () => {
    await O.truncate()
    expect(await O.query().count()).toBe(0)
  })

  it('quotes the table in the statement it builds', () => {
    expect(O.query().where('total', 1).toSql().sql).toContain('FROM "order"')
  })
})

describe('an ordinary table is left alone', () => {
  const Plain = createModel({
    name: 'ResPlain',
    table: 'plain_rows',
    primaryKey: 'id',
    autoIncrement: true,
    attributes: { label: { type: 'string', fillable: true } },
  } as const)
  const P = Plain as any

  beforeEach(async () => {
    dialect = config.dialect
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:', { create: true }) })
    await createTableFromModel(Plain.getDefinition())
    await P.create({ label: 'x' })
  })

  afterEach(() => {
    config.dialect = dialect as any
    getDatabase().close()
  })

  it('stays unquoted on SQLite and Postgres', () => {
    for (const name of ['sqlite', 'postgres']) {
      config.dialect = name as any
      const { sql } = P.query().where('label', 'x').toSql()
      // Quoting an ordinary identifier on these dialects makes it
      // case-sensitive, so the narrowness is the point, not an oversight.
      expect(sql).toContain('FROM plain_rows')
      expect(sql).not.toContain('"plain_rows"')
    }
  })

  it('is back-quoted on MySQL, where that is free', () => {
    config.dialect = 'mysql' as any
    expect(P.query().toSql().sql).toContain('FROM `plain_rows`')
  })

  it('still reads and writes', async () => {
    expect(await P.query().count()).toBe(1)
    expect(await P.query().pluck('label')).toEqual(['x'])
  })
})

describe('a reserved pivot table and pivot column', () => {
  let Group: any
  let Member: any

  beforeEach(() => {
    dialect = config.dialect
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:', { create: true }) })

    Member = defineModel({
      name: 'PivMember',
      table: 'members',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true } },
    } as const)

    // `group` as the pivot table, `order` as a pivot column — both reserved.
    Group = defineModel({
      name: 'PivGroup',
      table: 'groups',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true } },
      belongsToMany: {
        members: {
          model: 'PivMember',
          table: 'group',
          foreignKey: 'group_id',
          relatedKey: 'member_id',
          pivot: { columns: { order: { default: 0 } } },
        },
      },
    } as const)

    const db = getDatabase()
    db.run('CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE "group" (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER, member_id INTEGER, "order" INTEGER DEFAULT 0)')
  })

  afterEach(() => {
    config.dialect = dialect as any
    getDatabase().close()
  })

  async function seeded() {
    const g = await Group.create({ name: 'g1' })
    const m1 = await Member.create({ name: 'ann' })
    const m2 = await Member.create({ name: 'bob' })
    await g.members().attach(m1.get('id'), { order: 2 })
    await g.members().attach(m2.get('id'), { order: 1 })
    return { g, m1, m2 }
  }

  it('attaches and reads back across the pivot', async () => {
    const { g } = await seeded()
    expect(await g.members().count()).toBe(2)
    const names = (await g.members().get()).map((r: any) => r.get('name')).sort()
    expect(names).toEqual(['ann', 'bob'])
  })

  it('filters on a reserved pivot column', async () => {
    const { g } = await seeded()
    const rows = await g.members().wherePivot('order', 1).get()
    expect(rows.map((r: any) => r.get('name'))).toEqual(['bob'])
  })

  it('orders by a reserved pivot column', async () => {
    const { g } = await seeded()
    const rows = await g.members().orderBy('group.order', 'asc').get()
    expect(rows.map((r: any) => r.get('name'))).toEqual(['bob', 'ann'])
  })

  it('updates an existing pivot row', async () => {
    const { g, m1 } = await seeded()
    expect(await g.members().updateExistingPivot(m1.get('id'), { order: 9 })).toBe(1)
    expect((await g.members().wherePivot('order', 9).get()).length).toBe(1)
  })

  it('detaches', async () => {
    const { g, m1 } = await seeded()
    expect(await g.members().detach(m1.get('id'))).toBe(1)
    expect(await g.members().count()).toBe(1)
  })
})
