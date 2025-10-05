import type { DatabaseSchema } from '../src/schema'
import { beforeEach, describe, expect, test } from 'bun:test'
import { clearQueryCache, createQueryBuilder, setQueryCacheMaxSize } from '../src/client'
import { defineModels } from '../src/schema'

// Mock SQL implementation
function createMockSql() {
  const queries: any[] = []

  function mockSql(strings: TemplateStringsArray | any, ...values: any[]): any {
    if (Array.isArray(strings) && strings.raw) {
      const query = strings.reduce((acc, str, i) =>
        acc + str + (values[i] !== undefined ? `$${i + 1}` : ''), '')
      const result = {
        query,
        values,
        toString: () => query,
        execute: async () => [],
      }
      queries.push(result)
      return result
    }
    return { query: String(strings), values, toString: () => String(strings), execute: async () => [] }
  }

  mockSql.queries = queries
  mockSql.clearQueries = () => {
    queries.length = 0
  }

  return mockSql
}

const User = {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: {} } },
    name: { validation: { rule: {} } },
    email: { validation: { rule: {} } },
    active: { validation: { rule: {} } },
    created_at: { validation: { rule: {} } },
  },
}

const _models = defineModels({ User })
type DB = DatabaseSchema<typeof _models>

describe('Query Caching', () => {
  let mockSql: any
  let db: ReturnType<typeof createQueryBuilder<DB>>

  beforeEach(() => {
    clearQueryCache()
    mockSql = createMockSql()
    db = createQueryBuilder<DB>({ sql: mockSql })
  })

  test('cache() method exists and returns query builder', () => {
    const qb = db.selectFrom('users').cache()
    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })

  test('cache() accepts TTL parameter', () => {
    const qb = db.selectFrom('users').cache(5000)
    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })

  test('cache() with default TTL', () => {
    const qb = db.selectFrom('users').cache()
    expect(qb).toBeDefined()
  })

  test('clearQueryCache() function exists', () => {
    expect(typeof clearQueryCache).toBe('function')
    clearQueryCache() // Should not throw
  })

  test('setQueryCacheMaxSize() function exists', () => {
    expect(typeof setQueryCacheMaxSize).toBe('function')
    setQueryCacheMaxSize(200) // Should not throw
  })

  test('cache() can be chained with where clause', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .cache(3000)

    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.get).toBe('function')
  })

  test('cache() can be chained with orderBy', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .cache(3000)
      .orderBy('name', 'asc')

    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.get).toBe('function')
  })

  test('cache() can be chained with limit and offset', () => {
    const qb = db.selectFrom('users')
      .cache(2000)
      .limit(10)
      .offset(5)

    expect(qb).toBeDefined()
    expect(typeof qb.get).toBe('function')
  })

  test('cache() maintains fluent interface', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .cache(5000)
      .orderBy('created_at', 'desc')
      .limit(10)

    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.get).toBe('function')
    expect(typeof qb.first).toBe('function')
  })

  test('multiple queries can use cache', () => {
    const qb1 = db.selectFrom('users').where({ active: true }).cache(1000)
    const qb2 = db.selectFrom('users').where({ active: false }).cache(2000)

    expect(qb1).toBeDefined()
    expect(qb2).toBeDefined()
    expect(typeof qb1.get).toBe('function')
    expect(typeof qb2.get).toBe('function')
  })

  test('clearQueryCache can be called multiple times', () => {
    clearQueryCache()
    clearQueryCache()
    clearQueryCache()
    // Should not throw
    expect(true).toBe(true)
  })

  test('setQueryCacheMaxSize accepts positive numbers', () => {
    setQueryCacheMaxSize(100)
    setQueryCacheMaxSize(500)
    setQueryCacheMaxSize(1000)
    // Should not throw
    expect(true).toBe(true)
  })

  test('cache() works with complex query chains', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .orderBy('created_at', 'desc')
      .limit(20)
      .offset(10)
      .cache(3000)

    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })
})

describe('Query Caching - Integration', () => {
  let mockSql: any
  let db: ReturnType<typeof createQueryBuilder<DB>>

  beforeEach(() => {
    clearQueryCache()
    mockSql = createMockSql()
    db = createQueryBuilder<DB>({ sql: mockSql })
  })

  test('cached query maintains all query builder methods', () => {
    const qb = db.selectFrom('users').cache(1000)

    expect(typeof qb.where).toBe('function')
    expect(typeof qb.orderBy).toBe('function')
    expect(typeof qb.limit).toBe('function')
    expect(typeof qb.offset).toBe('function')
    expect(typeof qb.get).toBe('function')
    expect(typeof qb.first).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
  })

  test('cache can be applied at different points in the chain', () => {
    // Cache early
    const qb1 = db.selectFrom('users').cache(1000).where({ active: true })
    expect(qb1).toBeDefined()

    // Cache late
    const qb2 = db.selectFrom('users').where({ active: true }).cache(1000)
    expect(qb2).toBeDefined()

    // Cache in middle
    const qb3 = db.selectFrom('users').where({ active: true }).cache(1000).orderBy('name', 'asc')
    expect(qb3).toBeDefined()
  })

  test('cache() preserves type safety', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .cache(5000)

    // Should still have proper types
    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })
})
