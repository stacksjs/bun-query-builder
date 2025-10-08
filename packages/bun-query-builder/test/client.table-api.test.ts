import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
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

describe('table() API vs Traditional API - Equivalence Tests', () => {
  it('table().insert() is equivalent to insertInto().values()', async () => {
    const qb = createQueryBuilder()

    // Clean up
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might be empty
    }

    // Insert using table() API
    const user1 = {
      name: 'Test User 1',
      email: 'test1@table-api.com',
      age: 25,
      role: 'user',
    }

    await qb.table('users').insert(user1).execute()

    // Insert using traditional API
    const user2 = {
      name: 'Test User 2',
      email: 'test2@traditional-api.com',
      age: 30,
      role: 'admin',
    }

    await qb.insertInto('users').values(user2).execute()

    // Verify both inserted correctly
    const allUsers = await qb.selectFrom('users').execute()
    expect(allUsers.length).toBeGreaterThanOrEqual(2)

    const tableApiUser = allUsers.find((u: any) => u.email === 'test1@table-api.com')
    const traditionalApiUser = allUsers.find((u: any) => u.email === 'test2@traditional-api.com')

    expect(tableApiUser).toBeDefined()
    expect(tableApiUser.name).toBe('Test User 1')
    expect(traditionalApiUser).toBeDefined()
    expect(traditionalApiUser.name).toBe('Test User 2')
  })

  it('table().update() is equivalent to updateTable().set()', async () => {
    const qb = createQueryBuilder()

    // Clean up and insert test data
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might be empty
    }

    const users = [
      { name: 'User 1', email: 'user1@test.com', age: 25, role: 'user' },
      { name: 'User 2', email: 'user2@test.com', age: 30, role: 'user' },
    ]
    await qb.insertInto('users').values(users).execute()

    const allUsers = await qb.selectFrom('users').execute()
    const user1 = allUsers.find((u: any) => u.email === 'user1@test.com')
    const user2 = allUsers.find((u: any) => u.email === 'user2@test.com')

    // Update using table() API
    await qb.table('users').update({ role: 'admin' }).where({ id: user1.id }).execute()

    // Update using traditional API
    await qb.updateTable('users').set({ role: 'admin' }).where({ id: user2.id }).execute()

    // Verify both updated correctly
    const updatedUsers = await qb.selectFrom('users').whereIn('id', [user1.id, user2.id]).execute()
    expect(updatedUsers.every((u: any) => u.role === 'admin')).toBe(true)
  })

  it('table().delete() is equivalent to deleteFrom()', async () => {
    const qb = createQueryBuilder()

    // Clean up and insert test data
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might be empty
    }

    const users = [
      { name: 'Delete 1', email: 'delete1@test.com', age: 25, role: 'user' },
      { name: 'Delete 2', email: 'delete2@test.com', age: 30, role: 'user' },
      { name: 'Keep', email: 'keep@test.com', age: 35, role: 'admin' },
    ]
    await qb.insertInto('users').values(users).execute()

    const allUsers = await qb.selectFrom('users').execute()
    const user1 = allUsers.find((u: any) => u.email === 'delete1@test.com')
    const user2 = allUsers.find((u: any) => u.email === 'delete2@test.com')

    // Delete using table() API
    await qb.table('users').delete().where({ id: user1.id }).execute()

    // Delete using traditional API
    await qb.deleteFrom('users').where({ id: user2.id }).execute()

    // Verify both deleted correctly
    const remainingUsers = await qb.selectFrom('users').execute()
    const keepUser = remainingUsers.find((u: any) => u.email === 'keep@test.com')

    expect(remainingUsers.find((u: any) => u.id === user1.id)).toBeUndefined()
    expect(remainingUsers.find((u: any) => u.id === user2.id)).toBeUndefined()
    expect(keepUser).toBeDefined()
  })
})

describe('table() API - Batch Operations', () => {
  it('table().insert() handles batch inserts correctly', async () => {
    const qb = createQueryBuilder()

    // Clean up
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might be empty
    }

    // Insert batch using table() API
    const batchUsers = Array.from({ length: 10 }, (_, i) => ({
      name: `Batch User ${i + 1}`,
      email: `batch${i + 1}@test.com`,
      age: 20 + i,
      role: 'user',
    }))

    await qb.table('users').insert(batchUsers).execute()

    // Verify all inserted
    const insertedUsers = await qb.selectFrom('users').where({ role: 'user' }).execute()
    expect(insertedUsers.length).toBeGreaterThanOrEqual(10)

    // Verify data integrity
    const batchUser5 = insertedUsers.find((u: any) => u.email === 'batch5@test.com')
    expect(batchUser5).toBeDefined()
    expect(batchUser5.name).toBe('Batch User 5')
    expect(Number(batchUser5.age)).toBe(24)
  })

  it('table().insert() with returning clause works', async () => {
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
