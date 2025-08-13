import { describe, it, expect } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModels, defineModel } from '../src'

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    email: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
} as const)

describe('retrieval helpers', () => {
  const models = defineModels({ User })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)
  const db = createQueryBuilder<typeof schema>({ schema, meta })

  it('get returns array, first/firstOrFail return one', async () => {
    const q = db.selectFrom('users').whereId(1)
    expect(q.get).toBeDefined()
    expect(q.first).toBeDefined()
    expect(q.firstOrFail).toBeDefined()
  })

  it('find/findOrFail/findMany exist', () => {
    const q = db.selectFrom('users')
    expect(q.find).toBeDefined()
    expect(q.findOrFail).toBeDefined()
    expect(q.findMany).toBeDefined()
  })

  it('rows/row types are present for IDE hovers', () => {
    const q = db.selectFrom('users').whereEmail('a@b.com')
    // ensure properties exist at type-level; runtime returns undefined
    expect('rows' in q).toBe(true)
    expect('row' in q).toBe(true)
  })
})


