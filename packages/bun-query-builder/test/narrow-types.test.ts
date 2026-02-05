/**
 * Narrow Type Inference Tests
 *
 * These tests verify that the ORM provides precise TypeScript type inference.
 * The type assertions are checked at compile time, and runtime behavior is tested.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createModel, configureOrm, createTableFromModel, getDatabase } from '../src/orm'

// Model with explicit narrow types
const User = createModel({
  name: 'User',
  table: 'test_narrow_users',
  primaryKey: 'id',
  autoIncrement: true,
  traits: {
    useTimestamps: true,
  },
  attributes: {
    name: { type: 'string', fillable: true },
    email: { type: 'string', fillable: true, unique: true },
    age: { type: 'number', fillable: true },
    score: { type: 'number', fillable: true },
    active: { type: 'boolean', fillable: true },
    // Literal union types for narrow inference
    role: { type: ['admin', 'user', 'moderator'] as const, fillable: true },
    status: { type: ['active', 'inactive', 'pending'] as const, fillable: true },
    priority: { type: ['low', 'medium', 'high', 'critical'] as const, fillable: true },
  },
} as const)

// Type assertion helpers - these fail at compile time if types are wrong
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false
type AssertTrue<T extends true> = T

describe('Narrow Type Inference', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
    const db = getDatabase()
    db.run(`
      CREATE TABLE test_narrow_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        age REAL,
        score REAL,
        active INTEGER,
        role TEXT,
        status TEXT,
        priority TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `)

    // Seed test data
    db.run(`INSERT INTO test_narrow_users (name, email, age, score, active, role, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Alice', 'alice@test.com', 25, 95.5, 1, 'admin', 'active', 'high'])
    db.run(`INSERT INTO test_narrow_users (name, email, age, score, active, role, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Bob', 'bob@test.com', 30, 87.0, 0, 'user', 'inactive', 'low'])
    db.run(`INSERT INTO test_narrow_users (name, email, age, score, active, role, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Charlie', 'charlie@test.com', 35, 92.3, 1, 'moderator', 'pending', 'medium'])
  })

  afterAll(() => {
    getDatabase().run('DROP TABLE IF EXISTS test_narrow_users')
  })

  describe('ModelInstance.get() narrow types', () => {
    it('returns string type for string attributes', () => {
      const user = User.find(1)!
      const name = user.get('name')
      const email = user.get('email')

      // Runtime checks
      expect(typeof name).toBe('string')
      expect(typeof email).toBe('string')
      expect(name).toBe('Alice')
      expect(email).toBe('alice@test.com')

      // Compile-time type assertion (this line would fail to compile if types are wrong)
      const _nameCheck: AssertTrue<AssertEqual<typeof name, string>> = true
      const _emailCheck: AssertTrue<AssertEqual<typeof email, string>> = true
    })

    it('returns number type for number attributes', () => {
      const user = User.find(1)!
      const age = user.get('age')
      const score = user.get('score')

      expect(typeof age).toBe('number')
      expect(typeof score).toBe('number')
      expect(age).toBe(25)
      expect(score).toBe(95.5)

      const _ageCheck: AssertTrue<AssertEqual<typeof age, number>> = true
      const _scoreCheck: AssertTrue<AssertEqual<typeof score, number>> = true
    })

    it('returns boolean type for boolean attributes', () => {
      const user = User.find(1)!
      const active = user.get('active')

      // SQLite stores booleans as integers, runtime value is 1 or 0
      // Type system correctly infers boolean
      expect(active).toBeTruthy()
      const _activeCheck: AssertTrue<AssertEqual<typeof active, boolean>> = true
    })

    it('returns literal union type for role attribute', () => {
      const user = User.find(1)!
      const role = user.get('role')

      expect(role).toBe('admin')

      // Type should be 'admin' | 'user' | 'moderator', not just string
      type ExpectedRoleType = 'admin' | 'user' | 'moderator'
      const _roleCheck: AssertTrue<AssertEqual<typeof role, ExpectedRoleType>> = true
    })

    it('returns literal union type for status attribute', () => {
      const user = User.find(2)!
      const status = user.get('status')

      expect(status).toBe('inactive')

      type ExpectedStatusType = 'active' | 'inactive' | 'pending'
      const _statusCheck: AssertTrue<AssertEqual<typeof status, ExpectedStatusType>> = true
    })

    it('returns literal union type for priority attribute', () => {
      const user = User.find(3)!
      const priority = user.get('priority')

      expect(priority).toBe('medium')

      type ExpectedPriorityType = 'low' | 'medium' | 'high' | 'critical'
      const _priorityCheck: AssertTrue<AssertEqual<typeof priority, ExpectedPriorityType>> = true
    })
  })

  describe('pluck() narrow types', () => {
    it('returns string[] for string column', () => {
      const names = User.pluck('name')

      expect(Array.isArray(names)).toBe(true)
      expect(names).toContain('Alice')
      expect(names).toContain('Bob')

      const _namesCheck: AssertTrue<AssertEqual<typeof names, string[]>> = true
    })

    it('returns number[] for number column', () => {
      const ages = User.pluck('age')

      expect(Array.isArray(ages)).toBe(true)
      expect(ages).toContain(25)
      expect(ages).toContain(30)

      const _agesCheck: AssertTrue<AssertEqual<typeof ages, number[]>> = true
    })

    it('returns literal union array for role column', () => {
      const roles = User.pluck('role')

      expect(Array.isArray(roles)).toBe(true)
      expect(roles).toContain('admin')
      expect(roles).toContain('user')
      expect(roles).toContain('moderator')

      type ExpectedRolesType = ('admin' | 'user' | 'moderator')[]
      const _rolesCheck: AssertTrue<AssertEqual<typeof roles, ExpectedRolesType>> = true
    })

    it('returns literal union array for status column', () => {
      const statuses = User.pluck('status')

      expect(Array.isArray(statuses)).toBe(true)
      expect(statuses).toContain('active')
      expect(statuses).toContain('inactive')

      type ExpectedStatusesType = ('active' | 'inactive' | 'pending')[]
      const _statusesCheck: AssertTrue<AssertEqual<typeof statuses, ExpectedStatusesType>> = true
    })

    it('returns literal union array for priority column', () => {
      const priorities = User.pluck('priority')

      expect(Array.isArray(priorities)).toBe(true)

      type ExpectedPrioritiesType = ('low' | 'medium' | 'high' | 'critical')[]
      const _prioritiesCheck: AssertTrue<AssertEqual<typeof priorities, ExpectedPrioritiesType>> = true
    })
  })

  describe('select() narrows available columns', () => {
    it('limits accessible columns after select', () => {
      const users = User.select('name', 'role').get()
      const user = users[0]

      // Can access selected columns
      const name = user.get('name')
      const role = user.get('role')

      expect(name).toBe('Alice')
      expect(role).toBe('admin')

      // Type checks
      const _nameCheck: AssertTrue<AssertEqual<typeof name, string>> = true
      type ExpectedRoleType = 'admin' | 'user' | 'moderator'
      const _roleCheck: AssertTrue<AssertEqual<typeof role, ExpectedRoleType>> = true
    })

    it('returns correct types with chained select', () => {
      const users = User.where('active', true).select('email', 'status').get()

      expect(users.length).toBeGreaterThan(0)
      const email = users[0].get('email')
      const status = users[0].get('status')

      expect(typeof email).toBe('string')

      const _emailCheck: AssertTrue<AssertEqual<typeof email, string>> = true
      type ExpectedStatusType = 'active' | 'inactive' | 'pending'
      const _statusCheck: AssertTrue<AssertEqual<typeof status, ExpectedStatusType>> = true
    })
  })

  describe('where() accepts correct value types', () => {
    it('accepts string for string column', () => {
      const users = User.where('name', 'Alice').get()
      expect(users.length).toBe(1)
      expect(users[0].get('name')).toBe('Alice')
    })

    it('accepts number for number column', () => {
      const users = User.where('age', 25).get()
      expect(users.length).toBe(1)
    })

    it('accepts literal value for literal union column', () => {
      const admins = User.where('role', 'admin').get()
      expect(admins.length).toBe(1)
      expect(admins[0].get('name')).toBe('Alice')
    })

    it('works with operators', () => {
      const older = User.where('age', '>', 25).get()
      expect(older.length).toBe(2)
    })
  })

  describe('whereIn() accepts correct array types', () => {
    it('accepts string[] for string column', () => {
      const users = User.whereIn('name', ['Alice', 'Bob']).get()
      expect(users.length).toBe(2)
    })

    it('accepts number[] for number column', () => {
      const users = User.whereIn('age', [25, 30]).get()
      expect(users.length).toBe(2)
    })

    it('accepts literal union values for literal column', () => {
      const users = User.whereIn('role', ['admin', 'moderator']).get()
      expect(users.length).toBe(2)
    })
  })

  describe('create() accepts correct fillable types', () => {
    it('creates with all typed fields', () => {
      const user = User.create({
        name: 'Test User',
        email: 'test-narrow@test.com',
        age: 28,
        score: 88.5,
        active: true,
        role: 'user',
        status: 'active',
        priority: 'medium',
      })

      expect(user.get('name')).toBe('Test User')
      expect(user.get('role')).toBe('user')
      expect(user.get('priority')).toBe('medium')

      // Cleanup
      user.delete()
    })
  })

  describe('aggregate functions return correct types', () => {
    it('max() returns correct type', () => {
      const maxAge = User.max('age')
      expect(maxAge).toBe(35)

      // max of numbers should be number (returns 0 if no rows)
      const _maxCheck: AssertTrue<AssertEqual<typeof maxAge, number>> = true
    })

    it('min() returns correct type', () => {
      const minAge = User.min('age')
      expect(minAge).toBe(25)

      const _minCheck: AssertTrue<AssertEqual<typeof minAge, number>> = true
    })

    it('avg() returns number', () => {
      const avgAge = User.avg('age')
      expect(typeof avgAge).toBe('number')

      const _avgCheck: AssertTrue<AssertEqual<typeof avgAge, number>> = true
    })

    it('sum() returns number', () => {
      const totalAge = User.sum('age')
      expect(totalAge).toBe(90) // 25 + 30 + 35

      const _sumCheck: AssertTrue<AssertEqual<typeof totalAge, number>> = true
    })
  })

  describe('dynamic whereColumn methods', () => {
    it('whereName() works correctly', () => {
      const UserAny = User as any
      const users = UserAny.whereName('Alice').get()
      expect(users.length).toBe(1)
      expect(users[0].get('name')).toBe('Alice')
    })

    it('whereRole() works with literal values', () => {
      const UserAny = User as any
      const admins = UserAny.whereRole('admin').get()
      expect(admins.length).toBe(1)
    })

    it('whereStatus() works with literal values', () => {
      const UserAny = User as any
      const activeUsers = UserAny.whereStatus('active').get()
      expect(activeUsers.length).toBe(1)
    })
  })

  describe('chained queries preserve types', () => {
    it('preserves types through where().orderBy().limit()', () => {
      const users = User
        .where('active', true)
        .orderBy('name')
        .limit(2)
        .get()

      expect(users.length).toBeLessThanOrEqual(2)
      const role = users[0].get('role')

      type ExpectedRoleType = 'admin' | 'user' | 'moderator'
      const _roleCheck: AssertTrue<AssertEqual<typeof role, ExpectedRoleType>> = true
    })

    it('preserves narrow types with select().where()', () => {
      const users = User
        .select('name', 'role', 'priority')
        .where('role', 'admin')
        .get()

      const user = users[0]
      const name = user.get('name')
      const role = user.get('role')
      const priority = user.get('priority')

      const _nameCheck: AssertTrue<AssertEqual<typeof name, string>> = true
      type ExpectedRoleType = 'admin' | 'user' | 'moderator'
      const _roleCheck: AssertTrue<AssertEqual<typeof role, ExpectedRoleType>> = true
      type ExpectedPriorityType = 'low' | 'medium' | 'high' | 'critical'
      const _priorityCheck: AssertTrue<AssertEqual<typeof priority, ExpectedPriorityType>> = true
    })
  })

  describe('first() and last() preserve types', () => {
    it('first() returns single instance with correct types', () => {
      const user = User.where('role', 'admin').first()!
      const role = user.get('role')

      expect(role).toBe('admin')

      type ExpectedRoleType = 'admin' | 'user' | 'moderator'
      const _roleCheck: AssertTrue<AssertEqual<typeof role, ExpectedRoleType>> = true
    })

    it('last() returns single instance with correct types', () => {
      const user = User.orderBy('id').last()!
      const status = user.get('status')

      type ExpectedStatusType = 'active' | 'inactive' | 'pending'
      const _statusCheck: AssertTrue<AssertEqual<typeof status, ExpectedStatusType>> = true
    })
  })

  describe('update preserves types', () => {
    it('instance update accepts typed values', () => {
      const user = User.find(1)!
      user.set('role', 'moderator')
      user.set('priority', 'critical')
      user.save()

      const updated = User.find(1)!
      expect(updated.get('role')).toBe('moderator')
      expect(updated.get('priority')).toBe('critical')

      // Reset
      user.set('role', 'admin')
      user.set('priority', 'high')
      user.save()
    })
  })
})
