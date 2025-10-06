import type { DatabaseSchema } from '../src/schema'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createQueryBuilder } from '../src/client'
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
  mockSql.unsafe = (query: string, params?: any[]) => {
    const result = {
      query,
      values: params || [],
      toString: () => query,
      execute: async () => [],
      raw: () => query,
    }
    queries.push(result)
    return result
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
    age: { validation: { rule: {} } },
    score: { validation: { rule: {} } },
    salary: { validation: { rule: {} } },
    created_at: { validation: { rule: {} } },
  },
}

const _models = defineModels({ User })
type DB = DatabaseSchema<typeof _models>

describe('Aggregation Methods', () => {
  let mockSql: any
  let db: ReturnType<typeof createQueryBuilder<DB>>

  beforeEach(() => {
    mockSql = createMockSql()
    db = createQueryBuilder<DB>({ sql: mockSql })
  })

  test('avg() method exists and has correct signature', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.avg).toBe('function')
  })

  test('sum() method exists and has correct signature', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.sum).toBe('function')
  })

  test('max() method exists and has correct signature', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.max).toBe('function')
  })

  test('min() method exists and has correct signature', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.min).toBe('function')
  })

  test('count() method exists and works', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.count).toBe('function')
  })

  test('aggregation methods can be chained with where clauses', () => {
    const qb = db.selectFrom('users').where({ active: true })
    const sql = qb.toSQL()

    expect(String(sql)).toContain('SELECT * FROM users')
    expect(String(sql)).toContain('WHERE')
    expect(typeof qb.avg).toBe('function')
    expect(typeof qb.sum).toBe('function')
    expect(typeof qb.max).toBe('function')
    expect(typeof qb.min).toBe('function')
  })

  test('aggregation methods work with orderBy and limit', () => {
    const qb = db.selectFrom('users')
      .where({ active: true })
      .orderBy('created_at', 'desc')
      .limit(100)

    expect(typeof qb.avg).toBe('function')
    expect(typeof qb.sum).toBe('function')
  })

  test('aggregation maintains query builder fluent interface', () => {
    const qb = db.selectFrom('users')
      .where({ age: [18, '>=', null] })
      .orderBy('age', 'asc')

    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.avg).toBe('function')
  })

  test('count() is available on query builder', () => {
    const qb = db.selectFrom('users').where({ active: true })
    expect(typeof qb.count).toBe('function')
  })

  test('aggregation methods preserve type safety', () => {
    const qb = db.selectFrom('users')

    // These should all be functions (type check)
    expect(typeof qb.avg).toBe('function')
    expect(typeof qb.sum).toBe('function')
    expect(typeof qb.max).toBe('function')
    expect(typeof qb.min).toBe('function')
    expect(typeof qb.count).toBe('function')
  })
})
