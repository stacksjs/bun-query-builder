import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src/client'
import { config } from '../src/config'

let dialect: typeof config.dialect
beforeEach(() => { dialect = config.dialect; config.dialect = 'sqlite' })
afterEach(() => { config.dialect = dialect })

function recorder() {
  const calls: Array<{ sql: string, params: unknown[] }> = []
  const sql = {
    unsafe(text: string, params: unknown[]) {
      calls.push({ sql: text, params: [...params] })
      return {}
    },
  }
  const db = createQueryBuilder({ sql })
  const insert = (table: string, values: Record<string, unknown> | Record<string, unknown>[]) => {
    db.insertInto(table).values(values).toSQL()
    return calls.at(-1)!
  }
  return { db, insert }
}

describe('repeated INSERT shapes', () => {
  it('binds fresh values and reads getters on every insert', () => {
    const { insert } = recorder()
    let count = 0
    const row = { get value() { return ++count } }
    expect(insert('items', row)).toEqual({ sql: 'INSERT INTO "items"("value")VALUES(?)', params: [1] })
    expect(insert('items', row)).toEqual({ sql: 'INSERT INTO "items"("value")VALUES(?)', params: [2] })
  })

  it('preserves column order and rebuilds changed column sets', () => {
    const { insert } = recorder()
    insert('items', { name: 'first', age: 1 })
    expect(insert('items', { age: 2, name: 'second' })).toEqual({
      sql: 'INSERT INTO "items"("age","name")VALUES(?,?)', params: [2, 'second'],
    })
    expect(insert('items', { name: 'third' })).toEqual({
      sql: 'INSERT INTO "items"("name")VALUES(?)', params: ['third'],
    })
    expect(insert('items', { name: 'fourth', age: 4 })).toEqual({
      sql: 'INSERT INTO "items"("name","age")VALUES(?,?)', params: ['fourth', 4],
    })
  })

  it('keeps table and column escaping intact on repeated shapes', () => {
    const { insert } = recorder()
    for (const value of ['first', 'second']) {
      expect(insert('odd"table', { 'odd"column': value })).toEqual({
        sql: 'INSERT INTO "odd""table"("odd""column")VALUES(?)', params: [value],
      })
    }
    expect(insert('other', { 'odd"column': 'third' })).toEqual({
      sql: 'INSERT INTO "other"("odd""column")VALUES(?)', params: ['third'],
    })
  })

  it('uses the dialect captured by each insert builder', () => {
    const { db, insert } = recorder()
    config.dialect = 'postgres'
    const pending = db.insertInto('items')
    expect(insert('items', { name: 'pg' }).sql).toBe('INSERT INTO "items"("name")VALUES($1)')
    config.dialect = 'mysql'
    expect(insert('items', { name: 'mysql' }).sql).toBe('INSERT INTO `items`(`name`)VALUES(?)')
    expect(String(pending.values({ name: 'pending' }).toSQL())).toBe('INSERT INTO "items"("name")VALUES($1)')
    config.dialect = 'sqlite'
    expect(insert('items', { name: 'sqlite' }).sql).toBe('INSERT INTO "items"("name")VALUES(?)')
  })

  it('keeps batches separate from single-row shapes', () => {
    const { insert } = recorder()
    insert('items', { value: 1 })
    expect(insert('items', [{ value: 2 }, { value: 3 }])).toEqual({
      sql: 'INSERT INTO "items"("value")VALUES(?),(?)', params: [2, 3],
    })
    expect(insert('items', { value: 4 })).toEqual({ sql: 'INSERT INTO "items"("value")VALUES(?)', params: [4] })
  })

  it('rebuilds evicted and oversized shapes with fresh parameters', () => {
    const { insert } = recorder()
    for (let i = 0; i < 40; i++) insert(`table_${i}`, { value: i })
    expect(insert('table_0', { value: 99 })).toEqual({
      sql: 'INSERT INTO "table_0"("value")VALUES(?)', params: [99],
    })
    const name = 'x'.repeat(9000)
    const first = insert(name, { value: 1 })
    const second = insert(name, { value: 2 })
    expect(second.sql).toBe(first.sql)
    expect(second.params).toEqual([2])
  })
})
