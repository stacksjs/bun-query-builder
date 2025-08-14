import { describe, it, expect, beforeAll } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModels, defineModel } from '../src'
import { config } from '../src/config'

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    email: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    created_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    deleted_at: { validation: { rule: { validate: (v: string | null) => true } as any } },
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

  it('query hooks fire', async () => {
    const events: any[] = []
    config.hooks = {
      onQueryStart: (e) => events.push(['start', e.sql?.slice(0, 20)]),
      onQueryEnd: (e) => events.push(['end', e.durationMs >= 0]),
      onQueryError: (e) => events.push(['err', String(e.error)])
    }
    const db = createQueryBuilder<typeof schema>({ schema, meta })
    // run a simple count
    try {
      await db.count('users', 'id')
    } catch {}
    expect(events.length).toBeGreaterThan(0)
  })

  it('soft deletes default filter and overrides', () => {
    const db = createQueryBuilder<typeof schema>({ schema, meta })
    const base = String((db.selectFrom('users') as any).toText?.() ?? '')
    const filtered = String((db.selectFrom('users').get() as any).toText?.() ?? '')
    const withTrashed = String((db.selectFrom('users').withTrashed?.().get() as any)?.toText?.() ?? '')
    const onlyTrashed = String((db.selectFrom('users').onlyTrashed?.().get() as any)?.toText?.() ?? '')
    expect(base).toContain('SELECT * FROM users')
    expect(filtered.toLowerCase()).toContain('deleted_at')
    expect(withTrashed.toLowerCase()).toContain('deleted_at')
    expect(onlyTrashed.toLowerCase()).toContain('not null')
  })

  it('with() nesting and belongsToMany join path', () => {
    const db = createQueryBuilder<typeof schema>({ schema, meta })
    const nested = String((db.selectFrom('users').with?.('posts') as any)?.toText?.() ?? '')
    expect(nested.toLowerCase()).toContain('left join')
  })

  it('composite cursor paginate', async () => {
    const db = createQueryBuilder<typeof schema>({ schema, meta })
    const res = await db.selectFrom('users').cursorPaginate(2, undefined, ['created_at', 'id'], 'asc')
    expect(res).toHaveProperty('data')
    expect(res).toHaveProperty('meta')
  })
})


