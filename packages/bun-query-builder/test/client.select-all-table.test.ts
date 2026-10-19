/**
 * `selectAll(table)` selects that table's columns, and a later `select([...])`
 * adds to them (Kysely semantics).
 *
 * `selectAll()` used to ignore its argument, so
 *
 *     db.selectFrom('orders').innerJoin('invoices', ...).selectAll('orders')
 *
 * still compiled to `SELECT * FROM orders INNER JOIN invoices ...` and the
 * joined table's `id` overwrote the order's. A `select([...])` after it then
 * rebuilt the whole list, so only the newly selected columns came back.
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
  orders: { columns: { id: { type: 'integer', isPrimaryKey: true }, total: { type: 'integer' } } },
  invoices: { columns: { id: { type: 'integer', isPrimaryKey: true }, order_id: { type: 'integer' }, number: { type: 'string' } } },
} as any

function qb(): any {
  return createQueryBuilder({
    schema: buildDatabaseSchema(MODELS),
    meta: buildSchemaMeta(MODELS),
    autoMigration: { enabled: false } as any,
  })
}

const joined = () => qb()
  .selectFrom('orders')
  .innerJoin('invoices', 'invoices.order_id', '=', 'orders.id')

describe('selectAll(table) compiles to table.*', () => {
  it('selectAll() with no argument is unchanged', () => {
    expect(String(qb().selectFrom('orders').selectAll().toSQL())).toBe('SELECT * FROM orders')
    expect(String(joined().selectAll().toSQL()))
      .toBe('SELECT * FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
  })

  it('selectAll(\'t\') with a join selects only t.*', () => {
    expect(String(joined().selectAll('orders').toSQL()))
      .toBe('SELECT orders.* FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
  })

  it('accepts an array of tables', () => {
    expect(String(joined().selectAll(['orders', 'invoices']).toSQL()))
      .toBe('SELECT orders.*, invoices.* FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
  })

  it('selectAll(\'t\').select([...]) keeps t.* and adds the columns', () => {
    expect(String(joined().selectAll('orders').select(['invoices.number as number']).toSQL()))
      .toBe('SELECT orders.*, invoices.number as number FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
    expect(String(joined().selectAll('orders').select('invoices.number as number').toSQL()))
      .toBe('SELECT orders.*, invoices.number as number FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
  })

  it('keeps a DISTINCT / DISTINCT ON prefix', () => {
    expect(String(qb().selectFrom('orders').distinct().selectAll('orders').toSQL()))
      .toBe('SELECT DISTINCT orders.* FROM orders')
    expect(String(qb().selectFrom('orders').distinctOn('total').selectAll('orders').select(['orders.id as oid']).toSQL()))
      .toBe('SELECT DISTINCT ON (total) orders.*, orders.id as oid FROM orders')
  })

  it('refuses an unsafe table name', () => {
    expect(() => qb().selectFrom('orders').selectAll('orders; drop table orders')).toThrow(/Invalid identifier/)
  })
})

describe('select() without selectAll(table) is unchanged', () => {
  it('replaces the implicit *', () => {
    expect(String(joined().select(['orders.id', 'invoices.number']).toSQL()))
      .toBe('SELECT orders.id, invoices.number FROM orders INNER JOIN invoices ON invoices.order_id = orders.id')
  })

  it('a second select still replaces the first', () => {
    expect(String(qb().selectFrom('orders').select(['id']).select(['total']).toSQL()))
      .toBe('SELECT total FROM orders')
  })

  it('keeps DISTINCT', () => {
    expect(String(qb().selectFrom('orders').distinct().select(['total']).toSQL()))
      .toBe('SELECT DISTINCT total FROM orders')
  })
})

describe('selectAll(table) rows', () => {
  let dir: string
  let snapshot: { dialect: string, database: Record<string, unknown> }

  beforeEach(() => {
    snapshot = { dialect: config.dialect, database: { ...config.database } }
    dir = mkdtempSync(join(tmpdir(), 'qb-select-all-'))
    const dbPath = join(dir, 'sel.sqlite')
    const seed = new Database(dbPath, { create: true })
    seed.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER)')
    seed.run('CREATE TABLE invoices (id INTEGER PRIMARY KEY, order_id INTEGER, number TEXT)')
    seed.run('INSERT INTO orders (id, total) VALUES (1, 100), (2, 250)')
    seed.run(`INSERT INTO invoices (id, order_id, number) VALUES (40, 1, 'INV-40'), (41, 2, 'INV-41')`)
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

  it('the main table\'s id is not overwritten by the joined table\'s', async () => {
    const rows = await joined()
      .selectAll('orders')
      .select(['invoices.number as number'])
      .orderBy('orders.id', 'asc')
      .get()
    expect(rows).toEqual([
      { id: 1, total: 100, number: 'INV-40' },
      { id: 2, total: 250, number: 'INV-41' },
    ])
  })
})
