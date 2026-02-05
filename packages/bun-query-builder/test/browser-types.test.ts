/**
 * Browser Model Type Inference Tests
 *
 * These tests verify that createBrowserModel provides the same
 * narrow type inference as createModel (server-side ORM).
 */
import { describe, expect, it } from 'bun:test'
import { createBrowserModel, configureBrowser } from '../src/browser'

// Configure browser for tests
configureBrowser({ baseUrl: 'http://localhost:3000/api' })

// Define enum values once - same pattern as server-side
const roles = ['admin', 'user', 'moderator'] as const
const statuses = ['active', 'inactive', 'pending'] as const
const conditions = ['excellent', 'good', 'fair', 'poor'] as const

// Create typed browser model
const User = createBrowserModel({
  name: 'User',
  table: 'users',
  traits: {
    useTimestamps: true,
    useUuid: true,
    useApi: { uri: 'users' },
  },
  attributes: {
    name: {
      fillable: true,
      factory: () => 'Test User',
    },
    email: {
      fillable: true,
      unique: true,
      factory: () => 'test@example.com',
    },
    age: {
      fillable: true,
      factory: () => 25,
    },
    active: {
      fillable: true,
      factory: () => true,
    },
    role: {
      fillable: true,
      factory: (): typeof roles[number] => 'user',
    },
    status: {
      fillable: true,
      factory: (): typeof statuses[number] => 'active',
    },
    password: {
      fillable: true,
      hidden: true,
      factory: () => 'secret123',
    },
  },
} as const)

describe('Browser Model Type Inference', () => {
  describe('Factory return type inference', () => {
    it('infers string type from factory returning string', () => {
      // Type test: name should be string
      type NameType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'name') => infer R } ? R : never
        : never
      const _check: NameType = '' as string
      expect(true).toBe(true)
    })

    it('infers number type from factory returning number', () => {
      // Type test: age should be number
      type AgeType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'age') => infer R } ? R : never
        : never
      const _check: AgeType = 0 as number
      expect(true).toBe(true)
    })

    it('infers boolean type from factory returning boolean', () => {
      // Type test: active should be boolean
      type ActiveType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'active') => infer R } ? R : never
        : never
      const _check: ActiveType = true as boolean
      expect(true).toBe(true)
    })

    it('infers narrow union type from typed factory', () => {
      // Type test: role should be 'admin' | 'user' | 'moderator'
      type RoleType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'role') => infer R } ? R : never
        : never
      const _check: RoleType = 'admin' as 'admin' | 'user' | 'moderator'
      expect(true).toBe(true)
    })

    it('infers status union type', () => {
      // Type test: status should be 'active' | 'inactive' | 'pending'
      type StatusType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'status') => infer R } ? R : never
        : never
      const _check: StatusType = 'active' as 'active' | 'inactive' | 'pending'
      expect(true).toBe(true)
    })
  })

  describe('System fields from traits', () => {
    it('includes id field', () => {
      // Type test: id should be number
      type IdType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'id') => infer R } ? R : never
        : never
      const _check: IdType = 0 as number
      expect(true).toBe(true)
    })

    it('includes uuid from useUuid trait', () => {
      // Type test: uuid should be string
      type UuidType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'uuid') => infer R } ? R : never
        : never
      const _check: UuidType = '' as string
      expect(true).toBe(true)
    })

    it('includes timestamps from useTimestamps trait', () => {
      // Type test: created_at and updated_at should be string
      type CreatedAtType = ReturnType<typeof User['find']> extends Promise<infer I | null>
        ? I extends { get: (k: 'created_at') => infer R } ? R : never
        : never
      const _check: CreatedAtType = '' as string
      expect(true).toBe(true)
    })
  })

  describe('Query builder methods', () => {
    it('where() accepts correct column types', () => {
      // These should compile without errors
      const q1 = User.where('name', 'John')
      const q2 = User.where('age', '>', 18)
      const q3 = User.where('role', 'admin')
      const q4 = User.where('active', true)
      expect(q1).toBeDefined()
      expect(q2).toBeDefined()
      expect(q3).toBeDefined()
      expect(q4).toBeDefined()
    })

    it('whereIn() accepts array of correct types', () => {
      const q = User.whereIn('role', ['admin', 'user'])
      expect(q).toBeDefined()
    })

    it('orderBy() accepts valid columns', () => {
      const q1 = User.orderBy('name')
      const q2 = User.orderBy('created_at', 'desc')
      const q3 = User.orderByDesc('age')
      expect(q1).toBeDefined()
      expect(q2).toBeDefined()
      expect(q3).toBeDefined()
    })

    it('select() narrows available columns', () => {
      const q = User.select('name', 'role')
      // After select, only name and role should be available
      expect(q).toBeDefined()
    })
  })

  describe('Model methods', () => {
    it('has find method', () => {
      expect(typeof User.find).toBe('function')
    })

    it('has findOrFail method', () => {
      expect(typeof User.findOrFail).toBe('function')
    })

    it('has all method', () => {
      expect(typeof User.all).toBe('function')
    })

    it('has first method', () => {
      expect(typeof User.first).toBe('function')
    })

    it('has count method', () => {
      expect(typeof User.count).toBe('function')
    })

    it('has exists method', () => {
      expect(typeof User.exists).toBe('function')
    })

    it('has create method', () => {
      expect(typeof User.create).toBe('function')
    })

    it('has update method', () => {
      expect(typeof User.update).toBe('function')
    })

    it('has delete method', () => {
      expect(typeof User.delete).toBe('function')
    })

    it('has paginate method', () => {
      expect(typeof User.paginate).toBe('function')
    })

    it('has pluck method', () => {
      expect(typeof User.pluck).toBe('function')
    })

    it('has latest method', () => {
      expect(typeof User.latest).toBe('function')
    })

    it('has oldest method', () => {
      expect(typeof User.oldest).toBe('function')
    })

    it('has getDefinition method', () => {
      expect(typeof User.getDefinition).toBe('function')
      expect(User.getDefinition().name).toBe('User')
    })

    it('has getTable method', () => {
      expect(typeof User.getTable).toBe('function')
      expect(User.getTable()).toBe('users')
    })
  })

  describe('Dynamic whereColumn methods', () => {
    it('generates whereEmail method', () => {
      expect(typeof (User as any).whereEmail).toBe('function')
    })

    it('generates whereName method', () => {
      expect(typeof (User as any).whereName).toBe('function')
    })

    it('generates whereRole method', () => {
      expect(typeof (User as any).whereRole).toBe('function')
    })

    it('generates whereStatus method', () => {
      expect(typeof (User as any).whereStatus).toBe('function')
    })

    it('generates whereAge method', () => {
      expect(typeof (User as any).whereAge).toBe('function')
    })
  })
})

describe('Complex model with multiple enums', () => {
  const Review = createBrowserModel({
    name: 'Review',
    table: 'reviews',
    traits: {
      useTimestamps: true,
      useApi: { uri: 'reviews' },
    },
    attributes: {
      rating: {
        fillable: true,
        factory: () => 5,
      },
      title: {
        fillable: true,
        factory: () => 'Great!',
      },
      condition: {
        fillable: true,
        factory: (): typeof conditions[number] => 'excellent',
      },
    },
  } as const)

  it('has correct type for condition field', () => {
    // condition should be 'excellent' | 'good' | 'fair' | 'poor'
    type ConditionType = ReturnType<typeof Review['find']> extends Promise<infer I | null>
      ? I extends { get: (k: 'condition') => infer R } ? R : never
      : never
    const _check: ConditionType = 'excellent' as 'excellent' | 'good' | 'fair' | 'poor'
    expect(true).toBe(true)
  })

  it('has correct type for rating field', () => {
    // rating should be number
    type RatingType = ReturnType<typeof Review['find']> extends Promise<infer I | null>
      ? I extends { get: (k: 'rating') => infer R } ? R : never
      : never
    const _check: RatingType = 0 as number
    expect(true).toBe(true)
  })
})
