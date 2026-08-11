/**
 * Regression coverage for stacksjs/bun-query-builder#1068.
 *
 * `eagerLoadRelation` used to `return` when it could not resolve a relation
 * name. A misspelling therefore loaded nothing and reported nothing, which is
 * indistinguishable from a relation that genuinely has no rows — the property
 * is simply absent from the result and no error is raised anywhere.
 *
 * The same silence covered every relation kind the resolver does not implement.
 * `ModelDefinition` accepts `morphOne`, `morphMany`, `morphTo`, `morphToMany`,
 * `morphedByMany`, `hasOneThrough` and `hasManyThrough`; `resolveRelation`
 * handles four kinds — `hasMany`, `hasOne`, `belongsTo`, `belongsToMany`.
 * Declaring any of the others type-checks, autocompletes, and does nothing.
 *
 * Both now throw, and they say different things: one is the caller's typo, the
 * other is a gap in this library that staring at the model will never explain.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

const Author = createModel({
  name: 'RelAuthor',
  table: 'rel_authors',
  primaryKey: 'id',
  autoIncrement: true,
  hasMany: { books: 'RelBook' },
  // Accepted by the types, never resolved by the loader.
  morphMany: { annotations: 'RelNote' },
  attributes: { name: { type: 'string', fillable: true } },
} as const)

const Book = createModel({
  name: 'RelBook',
  table: 'rel_books',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    title: { type: 'string', fillable: true },
    rel_author_id: { type: 'number', fillable: true },
  },
} as const)

const Loner = createModel({
  name: 'RelLoner',
  table: 'rel_loners',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: { name: { type: 'string', fillable: true } },
} as const)

describe('unknown eager-load relations (#1068)', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
  })

  beforeEach(async () => {
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS rel_authors')
    db.run('DROP TABLE IF EXISTS rel_books')
    db.run('DROP TABLE IF EXISTS rel_loners')
    await createTableFromModel(Author.getDefinition())
    await createTableFromModel(Book.getDefinition())
    await createTableFromModel(Loner.getDefinition())
    await Author.create({ name: 'Le Guin' })
    await Loner.create({ name: 'Solo' })
  })

  afterAll(() => getDatabase().close())

  it('throws on a misspelled relation instead of loading nothing', async () => {
    // Previously: resolved to undefined, returned, and produced a result with no
    // `boks` property and no complaint.
    await expect(Author.with('boks').get()).rejects.toThrow(/no relation 'boks'/)
  })

  it('lists the relations that do exist, so the typo is obvious', async () => {
    await expect(Author.with('boks').get()).rejects.toThrow(/Available: books/)
  })

  it('says so plainly when the model declares no relations at all', async () => {
    await expect(Loner.with('anything').get()).rejects.toThrow(/declares no relations at all/)
  })

  it('distinguishes a declared-but-unsupported kind from a typo', async () => {
    // `annotations` IS declared — as morphMany, which the loader cannot resolve.
    // Telling the user "no such relation" here would send them looking for a
    // misspelling that isn't there.
    const err = await Author.with('annotations').get().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/declares 'annotations' as morphMany/)
    expect((err as Error).message).toMatch(/does not support yet/)
    expect((err as Error).message).not.toMatch(/no relation/)
  })

  it('still loads a supported relation', async () => {
    // The guard must not break the working path — and note the relation
    // resolution is cached per model+name, so this also covers the cache.
    const rows = await Author.with('books').get()
    expect(rows.length).toBe(1)
    await expect(Author.with('books').get()).resolves.toBeDefined()
  })
})
