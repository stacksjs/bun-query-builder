import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    email: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    role: { validation: { rule: { validate: (v: 'admin' | 'member' | 'guest') => !!v } as any } },
    created_at: { validation: { rule: { validate: (v: Date) => v instanceof Date } as any } },
    updated_at: { validation: { rule: { validate: (v: Date) => v instanceof Date } as any } },
  },
} as const)

describe('dynamic whereX/orWhereX/andWhereX methods', () => {
  beforeAll(async () => {
    if (config.debug)
      config.debug.captureText = true

    // Set up database for dynamic where tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
  })

  afterAll(async () => {
    // Clean up database after dynamic where tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
  })
  const models = defineModels({ User })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)
  const db = createQueryBuilder<typeof schema>({ schema, meta })

  it('exposes PascalCase dynamic where methods for columns', () => {
    // Type-only check: calling these should type-check and return a builder
    const q = db
      .selectFrom('users')
      .whereEmail('a@b.com')
      .andWhereName('Alice')
      .orWhereRole('admin')
      .whereCreatedAt(new Date('2024-01-01'))
      .orderBy('id', 'desc')
      .limit(10)

    expect(typeof q.toSQL).toBe('function')
  })

  it('treats array values as IN and scalars as =', () => {
    const a = String((db.selectFrom('users').whereId([1, 2, 3]) as any).toText?.() ?? db.selectFrom('users').whereId([1, 2, 3]).toSQL())
    const b = String((db.selectFrom('users').whereId(1) as any).toText?.() ?? db.selectFrom('users').whereId(1).toSQL())
    expect(a).toContain('IN')
    expect(b).toContain('=')
  })

  it('prefers snake_case column names for resolution', () => {
    const sql = String((db.selectFrom('users').whereCreatedAt(new Date()) as any).toText?.() ?? db.selectFrom('users').whereCreatedAt(new Date()).toSQL())
    expect(sql).toMatch(/created_at/i)
  })
})
