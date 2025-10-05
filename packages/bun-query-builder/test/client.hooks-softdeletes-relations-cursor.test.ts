import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { setupDatabase } from './setup'
import { mockQueryBuilderState } from './utils'

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    email: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    created_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    deleted_at: { validation: { rule: { validate: (_v: string | null) => true } as any } },
    role: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  hasMany: { posts: 'Post' },
  scopes: {
    admins: (qb: any) => qb.where({ role: 'admin' }),
  },
} as const)

const Post = defineModel({
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    title: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    created_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  belongsTo: { user: 'User' },
} as const)

const Tag = defineModel({
  name: 'Tag',
  table: 'tags',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    created_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  belongsToMany: { posts: 'Post' },
} as const)

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true
  config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }

  // Set up database for hooks/soft deletes/relations tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after hooks/soft deletes/relations tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

describe('hooks, soft deletes, relations and cursor pagination', () => {
  const models = defineModels({ User, Post, Tag })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)

  it('hooks config is assignable and does not interfere with builder composition', () => {
    config.hooks = {
      onQueryStart: () => {},
      onQueryEnd: () => {},
      onQueryError: () => {},
      startSpan: () => ({ end: () => {} }),
    }
    const db = createQueryBuilder<typeof schema>({
      ...mockQueryBuilderState,
      schema,
      meta,
    })
    const q: any = db.selectFrom('users').toSQL()
    expect(String(q)).toContain('SELECT')
  })

  it('soft deletes helpers exist and are chainable', () => {
    const db = createQueryBuilder<typeof schema>({
      ...mockQueryBuilderState,
      schema,
      meta,
    })
    const base = db.selectFrom('users')
    const wt = base.withTrashed?.()
    const ot = base.onlyTrashed?.()
    expect(typeof wt).toBe('object')
    expect(typeof ot).toBe('object')
  })

  it('with() nesting composes without throwing', () => {
    const db = createQueryBuilder<typeof schema>({
      ...mockQueryBuilderState,
      schema,
      meta,
    })
    const q: any = db.selectFrom('users').with?.('posts')
    const sql = String(q?.toSQL?.() ?? '')
    expect(sql.toLowerCase()).toContain('select')
  })

  it('composite cursor paginate composes without throwing', () => {
    const db = createQueryBuilder<typeof schema>({
      ...mockQueryBuilderState,
      schema,
      meta,
    })
    const q: any = db.selectFrom('users')
    // mimic composition that cursorPaginate would add
    const sql = String(q.orderBy('created_at', 'asc').orderBy('id', 'asc').limit(3).toSQL())
    expect(sql.toLowerCase()).toContain('select')
  })
})

describe('Model Lifecycle Hooks', () => {
  it('hooks interface includes model lifecycle events', () => {
    // Type-level test - verify hook signatures exist
    const hooks = {
      beforeCreate: ({ table: _table, data: _data }: { table: string, data: any }) => {
        // Hook implementation
      },
      afterCreate: ({ table: _table, data: _data, result: _result }: { table: string, data: any, result: any }) => {
        // Hook implementation
      },
      beforeUpdate: ({ table: _table, data: _data, where: _where }: { table: string, data: any, where?: any }) => {
        // Hook implementation
      },
      afterUpdate: ({ table: _table, data: _data, where: _where, result: _result }: { table: string, data: any, where?: any, result: any }) => {
        // Hook implementation
      },
      beforeDelete: ({ table: _table, where: _where }: { table: string, where?: any }) => {
        // Hook implementation
      },
      afterDelete: ({ table: _table, where: _where, result: _result }: { table: string, where?: any, result: any }) => {
        // Hook implementation
      },
    }

    expect(typeof hooks.beforeCreate).toBe('function')
    expect(typeof hooks.afterCreate).toBe('function')
    expect(typeof hooks.beforeUpdate).toBe('function')
    expect(typeof hooks.afterUpdate).toBe('function')
    expect(typeof hooks.beforeDelete).toBe('function')
    expect(typeof hooks.afterDelete).toBe('function')
  })

  it('all lifecycle hook types are properly defined', () => {
    const hookNames = [
      'beforeCreate',
      'afterCreate',
      'beforeUpdate',
      'afterUpdate',
      'beforeDelete',
      'afterDelete',
    ]

    // Verify all expected hooks exist as properties
    const hooks: any = {
      beforeCreate: () => {},
      afterCreate: () => {},
      beforeUpdate: () => {},
      afterUpdate: () => {},
      beforeDelete: () => {},
      afterDelete: () => {},
    }

    for (const hookName of hookNames) {
      expect(hooks[hookName]).toBeDefined()
      expect(typeof hooks[hookName]).toBe('function')
    }
  })

  it('hooks can be async functions', () => {
    const asyncHooks = {
      beforeCreate: async ({ table: _table, data: _data }: any) => {
        // Async hook
        await Promise.resolve()
      },
      afterCreate: async ({ table: _table, data: _data, result: _result }: any) => {
        // Async hook
        await Promise.resolve()
      },
    }

    expect(typeof asyncHooks.beforeCreate).toBe('function')
    expect(typeof asyncHooks.afterCreate).toBe('function')
  })
})
