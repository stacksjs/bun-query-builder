/**
 * `where(column, 'in', [...])` type inference.
 *
 * The three-argument `where` overload typed its value as the column's own
 * type for every operator, so the one operator that takes a LIST was rejected:
 * `Order.where('id', 'in', ids)` failed with "Argument of type 'number[]' is
 * not assignable to parameter of type 'number'", while the runtime handled it
 * perfectly well - `whereIn` is itself implemented as `where(column, 'in',
 * values)`.
 *
 * The compile-time half of this file is the real test: it would not build if
 * the overload were missing. The runtime half checks that the rows come back
 * the way the types promise.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, getDatabase } from '../src/orm'

const Order = createModel({
  name: 'Order',
  table: 'test_where_in_orders',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    reference: { type: 'string', fillable: true },
    total: { type: 'number', fillable: true },
    status: { type: ['open', 'paid', 'void'] as const, fillable: true },
  },
} as const)

describe('where(column, in, values)', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
    const db = getDatabase()
    db.run(`
      CREATE TABLE test_where_in_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT,
        total REAL,
        status TEXT
      )
    `)
    db.run(`INSERT INTO test_where_in_orders (reference, total, status) VALUES (?, ?, ?)`, ['A-1', 10, 'open'])
    db.run(`INSERT INTO test_where_in_orders (reference, total, status) VALUES (?, ?, ?)`, ['A-2', 20, 'paid'])
    db.run(`INSERT INTO test_where_in_orders (reference, total, status) VALUES (?, ?, ?)`, ['A-3', 30, 'void'])
  })

  afterAll(() => {
    getDatabase().run('DROP TABLE IF EXISTS test_where_in_orders')
  })

  it('accepts a list of numbers for a numeric column', async () => {
    const ids: number[] = [1, 2]
    const rows = await Order.where('id', 'in', ids).get()

    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.get('reference')).sort()).toEqual(['A-1', 'A-2'])
  })

  it('accepts a list of strings for a string column', async () => {
    const refs: string[] = ['A-1', 'A-3']
    const rows = await Order.where('reference', 'in', refs).get()

    expect(rows.map(r => r.get('reference')).sort()).toEqual(['A-1', 'A-3'])
  })

  it('accepts a readonly list, which is what `as const` produces', async () => {
    const statuses = ['open', 'paid'] as const
    const rows = await Order.where('status', 'in', statuses).get()

    expect(rows).toHaveLength(2)
  })

  it('supports not in', async () => {
    const rows = await Order.where('status', 'not in', ['void']).get()

    expect(rows.map(r => r.get('status')).sort()).toEqual(['open', 'paid'])
  })

  it('chains, which is the thing whereIn cannot do', async () => {
    const rows = await Order
      .where('id', 'in', [1, 2, 3])
      .where('total', '>', 15)
      .orderBy('total', 'desc')
      .get()

    expect(rows.map(r => r.get('total'))).toEqual([30, 20])
  })

  it('leaves the scalar operators alone', async () => {
    const rows = await Order.where('total', '>=', 20).get()

    expect(rows).toHaveLength(2)
  })
})
