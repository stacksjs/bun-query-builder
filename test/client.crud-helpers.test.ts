import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { setupDatabase } from './setup'
import { mockQueryBuilderState } from './utils'

beforeAll(async () => {
  // Set up database for CRUD helper tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after CRUD helper tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

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

describe('query builder - Batch Operations', () => {
  it('exposes batch operation methods', () => {
    const db = qb()
    expect(typeof db.insertMany).toBe('function')
    expect(typeof db.updateMany).toBe('function')
    expect(typeof db.deleteMany).toBe('function')
  })

  it('insertMany is an alias for createMany', () => {
    const db = qb()
    // Both should exist and be functions
    expect(typeof db.insertMany).toBe('function')
    expect(typeof db.createMany).toBe('function')
  })

  it('insertInto().values() works with array of records', () => {
    const db = qb()
    const users = [
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ]
    const query = db.insertInto('users').values(users)
    expect(query).toBeDefined()
    expect(typeof query.toSQL).toBe('function')
  })

  it('updateTable can be chained with set and where', () => {
    const db = qb()
    const qb2 = db.updateTable('users')
      .set({ name: 'Updated' })
      .where({ id: 1 })

    expect(qb2).toBeDefined()
    expect(typeof qb2.toSQL).toBe('function')
    expect(typeof qb2.execute).toBe('function')
  })

  it('deleteFrom can be chained with where', () => {
    const db = qb()
    const qb2 = db.deleteFrom('users').where({ id: 1 })

    expect(qb2).toBeDefined()
    expect(typeof qb2.toSQL).toBe('function')
    expect(typeof qb2.execute).toBe('function')
  })

  it('batch operations maintain fluent interface', () => {
    const db = qb()

    // Insert
    const insertQb = db.insertInto('users').values([{ name: 'Test', email: 'test@test.com' }])
    expect(typeof insertQb.toSQL).toBe('function')
    expect(typeof insertQb.execute).toBe('function')

    // Update
    const updateQb = db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 })
    expect(typeof updateQb.toSQL).toBe('function')
    expect(typeof updateQb.execute).toBe('function')

    // Delete
    const deleteQb = db.deleteFrom('users').where({ id: 1 })
    expect(typeof deleteQb.toSQL).toBe('function')
    expect(typeof deleteQb.execute).toBe('function')
  })
})
