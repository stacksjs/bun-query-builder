import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { config } from '../src/config'
import { getOrCreateBunSql, resetConnection } from '../src/db'

describe('SQLite statement reuse', () => {
  let snapshot: { dialect: typeof config.dialect, database: typeof config.database }

  beforeEach(() => {
    snapshot = { dialect: config.dialect, database: { ...config.database } }
    config.dialect = 'sqlite'
    config.database.database = ':memory:'
    resetConnection()
  })

  afterEach(() => {
    config.dialect = snapshot.dialect
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('does not prepare a fresh statement for every parameterized read', async () => {
    const sql = getOrCreateBunSql()
    const prepare = spyOn(Database.prototype, 'prepare')
    try {
      expect(await sql.unsafe('SELECT ? AS value', ['first'])).toEqual([{ value: 'first' }])
      expect(await sql.unsafe('SELECT ? AS value', ['second'])).toEqual([{ value: 'second' }])
      expect(prepare.mock.calls.filter(([query]) => query === 'SELECT ? AS value').length).toBeLessThan(2)
    }
    finally {
      prepare.mockRestore()
    }
  })

  it('does not reuse old bindings when a later read omits its parameters', async () => {
    const sql = getOrCreateBunSql()
    expect(await sql.unsafe('SELECT ? AS value', ['first'])).toEqual([{ value: 'first' }])
    expect(await sql.unsafe('SELECT ? AS value')).toEqual([{ value: null }])
    expect(await sql.unsafe('SELECT ? AS value', ['second'])).toEqual([{ value: 'second' }])
  })

  it('does not reuse old bindings when a later write omits its parameters', async () => {
    const sql = getOrCreateBunSql()
    await sql.unsafe('CREATE TABLE values_seen (value TEXT)')
    await sql.unsafe('INSERT INTO values_seen VALUES (?)', ['first'])
    await sql.unsafe('INSERT INTO values_seen VALUES (?)')
    await sql.unsafe('INSERT INTO values_seen VALUES (?)', ['second'])
    expect(await sql.unsafe('SELECT value FROM values_seen ORDER BY rowid')).toEqual([
      { value: 'first' }, { value: null }, { value: 'second' },
    ])
  })

  it('keeps numbered binding order, failed-bind recovery, and schema changes', async () => {
    const sql = getOrCreateBunSql()
    expect(await sql.unsafe('SELECT $2 AS a, $1 AS b, $2 AS c', ['one', 'two'])).toEqual([{ a: 'two', b: 'one', c: 'two' }])
    expect(await sql.unsafe('SELECT $2 AS a, $1 AS b, $2 AS c', ['three', 'four'])).toEqual([{ a: 'four', b: 'three', c: 'four' }])
    await expect(sql.unsafe('SELECT ? AS a, ? AS b', [1]).execute()).rejects.toThrow()
    expect(await sql.unsafe('SELECT ? AS a, ? AS b', [2, 3])).toEqual([{ a: 2, b: 3 }])

    await sql.unsafe('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    await sql.unsafe('INSERT INTO items VALUES (?)', [1])
    expect(await sql.unsafe('SELECT * FROM items WHERE id = ?', [1])).toEqual([{ id: 1 }])
    await sql.unsafe("ALTER TABLE items ADD COLUMN name TEXT DEFAULT 'new'")
    expect(await sql.unsafe('SELECT * FROM items WHERE id = ?', [1])).toEqual([{ id: 1, name: 'new' }])
  })
})
