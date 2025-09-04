import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { mockQueryBuilderState } from './utils'

function qb() {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        email: { type: 'text' },
        created_at: { type: 'timestamp' },
      },
    },
  } as any
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  return createQueryBuilder<typeof schema>({
    ...mockQueryBuilderState,
    schema,
    meta,
  })
}

beforeAll(async () => {
  // Set up database for CRUD helper tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

afterAll(async () => {
  // Clean up database after CRUD helper tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

describe('query builder - CRUD-style helpers availability', () => {
  it('exposes helper functions on the builder', () => {
    const db = qb()
    expect(typeof db.create).toBe('function')
    expect(typeof db.createMany).toBe('function')
    expect(typeof db.firstOrCreate).toBe('function')
    expect(typeof db.updateOrCreate).toBe('function')
    expect(typeof db.save).toBe('function')
    expect(typeof db.remove).toBe('function')
    expect(typeof db.find).toBe('function')
    expect(typeof db.findOrFail).toBe('function')
    expect(typeof db.findMany).toBe('function')
    expect(typeof db.latest).toBe('function')
    expect(typeof db.oldest).toBe('function')
    expect(typeof db.skip).toBe('function')
    expect(typeof db.rawQuery).toBe('function')
  })

  it('skip(table, n) returns a composable select builder', () => {
    const db = qb()
    const q = db.skip('users', 10).limit(5).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
})
