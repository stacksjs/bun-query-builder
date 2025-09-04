import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { resetDatabase } from '../src/actions/migrate'

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

beforeAll(async () => {
  // Set up database for transaction tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

afterAll(async () => {
  // Clean up database after transaction tests
  await resetDatabase('./examples/models', { dialect: 'postgres' })
})

describe('transactions API shape', () => {
  it('exposes transaction helpers', async () => {
    const db = qb()
    expect(typeof db.transaction).toBe('function')
    expect(typeof db.savepoint).toBe('function')
    expect(typeof db.beginDistributed).toBe('function')
  })

  it('savepoint throws outside an active transaction', async () => {
    const db = qb()
    await expect(db.savepoint(async () => {})).rejects.toThrow('savepoint() must be called inside a transaction')
  })

  it('transactional returns a function without executing', () => {
    const db = qb()
    const wrapped = db.transactional(async () => 'ok')
    expect(typeof wrapped).toBe('function')
  })

  it('setTransactionDefaults/configure are callable', () => {
    const db = qb()
    expect(() => db.setTransactionDefaults({ retries: 3 })).not.toThrow()
    expect(() => db.configure({ debug: { captureText: false } } as any)).not.toThrow()
  })
})
