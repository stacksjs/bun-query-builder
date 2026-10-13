/**
 * How a `Date` parameter reaches the driver (src/bindings.ts).
 *
 * The Postgres side runs against a live server in bindings.dates.pg.test.ts.
 * Here: the serializer itself, the connection wrapper against a stand-in
 * driver, and SQLite, where `bun:sqlite` binds a `Date` as NULL - silently -
 * so a written date simply vanished. Every SQLite path now writes the same
 * ISO-8601 text the libSQL driver already did.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindingValue, serializeBindings, withDateBindings } from '../src/bindings'
import { createQueryBuilder } from '../src/client'
import { config, defaultConfig, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { configureOrm, createModel, getDatabase } from '../src/orm'

const at = new Date('2026-10-13T20:45:42.123Z')
const iso = '2026-10-13T20:45:42.123Z'

describe('serializeBindings', () => {
  it('sends a Date as its ISO string, also inside arrays', () => {
    expect(serializeBindings([1, at, 'x', null])).toEqual([1, iso, 'x', null])
    expect(serializeBindings([[at, [at]]])).toEqual([[iso, [iso]]])
    expect(bindingValue(at)).toBe(iso)
  })

  it('returns the same array when there is nothing to change', () => {
    const params = [1, 'two', null, { at: 'json' }]
    expect(serializeBindings(params)).toBe(params)
    expect(serializeBindings(undefined)).toBeUndefined()
  })

  it('refuses an invalid Date by parameter position instead of sending "Invalid Date"', () => {
    expect(() => serializeBindings([1, new Date('nope')])).toThrow('Cannot bind an invalid Date (parameter 2)')
  })
})

describe('withDateBindings', () => {
  function fakePostgres() {
    const calls: unknown[][] = []
    const conn: any = (...args: unknown[]) => {
      calls.push(['call', ...args])
      return 'q'
    }
    conn.options = { adapter: 'postgres' }
    conn.unsafe = (text: string, params?: unknown[]) => {
      calls.push(['unsafe', text, params])
      return 'q'
    }
    conn.array = (values: unknown[], type?: string) => ({ values, type })
    conn.begin = async (fn: (tx: unknown) => unknown) => fn(conn)
    conn.reserve = async () => conn
    conn.close = function (this: unknown) {
      return this === conn
    }
    return { conn, calls }
  }

  it('leaves anything that is not a Bun Postgres connection alone', () => {
    const mysql: any = () => {}
    mysql.options = { adapter: 'mysql' }
    const plain = { unsafe: () => {} }
    expect(withDateBindings(mysql)).toBe(mysql)
    expect(withDateBindings(plain)).toBe(plain)
  })

  it('serializes unsafe params, template values, helpers and arrays, and wraps what it hands out', async () => {
    const { conn, calls } = fakePostgres()
    const sql: any = withDateBindings(conn)
    expect(withDateBindings(sql)).toBe(sql)

    sql.unsafe('select $1', [at])
    sql`select ${at}, ${'x'}`
    sql({ label: 'a', at })
    sql([{ at }, { at: null }])
    sql([at, at])
    sql('identifier')
    expect(calls).toEqual([
      ['unsafe', 'select $1', [iso]],
      ['call', expect.anything(), iso, 'x'],
      ['call', { label: 'a', at: iso }],
      ['call', [{ at: iso }, { at: null }]],
      ['call', [iso, iso]],
      ['call', 'identifier'],
    ])
    expect(sql.array([at], 'timestamptz')).toEqual({ values: [iso], type: 'timestamptz' })

    calls.length = 0
    await sql.begin((tx: any) => tx.unsafe('insert', [at]))
    const reserved: any = await sql.reserve()
    reserved.unsafe('select', [at])
    expect(calls).toEqual([['unsafe', 'insert', [iso]], ['unsafe', 'select', [iso]]])

    // Other methods still run against the real connection.
    expect(sql.close()).toBe(true)
  })
})

describe('Date parameters on SQLite', () => {
  let directory: string
  let saved: typeof config

  beforeEach(() => {
    saved = { ...config }
    resetConnection()
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    directory = mkdtempSync(join(tmpdir(), 'bqb-dates-'))
    setConfig({ dialect: 'sqlite', database: { database: join(directory, 'dates.sqlite') } })
  })

  afterEach(() => {
    resetConnection()
    Object.assign(config, saved)
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes and matches a Date through the builder, unsafe() and deferInsert()', async () => {
    const db: any = createQueryBuilder()
    await db.unsafe('CREATE TABLE events (label TEXT, at TEXT)')

    await db.insertInto('events').values({ label: 'insert', at }).execute()
    await db.unsafe('INSERT INTO events (label, at) VALUES (?, ?)', ['unsafe', at])
    await db.deferInsert('events', { label: 'deferred', at })
    await db.updateTable('events').set({ at }).where('label', '=', 'unsafe').execute()

    expect(await db.unsafe('SELECT label, at FROM events ORDER BY rowid')).toEqual([
      { label: 'insert', at: iso },
      { label: 'unsafe', at: iso },
      { label: 'deferred', at: iso },
    ])
    const matched = await db.selectFrom('events').where('at', '=', at).get()
    expect(matched.map((r: any) => r.label)).toEqual(['insert', 'unsafe', 'deferred'])
  })

  it('writes a Date through the ORM on its own sqlite database', async () => {
    configureOrm({ database: ':memory:' })
    getDatabase().run('CREATE TABLE date_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, due_at TEXT)')
    const Note = createModel({
      name: 'DateNote',
      table: 'date_notes',
      primaryKey: 'id',
      autoIncrement: true,
      traits: { useTimestamps: false },
      attributes: { body: { type: 'string', fillable: true }, dueAt: { type: 'datetime', fillable: true } },
    } as const)
    await Note.create({ body: 'b', dueAt: at } as any)
    expect(getDatabase().query('SELECT due_at FROM date_notes').all()).toEqual([{ due_at: iso }])
    expect((await Note.where('dueAt', at as any).get()).length).toBe(1)
  })
})
