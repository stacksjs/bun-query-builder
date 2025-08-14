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
    prefs: { validation: { rule: { validate: (v: unknown) => true } as any } },
  },
} as const)

describe('like/json helpers', () => {
  beforeAll(() => {
    if (config.debug)
      config.debug.captureText = true
  })
  const models = defineModels({ User })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)
  const db = createQueryBuilder<typeof schema>({ schema, meta })

  it('whereLike/orWhereLike/notLike', () => {
    const a = String((db.selectFrom('users').whereLike('name', '%a%') as any).toText?.() ?? '')
    const b = String((db.selectFrom('users').orWhereLike('name', '%b%') as any).toText?.() ?? '')
    const c = String((db.selectFrom('users').whereNotLike('name', '%c%') as any).toText?.() ?? '')
    expect(a).toContain('LIKE')
    expect(b).toContain('LIKE')
    expect(c).toContain('NOT LIKE')
  })

  it('json helpers exist', () => {
    const a = String((db.selectFrom('users').whereJsonContains('prefs', { theme: 'dark' }) as any).toText?.() ?? '')
    expect(a).toContain('WHERE')
  })
})


