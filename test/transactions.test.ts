import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } } },
  },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)

function qb() {
  return createQueryBuilder<typeof schema>({ meta, schema })
}

describe('transactions API shape', () => {
  it('exposes transaction helpers', async () => {
    const db = qb()
    expect(typeof db.transaction).toBe('function')
    expect(typeof db.savepoint).toBe('function')
    expect(typeof db.beginDistributed).toBe('function')
  })
})
