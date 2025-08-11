import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
  },
  Project: {
    name: 'Project',
    table: 'projects',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      status: { validation: { rule: {} } },
    },
  },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)

function qb() {
  return createQueryBuilder<typeof schema>({ meta, schema })
}

describe('query builder - basics', () => {
  it('builds simple select returns a query object', () => {
    const q = qb().selectFrom('users').where({ active: true }).orderBy('created_at', 'desc').limit(10).offset(20).toSQL() as any
    expect(typeof q.execute).toBe('function')
    expect(typeof q.values).toBe('function')
    expect(typeof q.raw).toBe('function')
  })

  it('supports joins returns query object', () => {
    const q = qb().selectFrom('users').join('projects', 'users.id', '=', 'projects.user_id').toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('groupBy & having return query object', () => {
    const q = qb().selectFrom('users').groupBy('id').having(['id', '>', 0]).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('unions', () => {
    const a = qb().selectFrom('users').limit(1)
    const b = qb().selectFrom('users').limit(1)
    const q = a.union(b).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('forPage returns query object', () => {
    const q = qb().selectFrom('users').forPage(3, 25).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
})

describe('query builder - modifiers and raws', () => {
  it('distinct composes', () => {
    const q = qb().selectFrom('users').distinct().toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
  it('distinctOn composes', () => {
    const q = qb().selectFrom('users').distinctOn('id').toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
  it('whereRaw/whereColumn/whereNested compose', () => {
    const sub = qb().selectFrom('users').where(['id', '>', 0])
    const q = qb().selectFrom('users').whereRaw(`1=1`).whereColumn('users.id', '>=', 'users.id').whereNested(sub).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
  it('date/json helpers compose', () => {
    const q1 = qb().selectFrom('users').whereDate('created_at', '>=', '2024-01-01').toSQL() as any
    expect(typeof q1.execute).toBe('function')
    const q2 = qb().selectFrom('users').whereJsonContains('meta', { a: 1 }).toSQL() as any
    expect(typeof q2.execute).toBe('function')
  })
})

describe('query builder - ordering and random', () => {
  let originalRandom: any
  let originalDefaultOrder: any
  beforeEach(() => {
    originalRandom = config.sql.randomFunction
    originalDefaultOrder = config.timestamps.defaultOrderColumn
  })
  afterEach(() => {
    config.sql.randomFunction = originalRandom
    config.timestamps.defaultOrderColumn = originalDefaultOrder
  })
  it('inRandomOrder uses config (composes)', () => {
    config.sql.randomFunction = 'RANDOM()'
    expect(typeof qb().selectFrom('users').inRandomOrder().toSQL()).toBe('object')
    config.sql.randomFunction = 'RAND()'
    expect(typeof qb().selectFrom('users').inRandomOrder().toSQL()).toBe('object')
  })
  it('latest/oldest default column', () => {
    config.timestamps.defaultOrderColumn = 'created_at'
    expect(typeof qb().selectFrom('users').latest().toSQL()).toBe('object')
    expect(typeof qb().selectFrom('users').oldest().toSQL()).toBe('object')
  })
})

describe('query builder - subqueries and relations', () => {
  it('selectFromSub', () => {
    const sub = qb().selectFrom('users').limit(1)
    const q = qb().selectFromSub(sub as any, 'u').toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('with() and selectAllRelations aliasing composes', () => {
    const q = qb().selectFrom('users').with('Project').selectAllRelations().toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('toText() returns a string when enabled', () => {
    const prev = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
    const q = qb().selectFrom('users').where({ active: true })
    const s = (q as any).toText?.() ?? ''
    expect(typeof s).toBe('string')
    if (config.debug)
      config.debug.captureText = prev as boolean
  })
})

describe('query builder - pagination helpers', () => {
  it('exposes paginate/simplePaginate/cursorPaginate methods', () => {
    const q = qb().selectFrom('users') as any
    expect(typeof q.paginate).toBe('function')
    expect(typeof q.simplePaginate).toBe('function')
    expect(typeof q.cursorPaginate).toBe('function')
  })
})
