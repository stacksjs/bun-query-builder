/**
 * paginate() gains a spelling that cannot be transposed.
 * stacksjs/bun-query-builder#1092.
 *
 * The two paginate APIs take the same two numbers in opposite orders:
 *
 *     db.selectFrom(t).paginate(perPage, page)
 *     Model.query().paginate(page, perPage)
 *
 * Both parameters are `number`, so getting it backwards is not a type error —
 * you simply receive a different page, with no warning. `forPage(page, perPage)`
 * sits ~60 lines from the builder's `paginate(perPage, page)` and takes the
 * opposite order again, which is presumably where this came from.
 *
 * Resolved additively, deliberately: realigning either side would silently
 * change which rows every existing caller gets. So both APIs now also accept
 * `{ page, perPage }`, both keep their positional forms unchanged, and the
 * ORM's result gains a `meta` object mirroring the builder's while keeping its
 * flat fields. Nobody's call moves; there is now a way to write one that
 * cannot be got wrong, and a shape that reads the same from either API.
 *
 * The positional divergence itself is left for a deliberate major.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel } from '../src'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

const MODELS = {
  t: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'string' } } },
} as any

let dir: string
let dbPath: string
let snapshot: { dialect: string, database: Record<string, unknown> }

function qb(): any {
  return createQueryBuilder({
    schema: buildDatabaseSchema(MODELS),
    meta: buildSchemaMeta(MODELS),
    autoMigration: { enabled: false } as any,
  })
}

beforeEach(() => {
  snapshot = { dialect: config.dialect, database: { ...config.database } }
  dir = mkdtempSync(join(tmpdir(), 'qb-1092-'))
  dbPath = join(dir, 'page.sqlite')
  const seed = new Database(dbPath, { create: true })
  seed.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  for (let i = 1; i <= 20; i++) seed.run(`INSERT INTO t (id,name) VALUES (${i},'n${i}')`)
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

describe('the builder accepts the options form (#1092)', () => {
  it('{ perPage, page } means the same as the positional call', async () => {
    const byOptions = await qb().selectFrom('t').selectAll().paginate({ perPage: 5, page: 2 })
    const byPosition = await qb().selectFrom('t').selectAll().paginate(5, 2)

    expect(byOptions.data.map((r: any) => r.id)).toEqual([6, 7, 8, 9, 10])
    expect(byOptions.data).toEqual(byPosition.data)
    expect(byOptions.meta).toEqual({ perPage: 5, page: 2, total: 20, lastPage: 4 })
  })

  it('the positional form is untouched', async () => {
    const res = await qb().selectFrom('t').selectAll().paginate(5, 2)
    expect(res.data.map((r: any) => r.id)).toEqual([6, 7, 8, 9, 10])
  })

  it('page defaults to 1', async () => {
    const res = await qb().selectFrom('t').selectAll().paginate({ perPage: 3 })
    expect(res.data.map((r: any) => r.id)).toEqual([1, 2, 3])
    expect(res.meta.page).toBe(1)
  })

  it('the existing validation still applies through the options form', async () => {
    await expect(qb().selectFrom('t').selectAll().paginate({ perPage: 0 }))
      .rejects.toThrow(/expected positive integer/)
    await expect(qb().selectFrom('t').selectAll().paginate({ perPage: 5, page: 0 }))
      .rejects.toThrow(/expected integer >= 1/)
  })
})

describe('the ORM accepts the options form and reports meta (#1092)', () => {
  let Post: any

  beforeEach(async () => {
    clearModelRegistry()
    const db = new Database(join(dir, 'orm.sqlite'), { create: true })
    configureOrm({ database: db })
    Post = createModel({
      name: 'Pgpost',
      table: 'pg_posts',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { title: { type: 'string', fillable: true } },
    } as any)
    await createTableFromModel(Post.getDefinition())
    for (let i = 1; i <= 20; i++) await Post.create({ title: `t${i}` })
  })

  afterEach(() => clearModelRegistry())

  it('{ perPage, page } selects the same page the builder would', async () => {
    const res = await Post.query().paginate({ perPage: 5, page: 2 })

    // The positional ORM call for this page is paginate(2, 5) — the transposed
    // order that made this worth fixing.
    expect(res.data.map((r: any) => r.id)).toEqual([6, 7, 8, 9, 10])
    expect(res.page).toBe(2)
    expect(res.perPage).toBe(5)
  })

  it('the positional form keeps its own order', async () => {
    const res = await Post.query().paginate(2, 5)
    expect(res.data.map((r: any) => r.id)).toEqual([6, 7, 8, 9, 10])
  })

  it('the flat fields are unchanged', async () => {
    const res = await Post.query().paginate({ perPage: 5, page: 2 })

    expect(res.total).toBe(20)
    expect(res.lastPage).toBe(4)
    expect(res.hasMorePages).toBe(true)
    expect(res.isEmpty).toBe(false)
    expect(res.from).toBe(6)
    expect(res.to).toBe(10)
  })

  it('and meta now reads the same as the builder\'s', async () => {
    const orm = await Post.query().paginate({ perPage: 5, page: 2 })
    const builder = await qb().selectFrom('t').selectAll().paginate({ perPage: 5, page: 2 })

    // The point of the addition: one accessor works against either API.
    expect(orm.meta).toEqual(builder.meta)
  })
})
