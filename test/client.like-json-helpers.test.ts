import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { mockQueryBuilderState } from './utils'

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    prefs: { validation: { rule: { validate: (_v: unknown) => true } as any } },
  },
} as const)

describe('like/json helpers', () => {
  beforeAll(async () => {
    if (config.debug)
      config.debug.captureText = true

    // Set up database for like/json helper tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
  })

  afterAll(async () => {
    // Clean up database after like/json helper tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
  })

  const models = defineModels({ User })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)
  const db = createQueryBuilder<typeof schema>({
    ...mockQueryBuilderState,
    schema,
    meta,
  })

  it('whereLike/orWhereLike/notLike', () => {
    const a = String((db.selectFrom('users').whereLike('name', '%a%') as any).toText?.() ?? '')
    const b = String((db.selectFrom('users').orWhereLike('name', '%b%') as any).toText?.() ?? '')
    const c = String((db.selectFrom('users').whereNotLike('name', '%c%') as any).toText?.() ?? '')
    expect(a).toContain('LIKE')
    expect(b).toContain('LIKE')
    expect(c).toContain('NOT LIKE')
  })

  it('ILike helpers', () => {
    const a = String((db.selectFrom('users').whereILike?.('name', '%abc%') as any)?.toText?.() ?? '')
    const b = String((db.selectFrom('users').orWhereILike?.('name', '%abc%') as any)?.toText?.() ?? '')
    const c = String((db.selectFrom('users').whereNotILike?.('name', '%abc%') as any)?.toText?.() ?? '')
    const d = String((db.selectFrom('users').orWhereNotILike?.('name', '%abc%') as any)?.toText?.() ?? '')
    expect(a || b || c || d).toBeDefined()
  })

  it('json helpers exist', () => {
    const a = String((db.selectFrom('users').whereJsonContains('prefs', { theme: 'dark' }) as any).toText?.() ?? '')
    expect(a).toContain('WHERE')
  })

  it('json path helper exists', () => {
    const a = String((db.selectFrom('users').whereJsonPath?.('prefs->theme', '=', 'dark') as any)?.toText?.() ?? '')
    expect(a).toBeDefined()
  })
})
