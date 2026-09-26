/**
 * `createMany()` batches the write and nothing else.
 *
 * It was a loop of `create()`: one INSERT, one round trip per record. It now
 * shares one multi-row INSERT between records that set the same columns, so
 * these pin that every per-record rule `create()` applies still applies —
 * hooks, timestamps, supplied and generated keys — and that it
 * really is fewer statements.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel } from '../src'

let db: Database
let Post: any
let Country: any
const hooks: string[] = []
const statements: string[] = []

beforeEach(() => {
  clearModelRegistry()
  hooks.length = 0
  statements.length = 0
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
  db.run('CREATE TABLE cm_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, views INTEGER, created_at TEXT, updated_at TEXT)')
  db.run('CREATE TABLE cm_countries (code TEXT PRIMARY KEY, name TEXT)')

  // Count the INSERTs that reach the database.
  const prepare = db.prepare.bind(db)
  ;(db as any).prepare = (sql: string) => {
    if (/^\s*INSERT/i.test(sql))
      statements.push(sql)
    return prepare(sql)
  }
  const run = db.run.bind(db)
  ;(db as any).run = (sql: string, ...rest: unknown[]) => {
    if (/^\s*INSERT/i.test(sql))
      statements.push(sql)
    return (run as any)(sql, ...rest)
  }
  const query = db.query.bind(db)
  ;(db as any).query = (sql: string) => {
    if (/^\s*INSERT/i.test(sql))
      statements.push(sql)
    return query(sql)
  }

  Post = createModel({
    name: 'CmPost',
    table: 'cm_posts',
    primaryKey: 'id',
    traits: { useTimestamps: true },
    attributes: {
      title: { type: 'string', fillable: true },
      views: { type: 'number', fillable: true },
    },
  } as any)
  Country = createModel({
    name: 'CmCountry',
    table: 'cm_countries',
    primaryKey: 'code',
    traits: { useTimestamps: false },
    attributes: {
      code: { type: 'string', fillable: true },
      name: { type: 'string', fillable: true },
    },
    hooks: {
      beforeCreate: (data: Record<string, unknown>) => { hooks.push(`before:${data.code}`) },
      afterCreate: (m: any) => { hooks.push(`after:${m.get('code')}`) },
    },
  } as any)
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

describe('createMany', () => {
  it('writes records that share columns in one statement', async () => {
    const made = await Country.createMany([
      { code: 'US', name: 'United States' },
      { code: 'DE', name: 'Germany' },
      { code: 'JP', name: 'Japan' },
    ])
    expect(made.map((m: any) => m.get('code'))).toEqual(['US', 'DE', 'JP'])
    expect(db.query('SELECT code, name FROM cm_countries ORDER BY code').all()).toEqual([
      { code: 'DE', name: 'Germany' },
      { code: 'JP', name: 'Japan' },
      { code: 'US', name: 'United States' },
    ])
    expect(statements.filter(s => s.includes('cm_countries'))).toHaveLength(1)
  })

  it('runs every record\'s create hooks, in order', async () => {
    await Country.createMany([{ code: 'US', name: 'A' }, { code: 'DE', name: 'B' }])
    expect(hooks).toEqual(['before:US', 'before:DE', 'after:US', 'after:DE'])
  })

  it('reads generated keys back onto the right instances', async () => {
    const made = await Post.createMany([{ title: 'one' }, { title: 'two' }, { title: 'three' }])
    const rows = db.query('SELECT id, title FROM cm_posts ORDER BY id').all() as any[]
    expect(made.map((m: any) => [m.get('id'), m.get('title')])).toEqual(rows.map(r => [r.id, r.title]))
    expect(made.every((m: any) => typeof m.get('id') === 'number')).toBe(true)
  })

  it('applies timestamps per record, keeping a supplied created_at', async () => {
    await Post.createMany([{ title: 'a' }, { title: 'b', created_at: '2020-01-01 00:00:00' }])
    const rows = db.query('SELECT created_at, updated_at FROM cm_posts ORDER BY id').all() as any[]
    expect(rows[0].created_at).toBeTruthy()
    expect(rows[0].updated_at).toBeTruthy()
    expect(rows[1].created_at).toBe('2020-01-01 00:00:00')
  })

  it('groups records by the columns they set', async () => {
    await Post.createMany([{ title: 'a' }, { title: 'b', views: 3 }, { title: 'c' }])
    const rows = db.query('SELECT title, views FROM cm_posts ORDER BY title').all()
    expect(rows).toEqual([{ title: 'a', views: null }, { title: 'b', views: 3 }, { title: 'c', views: null }])
    expect(statements.filter(s => s.includes('cm_posts'))).toHaveLength(2)
  })

  it('chunks under the bound-parameter limit', async () => {
    const many = Array.from({ length: 12000 }, (_, i) => ({ code: `C${i}`, name: `n${i}` }))
    await Country.createMany(many)
    expect((db.query('SELECT COUNT(*) AS n FROM cm_countries').get() as any).n).toBe(12000)
    // 2 columns, 30000 parameters per statement: 15000 rows fit in one.
    expect(statements.filter(s => s.includes('cm_countries'))).toHaveLength(1)
  })

  it('returns an empty list for no records without touching the database', async () => {
    expect(await Country.createMany([])).toEqual([])
    expect(statements).toHaveLength(0)
  })

  it('leaves instances saved, so a later save() updates rather than inserts', async () => {
    const [us] = await Country.createMany([{ code: 'US', name: 'A' }])
    us.set('name', 'United States')
    await us.save()
    expect(db.query('SELECT code, name FROM cm_countries').all()).toEqual([{ code: 'US', name: 'United States' }])
  })
})
