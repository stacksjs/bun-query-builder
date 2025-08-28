import { beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { config } from '../src/config'
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

describe('hooks, soft deletes, relations and cursor pagination', () => {
  beforeAll(() => {
    if (config.debug)
      config.debug.captureText = true
    config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }
  })

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
    const q: any = db.selectFrom('users').where({ id: 1 }).toSQL()
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
