import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

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

describe('model-like facade usage examples (typed only)', () => {
  it('user-like facade compiles with helper calls', async () => {
    const db = qb()
    const UserModel = {
      create(values: Partial<(typeof schema)['users']['columns']>) {
        return db.create('users', values)
      },
      createMany(rows: Partial<(typeof schema)['users']['columns']>[]) {
        return db.createMany('users', rows)
      },
      firstOrCreate(match: Partial<(typeof schema)['users']['columns']>, defaults?: Partial<(typeof schema)['users']['columns']>) {
        return db.firstOrCreate('users', match, defaults)
      },
      updateOrCreate(match: Partial<(typeof schema)['users']['columns']>, values: Partial<(typeof schema)['users']['columns']>) {
        return db.updateOrCreate('users', match, values)
      },
      save(values: Partial<(typeof schema)['users']['columns']>) {
        return db.save('users', values)
      },
      find(id: number) {
        return db.find('users', id)
      },
      remove(id: number) {
        return db.remove('users', id)
      },
      latest(col: keyof (typeof schema)['users']['columns'] = 'created_at') {
        return db.latest('users', col as any)
      },
      oldest(col: keyof (typeof schema)['users']['columns'] = 'created_at') {
        return db.oldest('users', col as any)
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
    void UserModel.save({ id: 1, role: 'admin' })
    void UserModel.find(1)
    void UserModel.remove(1)
    void UserModel.latest('created_at')
    void UserModel.oldest('created_at')
  })
})
