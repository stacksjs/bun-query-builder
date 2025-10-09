import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

beforeAll(async () => {
  // Set up database for table() API tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after table() API tests
  await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'postgres' })
})

describe('table() API - Laravel-style Interface', () => {
  it('exposes table() method on query builder', () => {
    const qb = createQueryBuilder()
    expect(typeof qb.table).toBe('function')
  })

  it('table() returns builder with insert/update/delete/select methods', () => {
    const qb = createQueryBuilder()
    const table = qb.table('users')

    expect(typeof table.insert).toBe('function')
    expect(typeof table.update).toBe('function')
    expect(typeof table.delete).toBe('function')
    expect(typeof table.select).toBe('function')
  })

  it('table().insert() accepts single record', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').insert({
      name: 'Alice',
      email: 'alice@test.com',
      age: 25,
      role: 'user',
    })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().insert() accepts array of records', () => {
    const qb = createQueryBuilder()
    const users = [
      { name: 'Alice', email: 'alice@test.com', age: 25, role: 'user' },
      { name: 'Bob', email: 'bob@test.com', age: 30, role: 'admin' },
    ]
    const query = qb.table('users').insert(users)

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().update() returns update builder', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').update({ name: 'Updated' })

    expect(query).toBeDefined()
    expect(typeof query.where).toBe('function')
    expect(typeof query.execute).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().update() can be chained with where', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users')
      .update({ name: 'Updated' })
      .where({ id: 1 })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().delete() returns delete builder', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').delete()

    expect(query).toBeDefined()
    expect(typeof query.where).toBe('function')
    expect(typeof query.execute).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().delete() can be chained with where', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').delete().where({ id: 1 })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().select() with no args returns select all builder', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').select()

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
    expect(typeof query.where).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().select() with columns returns typed select builder', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').select('id', 'name', 'email')

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
    expect(typeof query.where).toBe('function')
  })
})

describe('table() API vs Traditional API - API Equivalence', () => {
  it('table().insert() API signature matches insertInto().values()', () => {
    const qb = createQueryBuilder()

    // Both APIs should return builders with same methods
    const tableApiBuilder = qb.table('users').insert({ name: 'Test', email: 'test@test.com', age: 25, role: 'user' })
    const traditionalApiBuilder = qb.insertInto('users').values({ name: 'Test', email: 'test@test.com', age: 25, role: 'user' })

    // Verify both have same methods
    expect(typeof tableApiBuilder.execute).toBe('function')
    expect(typeof tableApiBuilder.returning).toBe('function')
    expect(typeof tableApiBuilder.toSQL).toBe('function')

    expect(typeof traditionalApiBuilder.execute).toBe('function')
    expect(typeof traditionalApiBuilder.returning).toBe('function')
    expect(typeof traditionalApiBuilder.toSQL).toBe('function')
  })

  it('table().update() API signature matches updateTable().set()', () => {
    const qb = createQueryBuilder()

    // Both APIs should return builders with same methods
    const tableApiBuilder = qb.table('users').update({ name: 'Updated' })
    const traditionalApiBuilder = qb.updateTable('users').set({ name: 'Updated' })

    // Verify both have same methods
    expect(typeof tableApiBuilder.where).toBe('function')
    expect(typeof tableApiBuilder.execute).toBe('function')
    expect(typeof tableApiBuilder.toSQL).toBe('function')

    expect(typeof traditionalApiBuilder.where).toBe('function')
    expect(typeof traditionalApiBuilder.execute).toBe('function')
    expect(typeof traditionalApiBuilder.toSQL).toBe('function')
  })

  it('table().delete() API signature matches deleteFrom()', () => {
    const qb = createQueryBuilder()

    // Both APIs should return builders with same methods
    const tableApiBuilder = qb.table('users').delete()
    const traditionalApiBuilder = qb.deleteFrom('users')

    // Verify both have same methods
    expect(typeof tableApiBuilder.where).toBe('function')
    expect(typeof tableApiBuilder.execute).toBe('function')
    expect(typeof tableApiBuilder.toSQL).toBe('function')

    expect(typeof traditionalApiBuilder.where).toBe('function')
    expect(typeof traditionalApiBuilder.execute).toBe('function')
    expect(typeof traditionalApiBuilder.toSQL).toBe('function')
  })
})

describe('table() API - Batch Operations', () => {
  it('table().insert() accepts array of records for batch insert', () => {
    const qb = createQueryBuilder()

    // Insert batch using table() API
    const batchUsers = Array.from({ length: 10 }, (_, i) => ({
      name: `Batch User ${i + 1}`,
      email: `batch${i + 1}@test.com`,
      age: 20 + i,
      role: 'user',
    }))

    const query = qb.table('users').insert(batchUsers)

    // Verify the query builder is created properly
    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
    expect(typeof query.toSQL).toBe('function')
  })

  it('table().insert() with returning clause works', () => {
    const qb = createQueryBuilder()

    const user = {
      name: 'Returning Test',
      email: 'returning@test.com',
      age: 28,
      role: 'user',
    }

    const result = qb.table('users').insert(user).returning('id', 'name', 'email')

    expect(result).toBeDefined()
    expect(typeof result.execute).toBe('function')
  })
})

describe('table() API - Edge Cases', () => {
  it('table().insert() handles empty object gracefully', () => {
    const qb = createQueryBuilder()

    expect(() => {
      qb.table('users').insert({})
    }).not.toThrow()
  })

  it('table().update() without where clause is valid (updates all)', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').update({ role: 'guest' })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().delete() without where clause is valid (deletes all)', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users').delete()

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table() API works with different table names', () => {
    const qb = createQueryBuilder()

    const usersTable = qb.table('users')
    const postsTable = qb.table('posts')
    const commentsTable = qb.table('comments')

    expect(usersTable).toBeDefined()
    expect(postsTable).toBeDefined()
    expect(commentsTable).toBeDefined()

    expect(typeof usersTable.insert).toBe('function')
    expect(typeof postsTable.insert).toBe('function')
    expect(typeof commentsTable.insert).toBe('function')
  })
})

describe('table() API - Chainability', () => {
  it('table().insert().returning() is chainable', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users')
      .insert({ name: 'Test', email: 'test@test.com', age: 25, role: 'user' })
      .returning('id', 'name')

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().update().where() is chainable', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users')
      .update({ name: 'Updated' })
      .where({ id: 1 })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().delete().where() is chainable', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users')
      .delete()
      .where({ id: 1 })

    expect(query).toBeDefined()
    expect(typeof query.execute).toBe('function')
  })

  it('table().select().where().orderBy().limit() is chainable', () => {
    const qb = createQueryBuilder()
    const query = qb.table('users')
      .select()
      .where({ role: 'admin' })

    expect(query).toBeDefined()
    expect(typeof query.orderBy).toBe('function')
    expect(typeof query.limit).toBe('function')
    expect(typeof query.execute).toBe('function')
  })
})
