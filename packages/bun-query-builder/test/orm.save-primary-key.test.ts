/**
 * `save()` decides INSERT vs UPDATE by whether the row exists, not by whether
 * its primary key is truthy.
 *
 * It used to test `if (this._attributes[pk])`. That sent three cases the wrong
 * way, all without an error:
 *
 * - `create({ id: 5, … })` took the UPDATE branch, matched no row, and returned
 *   an instance with id 5 for a row that was never written.
 * - A model keyed by a string (`code`, a slug, a UUID) could not create rows at
 *   all, for the same reason.
 * - A loaded row whose key was `0` took the INSERT branch, so editing it wrote
 *   a copy.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel } from '../src'

let db: Database
let Post: any
let Country: any
const hooks: string[] = []

beforeEach(() => {
  clearModelRegistry()
  hooks.length = 0
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
  db.run('CREATE TABLE sp_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT, updated_at TEXT)')
  db.run('CREATE TABLE sp_countries (code TEXT PRIMARY KEY, name TEXT)')

  Post = createModel({
    name: 'SpPost',
    table: 'sp_posts',
    primaryKey: 'id',
    attributes: { title: { type: 'string', fillable: true } },
  } as any)
  Country = createModel({
    name: 'SpCountry',
    table: 'sp_countries',
    primaryKey: 'code',
    traits: { useTimestamps: false },
    attributes: { name: { type: 'string', fillable: true } },
    hooks: {
      beforeCreate: () => { hooks.push('beforeCreate') },
      afterCreate: () => { hooks.push('afterCreate') },
      beforeUpdate: () => { hooks.push('beforeUpdate') },
      afterUpdate: () => { hooks.push('afterUpdate') },
    },
  } as any)
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

const posts = (): any[] => db.query('SELECT id, title FROM sp_posts ORDER BY id').all() as any[]
const countries = (): any[] => db.query('SELECT code, name FROM sp_countries ORDER BY code').all() as any[]

describe('create() with a key the caller supplies', () => {
  it('writes the row under that key', async () => {
    // Was an UPDATE that matched nothing: the instance said id 5, the table was empty.
    const post = await Post.create({ id: 5, title: 'five' })
    expect(post.get('id')).toBe(5)
    expect(posts()).toEqual([{ id: 5, title: 'five' }])
  })

  it('creates rows on a model keyed by a string', async () => {
    const ph = await Country.create({ code: 'PH', name: 'Philippines' })
    // The key stays the string, not the SQLite rowid the driver reports.
    expect(ph.get('code')).toBe('PH')
    expect(countries()).toEqual([{ code: 'PH', name: 'Philippines' }])
    expect(hooks).toEqual(['beforeCreate', 'afterCreate'])
  })

  it('a later save() on the created instance updates it', async () => {
    const ph = await Country.create({ code: 'PH', name: 'Philippines' })
    hooks.length = 0
    ph.set('name', 'Republic of the Philippines')
    await ph.save()
    expect(countries()).toEqual([{ code: 'PH', name: 'Republic of the Philippines' }])
    expect(hooks).toEqual(['beforeUpdate', 'afterUpdate'])
  })

  it('still reads back a generated key when none is supplied', async () => {
    const a = await Post.create({ title: 'a' })
    const b = await Post.create({ title: 'b' })
    expect([a.get('id'), b.get('id')]).toEqual([1, 2])
    b.set('title', 'b2')
    await b.save()
    expect(posts()).toEqual([{ id: 1, title: 'a' }, { id: 2, title: 'b2' }])
  })

  it('treats a null key as not supplied', async () => {
    const post = await Post.create({ id: null, title: 'auto' })
    expect(post.get('id')).toBe(1)
    expect(posts()).toEqual([{ id: 1, title: 'auto' }])
  })

  it('leaves a guarded key to the database', async () => {
    clearModelRegistry()
    const Guarded = createModel({
      name: 'SpGuarded',
      table: 'sp_posts',
      primaryKey: 'id',
      attributes: { id: { type: 'number', guarded: true }, title: { type: 'string', fillable: true } },
    } as any) as any
    const post = await Guarded.create({ id: 99, title: 'g' })
    expect(post.get('id')).toBe(1)
    expect(posts()).toEqual([{ id: 1, title: 'g' }])
  })
})

describe('save() on a loaded row', () => {
  it('updates a row whose key is 0 instead of copying it', async () => {
    db.run(`INSERT INTO sp_posts (id, title) VALUES (0, 'zero')`)
    const post = await Post.find(0)
    post.set('title', 'zero, edited')
    await post.save()
    expect(posts()).toEqual([{ id: 0, title: 'zero, edited' }])
  })

  it('updates a string-keyed row read by a query', async () => {
    db.run(`INSERT INTO sp_countries (code, name) VALUES ('JP', 'Japan')`)
    const jp = await Country.query().where('code', 'JP').first()
    jp.set('name', 'Nippon')
    await jp.save()
    expect(countries()).toEqual([{ code: 'JP', name: 'Nippon' }])
  })

  it('refuses to save changes to a row read without its key', async () => {
    // Took the INSERT branch and wrote a copy of the row.
    await Post.create({ title: 'a' })
    const partial = await Post.query().select('title').first()
    partial.set('title', 'b')
    await expect(partial.save()).rejects.toThrow(`Cannot save a model without a primary key: 'id' was not selected`)
    expect(posts()).toEqual([{ id: 1, title: 'a' }])
  })

  it('a save with no changes on such a row is still a no-op', async () => {
    await Post.create({ title: 'a' })
    const partial = await Post.query().select('title').first()
    await partial.save()
    expect(posts()).toEqual([{ id: 1, title: 'a' }])
  })
})

describe('instances that are not rows yet', () => {
  it('make() then save() inserts, with or without a key', async () => {
    await Post.make({ title: 'made' }).save()
    await Country.make({ code: 'FR', name: 'France' }).save()
    expect(posts()).toEqual([{ id: 1, title: 'made' }])
    expect(countries()).toEqual([{ code: 'FR', name: 'France' }])
  })

  it('replicate() then save() inserts a new row', async () => {
    const original = await Post.create({ title: 'orig' })
    const copy = original.replicate()
    copy.set('title', 'copy')
    await copy.save()
    expect(posts()).toEqual([{ id: 1, title: 'orig' }, { id: 2, title: 'copy' }])
  })
})
