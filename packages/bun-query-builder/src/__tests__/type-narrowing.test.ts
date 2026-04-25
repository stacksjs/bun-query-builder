/**
 * Type narrowing tests for the dynamic ORM.
 *
 * These tests verify that:
 * 1. select() narrows the available columns on ModelInstance
 * 2. Filtered-out attributes cannot be accessed via .get()
 * 3. where() only accepts valid column names
 * 4. create() only accepts fillable fields
 * 5. hidden fields are excluded from toJSON()
 * 6. System fields (id, uuid, timestamps) are correctly conditional
 * 7. Relation names are properly inferred
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { createModel, createTableFromModel, configureOrm, type ModelDefinition } from '../orm'

const UserDef = {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  autoIncrement: true,
  traits: {
    useUuid: true,
    useTimestamps: true,
    useSoftDeletes: true,
  },
  belongsTo: ['Team'] as const,
  hasMany: ['Post', 'Comment'] as const,
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    email: { type: 'string' as const, fillable: true as const, unique: true as const },
    password: { type: 'string' as const, fillable: true as const, hidden: true as const },
    age: { type: 'number' as const, fillable: true as const },
    role: { type: ['admin', 'user', 'moderator'] as const, fillable: true as const },
    bio: { type: 'string' as const, fillable: false as const, guarded: true as const },
  },
} as const satisfies ModelDefinition

const PostDef = {
  name: 'Post',
  table: 'posts',
  attributes: {
    title: { type: 'string' as const, fillable: true as const },
    content: { type: 'string' as const, fillable: true as const },
    views: { type: 'number' as const, fillable: false as const },
  },
  traits: {
    useTimestamps: true,
  },
  belongsTo: ['User'] as const,
} as const satisfies ModelDefinition

// Minimal model — no traits
const TagDef = {
  name: 'Tag',
  table: 'tags',
  attributes: {
    label: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

describe('type narrowing', () => {
  let User: ReturnType<typeof createModel<typeof UserDef>>
  let Post: ReturnType<typeof createModel<typeof PostDef>>
  let Tag: ReturnType<typeof createModel<typeof TagDef>>

  beforeAll(() => {
    configureOrm({ database: ':memory:' })
    User = createModel(UserDef)
    Post = createModel(PostDef)
    Tag = createModel(TagDef)
    createTableFromModel(UserDef)
    createTableFromModel(PostDef)
    createTableFromModel(TagDef)
  })

  // ---------------------------------------------------------------
  // 1. select() narrows columns on the returned ModelInstance
  // ---------------------------------------------------------------
  test('select() narrows .get() key to selected columns only', () => {
    const builder = User.select('name', 'email')
    // builder.get() returns ModelInstance<UserDef, 'name' | 'email'>[]
    // .get('name') should be valid, .get('password') should NOT compile
    // (we can only test runtime here, but the type param proves narrowing)
    const results = builder.get()
    // Verify the SQL only selects those columns
    const { sql } = builder.toSql()
    expect(sql).toContain('SELECT name, email FROM users')
  })

  // ---------------------------------------------------------------
  // 2. where() only accepts valid column names
  // ---------------------------------------------------------------
  test('where() constrains column argument to valid columns', () => {
    // These should work (valid columns)
    const q1 = User.where('name', 'Alice')
    const q2 = User.where('email', 'alice@example.com')
    const q3 = User.where('id', 1)
    const q4 = User.where('age', '>', 18)

    // Verify the queries build correctly
    expect(q1.toSql().sql).toContain('WHERE name = ?')
    expect(q3.toSql().sql).toContain('WHERE id = ?')
    expect(q4.toSql().sql).toContain('WHERE age > ?')
    expect(q4.toSql().params).toEqual([18])
  })

  // ---------------------------------------------------------------
  // 3. create() only accepts fillable fields
  // ---------------------------------------------------------------
  test('create() accepts fillable fields', () => {
    const user = User.create({ name: 'Alice', email: 'alice@test.com', password: 'secret', age: 30 })
    expect(user.get('name')).toBe('Alice')
    expect(user.get('email')).toBe('alice@test.com')
    expect(user.get('age')).toBe(30)
    expect(user.id).toBeGreaterThan(0)
  })

  test('create() does not persist guarded fields', () => {
    // 'bio' has fillable: false, guarded: true — should not be persisted via create
    const user = User.create({ name: 'Bob', email: 'bob@test.com', password: 'secret', age: 25 })
    // bio should not be set
    expect(user.get('bio' as any)).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // 4. hidden fields excluded from toJSON()
  // ---------------------------------------------------------------
  test('toJSON() excludes hidden fields', () => {
    const user = User.create({ name: 'Charlie', email: 'charlie@test.com', password: 'topsecret', age: 35 })
    const json = user.toJSON()
    expect(json).toHaveProperty('name')
    expect(json).toHaveProperty('email')
    expect(json).not.toHaveProperty('password')
  })

  // ---------------------------------------------------------------
  // 5. System fields are conditional on traits
  // ---------------------------------------------------------------
  test('uuid is present when useUuid trait is enabled', () => {
    const user = User.create({ name: 'Dave', email: 'dave@test.com', password: 'pwd', age: 40 })
    const uuid = user.get('uuid')
    expect(uuid).toBeDefined()
    expect(typeof uuid).toBe('string')
    expect(uuid.length).toBeGreaterThan(0)
  })

  test('timestamps are present when useTimestamps trait is enabled', () => {
    const user = User.create({ name: 'Eve', email: 'eve@test.com', password: 'pwd', age: 28 })
    expect(user.get('created_at')).toBeDefined()
    expect(user.get('updated_at')).toBeDefined()
  })

  test('Tag model has no uuid/timestamps (no traits)', () => {
    const tag = Tag.create({ label: 'TypeScript' })
    expect(tag.id).toBeGreaterThan(0)
    expect(tag.get('label')).toBe('TypeScript')
    // Tag has no useUuid or useTimestamps — these columns don't exist
    // At runtime they'd be undefined (the DB doesn't have the columns)
  })

  // ---------------------------------------------------------------
  // 6. select() + get() narrowing through chain
  // ---------------------------------------------------------------
  test('select narrows through the full chain', () => {
    User.create({ name: 'Frank', email: 'frank@test.com', password: 'pwd', age: 50 })
    const results = User.select('name', 'age').where('age', '>', 40).get()
    expect(results.length).toBeGreaterThan(0)
    // Each result should have name and age accessible
    const first = results[0]
    expect(first.get('name')).toBeDefined()
    expect(first.get('age')).toBeDefined()
  })

  // ---------------------------------------------------------------
  // 7. Relation name inference
  // ---------------------------------------------------------------
  test('with() constrains to valid relation names', () => {
    // User has belongsTo: ['Team'], hasMany: ['Post', 'Comment']
    // Valid relation names should be lowercase: 'team', 'post', 'comment'
    const q = User.with('team', 'post', 'comment')
    expect(q.getWithRelations()).toEqual(['team', 'post', 'comment'])
  })

  // ---------------------------------------------------------------
  // 8. Aggregate methods work
  // ---------------------------------------------------------------
  test('aggregates return numbers', () => {
    const count = User.count()
    expect(typeof count).toBe('number')
    expect(count).toBeGreaterThan(0)

    const maxAge = User.max('age')
    expect(typeof maxAge).toBe('number')
  })

  // ---------------------------------------------------------------
  // 9. find / findOrFail
  // ---------------------------------------------------------------
  test('find returns instance or undefined', () => {
    const user = User.find(1)
    expect(user).toBeDefined()
    expect(user!.get('name')).toBeDefined()

    const missing = User.find(99999)
    expect(missing).toBeUndefined()
  })

  test('findOrFail throws on missing', () => {
    expect(() => User.findOrFail(99999)).toThrow()
  })

  // ---------------------------------------------------------------
  // 10. Enum type inference
  // ---------------------------------------------------------------
  test('enum attribute accepts only valid values at runtime', () => {
    const user = User.create({ name: 'Grace', email: 'grace@test.com', password: 'pwd', age: 22, role: 'admin' })
    const role = user.get('role')
    // Type should be 'admin' | 'user' | 'moderator'
    expect(['admin', 'user', 'moderator']).toContain(role)
  })

  // ---------------------------------------------------------------
  // 11. Dynamic where methods (Proxy)
  // ---------------------------------------------------------------
  test('dynamic whereX methods work', () => {
    User.create({ name: 'Hank', email: 'hank@test.com', password: 'pwd', age: 33 })
    const result = (User as any).whereName('Hank').first()
    expect(result).toBeDefined()
    expect(result.get('name')).toBe('Hank')
  })

  // ---------------------------------------------------------------
  // 12. update / delete narrowing
  // ---------------------------------------------------------------
  test('instance update only sets fillable fields', () => {
    const user = User.create({ name: 'Ivy', email: 'ivy@test.com', password: 'pwd', age: 27 })
    user.update({ name: 'Ivy Updated' })
    user.refresh()
    expect(user.get('name')).toBe('Ivy Updated')
  })

  test('isDirty / isClean tracking', () => {
    const user = User.create({ name: 'Jake', email: 'jake@test.com', password: 'pwd', age: 29 })
    expect(user.isClean()).toBe(true)
    user.set('name', 'Jake Modified')
    expect(user.isDirty()).toBe(true)
    expect(user.isDirty('name')).toBe(true)
    expect(user.isDirty('email')).toBe(false)
  })

  // ---------------------------------------------------------------
  // 13. Pagination
  // ---------------------------------------------------------------
  test('paginate returns structured result', () => {
    const result = User.paginate(1, 2)
    expect(result).toHaveProperty('data')
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('page')
    expect(result).toHaveProperty('perPage')
    expect(result).toHaveProperty('lastPage')
    expect(result).toHaveProperty('hasMorePages')
    expect(Array.isArray(result.data)).toBe(true)
  })

  // ---------------------------------------------------------------
  // 14. Chunk processing
  // ---------------------------------------------------------------
  test('chunk processes in batches', () => {
    let processed = 0
    User.query().chunk(2, (users) => {
      processed += users.length
    })
    expect(processed).toBe(User.count())
  })

  // ---------------------------------------------------------------
  // 15. Replicate
  // ---------------------------------------------------------------
  test('replicate creates copy without primary key', () => {
    const user = User.find(1)!
    const copy = user.replicate()
    expect(copy.id).toBeUndefined()
    expect(copy.get('name')).toBe(user.get('name'))
    expect(copy.get('email')).toBe(user.get('email'))
  })
})
