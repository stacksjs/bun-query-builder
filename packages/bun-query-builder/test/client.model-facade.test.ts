import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, resetDatabase } from '../src'
import { setupDatabase } from './setup'

beforeAll(async () => {
  // Set up database for model facade tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after model facade tests
  await resetDatabase('../../examples/models', { dialect: 'postgres' })
})

describe('model-like facade usage examples (typed only)', () => {
  const models = {
    User: {
      name: 'User',
      table: 'users',
      primaryKey: 'id',
      attributes: {
        id: { validation: { rule: {} } },
        email: { validation: { rule: {} } },
        name: { validation: { rule: {} } },
        role: { validation: { rule: {} } },
        created_at: { validation: { rule: {} } },
      },
    },
  } as const

  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)

  function qb() {
    return createQueryBuilder<typeof schema>({ schema, meta })
  }

  it('user-like facade compiles with helper calls', async () => {
    const db = qb()
    const UserModel = {
      async create(values: Partial<(typeof schema)['users']['columns']>) {
        return await db.create('users', values)
      },
      async createMany(rows: Partial<(typeof schema)['users']['columns']>[]) {
        return await db.createMany('users', rows)
      },
      async firstOrCreate(match: Partial<(typeof schema)['users']['columns']>, defaults?: Partial<(typeof schema)['users']['columns']>) {
        return await db.firstOrCreate('users', match, defaults)
      },
      async updateOrCreate(match: Partial<(typeof schema)['users']['columns']>, values: Partial<(typeof schema)['users']['columns']>) {
        return await db.updateOrCreate('users', match, values)
      },
      async save(values: Partial<(typeof schema)['users']['columns']>) {
        return await db.save('users', values)
      },
      async find(id: number) {
        return await db.find('users', id)
      },
      async remove(id: number) {
        return await db.remove('users', id)
      },
      async latest(col: keyof (typeof schema)['users']['columns'] = 'created_at') {
        return await db.latest('users', col as any)
      },
      async oldest(col: keyof (typeof schema)['users']['columns'] = 'created_at') {
        return await db.oldest('users', col as any)
      },
    }

    expect(typeof UserModel.create).toBe('function')
    expect(typeof UserModel.createMany).toBe('function')
    expect(typeof UserModel.firstOrCreate).toBe('function')
    expect(typeof UserModel.updateOrCreate).toBe('function')
    expect(typeof UserModel.save).toBe('function')
    expect(typeof UserModel.find).toBe('function')
    expect(typeof UserModel.remove).toBe('function')
    // smoke-compile calls (no runtime exec)
    void UserModel.create({ email: 'x@y.z', name: 'X', role: 'guest' })
    void UserModel.createMany([{ email: 'a@b.c', name: 'A', role: 'member' }])
    void UserModel.firstOrCreate({ email: 'unique1@test.com' }, { name: 'X' })
    void UserModel.updateOrCreate({ email: 'm@n.o' }, { name: 'M' })
    void UserModel.save({ role: 'admin' })
    void UserModel.find(1)
    void UserModel.remove(1)
    void UserModel.latest('created_at')
    void UserModel.oldest('created_at')
  })
})
