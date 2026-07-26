import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

const models = { User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } } } as const
const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)

describe('savepoint guard', () => {
  it('rejects outside a transaction even when the connection exposes savepoint()', async () => {
    // A live Bun SQL object DOES have .savepoint — the old guard passed here
    // and issued a bare SAVEPOINT against the pool.
    const fakeConn: any = { savepoint: async (fn: any) => fn({}), unsafe: () => {} }
    const db = createQueryBuilder<typeof schema>({ meta, schema, sql: fakeConn }) as any
    await expect(db.savepoint(async () => {})).rejects.toThrow('savepoint() must be called inside a transaction')
  })

  it('allows savepoint on a builder flagged inTransaction', async () => {
    const calls: string[] = []
    const fakeConn: any = { savepoint: async (fn: any) => { calls.push('sp'); return fn(fakeConn) } }
    const db = createQueryBuilder<typeof schema>({ meta, schema, sql: fakeConn, inTransaction: true } as any) as any
    await db.savepoint(async () => {})
    expect(calls).toEqual(['sp'])
  })

  it('a savepoint body is still inside a transaction (nesting works)', async () => {
    const calls: string[] = []
    const fakeConn: any = { savepoint: async (fn: any) => { calls.push('sp'); return fn(fakeConn) } }
    const db = createQueryBuilder<typeof schema>({ meta, schema, sql: fakeConn, inTransaction: true } as any) as any
    await db.savepoint(async (sp: any) => { await sp.savepoint(async () => {}) })
    expect(calls).toEqual(['sp', 'sp'])
  })
})
