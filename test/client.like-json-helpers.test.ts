import { describe, it, expect } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModels, defineModel } from '../src'

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
  const models = defineModels({ User })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)
  const db = createQueryBuilder<typeof schema>({ schema, meta })

  it('whereLike/orWhereLike/notLike', () => {
    const a = db.selectFrom('users').whereLike('name', '%a%').toSQL()
    const b = db.selectFrom('users').orWhereLike('name', '%b%').toSQL()
    const c = db.selectFrom('users').whereNotLike('name', '%c%').toSQL()
    expect(String(a)).toContain('LIKE')
    expect(String(b)).toContain('LIKE')
    expect(String(c)).toContain('NOT LIKE')
  })

  it('json helpers exist', () => {
    const a = db.selectFrom('users').whereJsonContains('prefs', { theme: 'dark' }).toSQL()
    expect(String(a)).toContain('WHERE')
  })
})


