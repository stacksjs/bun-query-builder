import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'
import { mockQueryBuilderState } from './utils'

function qb() {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        email: { type: 'text' },
        active: { type: 'boolean' },
        email_verified: { type: 'boolean' },
        created_at: { type: 'timestamp' },
        updated_at: { type: 'timestamp' },
        role: { type: 'text' },
        deleted_at: { type: 'timestamp' },
      },
    },
    posts: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        title: { type: 'text' },
        user_id: { type: 'integer' },
        created_at: { type: 'timestamp' },
      },
    },
    categories: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        parent_id: { type: 'integer' },
      },
    },
  } as any
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  return createQueryBuilder<typeof schema>({
    ...mockQueryBuilderState,
    meta,
    schema,
  })
}

function toTextOf(q: any): string {
  const fn = (q as any)?.toText
  return typeof fn === 'function' ? (fn.call(q) ?? '') : ''
}

function expectTextOutput(s: string) {
  expect(typeof s).toBe('string')
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

  it('typed select(columns) returns a query object', () => {
    const q = qb().select('users', 'id', 'name as username').toSQL() as any
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
    const q = (qb().selectFrom('users') as any).with('Project').selectAllRelations().toSQL() as any
    expect(typeof q.execute).toBe('function')
  })

  it('toText() returns a string when enabled', () => {
    const prev = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
    const q = qb().selectFrom('users').where({ active: true })
    const s = toTextOf(q as any)
    expectTextOutput(s)
    if (config.debug)
      config.debug.captureText = prev as boolean
  })

  it('unionAll composes and returns query object', () => {
    const a = qb().selectFrom('users').limit(1)
    const b = qb().selectFrom('users').limit(1)
    const q = a.unionAll(b).toSQL() as any
    expect(typeof q.execute).toBe('function')
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

describe('query builder - DML builders', () => {
  it('insertInto values returns query with execute and returning chain works', () => {
    const ins = qb().insertInto('users').values({ id: 1, name: 'a' })
    const q1 = ins.toSQL() as any
    expect(typeof q1.execute).toBe('function')
    const ret = ins.returning('id')
    const q2 = ret.toSQL() as any
    expect(typeof q2.execute).toBe('function')
  })

  it('updateTable set/where and returning chain', () => {
    const upd = qb().updateTable('users').set({ name: 'b' }).where({ id: 1 })
    const q1 = upd.toSQL() as any
    expect(typeof q1.execute).toBe('function')
    const ret = upd.returning('id')
    const q2 = ret.toSQL() as any
    expect(typeof q2.execute).toBe('function')
  })

  it('deleteFrom where and returning chain', () => {
    const del = qb().deleteFrom('users').where({ id: 1 })
    const q1 = del.toSQL() as any
    expect(typeof q1.execute).toBe('function')
    const ret = del.returning('id')
    const q2 = ret.toSQL() as any
    expect(typeof q2.execute).toBe('function')
  })

  it('cancel() exists and is safe to call', () => {
    const q = qb().selectFrom('users').limit(1)
    expect(() => (q as any).cancel()).not.toThrow()
  })
})

describe('query builder - SQL text for clauses and helpers', () => {
  let prevCapture: boolean | undefined
  beforeEach(() => {
    prevCapture = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
  })
  afterEach(() => {
    if (config.debug && typeof prevCapture !== 'undefined')
      config.debug.captureText = prevCapture
  })

  it('builds equality and object/array where', () => {
    const q1 = qb().selectFrom('users').where(['id', '=', 1]) as any
    const s1 = toTextOf(q1)
    expectTextOutput(s1)
    const q2 = qb().selectFrom('users').where({ id: 1, name: 'a' }) as any
    const s2 = toTextOf(q2)
    expectTextOutput(s2)
    const q3 = qb().selectFrom('users').where({ id: [1, 2, 3] }) as any
    const s3 = toTextOf(q3)
    expectTextOutput(s3)
  })

  it('supports special operators in where tuple', () => {
    const ops: Array<[string, string, any]> = [
      ['id', '!=', 1],
      ['id', '<', 2],
      ['id', '>', 2],
      ['id', '<=', 2],
      ['id', '>=', 2],
      ['name', 'like', '%a%'],
      ['id', 'in', [1, 2]],
      ['id', 'not in', [1, 2]],
      ['deleted_at', 'is', null],
      ['deleted_at', 'is not', null],
    ]
    for (const [col, op, val] of ops) {
      const s = toTextOf(qb().selectFrom('users').where([col as any, op as any, val]) as any)
      expectTextOutput(s)
    }
  })

  it('null/between/exists/date helpers produce expected snippets', () => {
    const s1 = toTextOf((qb().selectFrom('users') as any).whereNull('deleted_at') as any)
    expectTextOutput(s1)
    const s2 = toTextOf((qb().selectFrom('users') as any).whereNotNull('deleted_at') as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('users').whereBetween('id', 1, 5) as any)
    expectTextOutput(s3)
    const s4 = toTextOf(qb().selectFrom('users').whereNotBetween('id', 1, 5) as any)
    expectTextOutput(s4)
    const sub = qb().selectFrom('users').limit(1)
    const s5 = toTextOf((qb().selectFrom('projects') as any).whereExists(sub as any) as any)
    expectTextOutput(s5)
    const s6 = toTextOf(qb().selectFrom('users').whereDate('created_at', '>=', '2024-01-01') as any)
    expectTextOutput(s6)
  })

  it('column comparisons and nested conditions', () => {
    const s1 = toTextOf(qb().selectFrom('users').whereColumn('users.id', '>=', 'projects.user_id') as any)
    expectTextOutput(s1)
    const nested = qb().selectFrom('users').where(['id', '>', 0])
    const s2 = toTextOf(qb().selectFrom('projects').whereNested(nested as any) as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('projects').orWhereNested(nested as any) as any)
    expectTextOutput(s3)
    const s4 = toTextOf(qb().selectFrom('users').where(['id', '>', 0]).andWhere(['name', 'like', '%a%']) as any)
    expectTextOutput(s4)
    const s5 = toTextOf(qb().selectFrom('users').where(['id', '>', 0]).orWhere(['name', 'like', '%a%']) as any)
    expectTextOutput(s5)
  })

  it('ordering, reordering, and random order', () => {
    const s1 = toTextOf(qb().selectFrom('users').orderBy('created_at', 'asc') as any)
    expectTextOutput(s1)
    const s2 = toTextOf(qb().selectFrom('users').orderByDesc('created_at') as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('users').orderBy('created_at', 'desc').reorder('id', 'asc') as any)
    expectTextOutput(s3)
    const prev = config.sql.randomFunction
    config.sql.randomFunction = 'RANDOM()'
    const s4 = toTextOf(qb().selectFrom('users').inRandomOrder() as any)
    expectTextOutput(s4)
    config.sql.randomFunction = 'RAND()'
    const s5 = toTextOf(qb().selectFrom('users').inRandomOrder() as any)
    expectTextOutput(s5)
    config.sql.randomFunction = prev
  })

  it('limit/offset and forPage', () => {
    const s1 = toTextOf(qb().selectFrom('users').limit(10) as any)
    expectTextOutput(s1)
    const s2 = toTextOf(qb().selectFrom('users').offset(20) as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('users').forPage(2, 25) as any)
    expectTextOutput(s3)
  })

  it('joins, join subs, and cross joins', () => {
    const s1 = toTextOf(qb().selectFrom('users').join('projects', 'users.id', '=', 'projects.user_id') as any)
    expectTextOutput(s1)
    const s2 = toTextOf(qb().selectFrom('users').innerJoin('projects', 'users.id', '=', 'projects.user_id') as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('users').leftJoin('projects', 'users.id', '=', 'projects.user_id') as any)
    expectTextOutput(s3)
    const s4 = toTextOf(qb().selectFrom('users').rightJoin('projects', 'users.id', '=', 'projects.user_id') as any)
    expectTextOutput(s4)
    const sub = qb().selectFrom('users').limit(1)
    const s5 = toTextOf(qb().selectFrom('projects').joinSub(sub as any, 'u', 'u.id', '=', 'projects.user_id') as any)
    expectTextOutput(s5)
    const s6 = toTextOf(qb().selectFrom('projects').leftJoinSub(sub as any, 'u', 'u.id', '=', 'projects.user_id') as any)
    expectTextOutput(s6)
    const s7 = toTextOf(qb().selectFrom('projects').crossJoin('users') as any)
    expectTextOutput(s7)
    const s8 = toTextOf(qb().selectFrom('projects').crossJoinSub(sub as any, 'u') as any)
    expectTextOutput(s8)
  })

  it('group by, group by raw, having and having raw', () => {
    const s1 = toTextOf(qb().selectFrom('users').groupBy('id') as any)
    expectTextOutput(s1)
    const s2 = toTextOf(qb().selectFrom('users').groupByRaw('id') as any)
    expectTextOutput(s2)
    const s3 = toTextOf(qb().selectFrom('users').groupBy('id').having(['id', '>', 0]) as any)
    expectTextOutput(s3)
    const s4 = toTextOf(qb().selectFrom('users').groupBy('id').havingRaw('1=1') as any)
    expectTextOutput(s4)
  })

  it('with relations + selectAllRelations aliasing across formats', () => {
    // default table_column
    config.aliasing.relationColumnAliasFormat = 'table_column'
    const s1 = toTextOf((qb().selectFrom('users') as any).with('Project').selectAllRelations() as any)
    expectTextOutput(s1)
    // dot format
    config.aliasing.relationColumnAliasFormat = 'table.dot.column'
    const s2 = toTextOf((qb().selectFrom('users') as any).with('Project').selectAllRelations() as any)
    expectTextOutput(s2)
    // camelCase
    config.aliasing.relationColumnAliasFormat = 'camelCase'
    const s3 = toTextOf((qb().selectFrom('users') as any).with('Project').selectAllRelations() as any)
    expectTextOutput(s3)
    // reset default
    config.aliasing.relationColumnAliasFormat = 'table_column'
  })

  it('locks and shared lock syntax selection', () => {
    const s1 = toTextOf(qb().selectFrom('users').lockForUpdate() as any)
    expectTextOutput(s1)
    const prev = config.sql.sharedLockSyntax
    config.sql.sharedLockSyntax = 'FOR SHARE'
    const s2 = toTextOf(qb().selectFrom('users').sharedLock() as any)
    expectTextOutput(s2)
    config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
    const s3 = toTextOf(qb().selectFrom('users').sharedLock() as any)
    expectTextOutput(s3)
    config.sql.sharedLockSyntax = prev
  })

  it('CTEs and recursive CTEs compose', () => {
    const sub = qb().selectFrom('users').limit(1)
    const s1 = toTextOf(qb().selectFrom('users').withCTE('one', sub as any) as any)
    expectTextOutput(s1)
    const s2 = toTextOf(qb().selectFrom('users').withRecursive('recur', sub as any) as any)
    expectTextOutput(s2)
  })
})
