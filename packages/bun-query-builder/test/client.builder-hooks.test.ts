import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, config, createQueryBuilder, setConfig } from '../src'
import { resetConnection } from '../src/db'

/**
 * `createQueryBuilder({ hooks })` — per-builder lifecycle hooks.
 *
 * The form has been in the docs and the README for a long time and did not
 * exist: `hooks` was not a member of the builder's internal state, so the call
 * was a `TS2353` excess-property error. What made it worth a test rather than a
 * type tweak is the workaround. `as any` compiled, and then the hooks never
 * fired — every hook site read the process-wide `config.hooks` and nothing
 * looked at builder state — so a builder that appeared configured silently
 * ignored every hook it had been handed. A silent no-op is worse than the
 * compile error in front of it.
 */

const schema = buildDatabaseSchema({
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } },
  },
} as any)

let saved: { dialect: any, database: any, hooks: any }

beforeEach(async () => {
  saved = { dialect: config.dialect, database: { ...config.database }, hooks: config.hooks }
  setConfig({ dialect: 'sqlite', database: { database: ':memory:' }, hooks: {} })
  resetConnection()
  await createQueryBuilder<typeof schema>({ schema })
    .unsafe('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)')
})

afterEach(() => {
  setConfig({ dialect: saved.dialect, database: saved.database, hooks: saved.hooks } as any)
  resetConnection()
})

describe('createQueryBuilder({ hooks })', () => {
  it('fires the hooks it was given', async () => {
    const seen: string[] = []
    // No cast: this is the compile error the issue was about.
    const db = createQueryBuilder<typeof schema>({
      schema,
      hooks: { onQueryStart: e => void seen.push(String(e.kind)) },
    })

    await db.selectFrom('users').execute()

    expect(seen).toEqual(['select'])
  })

  it('leaves a builder without hooks on the global ones', async () => {
    const seen: string[] = []
    setConfig({ hooks: { onQueryStart: () => void seen.push('global') } })

    await createQueryBuilder<typeof schema>({ schema }).selectFrom('users').execute()

    expect(seen).toEqual(['global'])
  })

  it('merges per key, so a global hook still fires when a builder overrides a different one', async () => {
    // The reason this merges rather than replaces: an app-wide logger or tracer
    // should not go quiet because one builder wanted a `beforeCreate`.
    const globals: string[] = []
    const locals: string[] = []
    setConfig({ hooks: { onQueryStart: () => void globals.push('global') } })

    const db = createQueryBuilder<typeof schema>({
      schema,
      hooks: { onQueryEnd: () => void locals.push('local') },
    })
    await db.selectFrom('users').execute()

    expect(globals).toEqual(['global'])
    expect(locals).toEqual(['local'])
  })

  it('lets a builder hook override the global one of the same name', async () => {
    const order: string[] = []
    setConfig({ hooks: { onQueryStart: () => void order.push('global') } })

    const db = createQueryBuilder<typeof schema>({
      schema,
      hooks: { onQueryStart: () => void order.push('builder') },
    })
    await db.selectFrom('users').execute()

    expect(order).toEqual(['builder'])
  })

  it('passes its hooks down to the transaction callback builder', async () => {
    // The tx callback gets a NEW builder around the transaction's connection;
    // without threading, it silently lost the parent's hooks.
    const seen: string[] = []
    const db = createQueryBuilder<typeof schema>({
      schema,
      hooks: { onQueryStart: () => void seen.push('tx') },
    })

    await db.transaction(async (tx) => {
      await tx.selectFrom('users').execute()
    })

    expect(seen.length).toBeGreaterThan(0)
  })

  it('sees hooks configured after the builder was constructed', async () => {
    // `export const db = createQueryBuilder(...)` at module scope, then
    // `setConfig({ hooks })` at boot, is the ordinary shape of an app. Capturing
    // hooks once at construction would silently miss all of them.
    const seen: string[] = []
    const db = createQueryBuilder<typeof schema>({ schema })

    setConfig({ hooks: { onQueryStart: () => void seen.push('late') } })
    await db.selectFrom('users').execute()

    expect(seen).toEqual(['late'])
  })
})
