import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, config, createQueryBuilder, defaultConfig, setConfig } from '../src'

/**
 * `setConfig()` deep-merges.
 *
 * Regression cover for stacksjs/bun-query-builder#1062. That issue was about
 * types — `QueryBuilderConfig` forced apps to restate defaults the library
 * already supplies — but the fix could not be type-only. `applyConfig()` did
 * `Object.assign` plus five hand-written nested spreads, so only `database`,
 * `timestamps`, `pagination`, `softDeletes` and `vitess` merged, and only one
 * level deep. Everything else was replaced wholesale. That was survivable
 * exactly because the over-strict type forced callers to hand over complete
 * sub-objects: the bad type was standing in for the missing merge.
 *
 * Widening the parameter to `QueryBuilderOptions` without fixing the merge
 * would have turned a compile error into a silent `undefined` at runtime —
 * `setConfig({ transactionDefaults: { retries: 5 } })` typechecking and then
 * dropping `sqlStates` and `backoff`. These tests are what stops that
 * regression from shipping.
 *
 * `config` is a process-wide singleton shared with ~27 other test files, so
 * every case snapshots and restores it.
 */

/** Deep-copy plain objects, leave every other value (arrays, functions) alone. */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>))
    out[key] = clone((value as Record<string, unknown>)[key])
  return out as T
}

let saved: Record<string, unknown>

beforeEach(() => {
  saved = clone(config as unknown as Record<string, unknown>)
})

afterEach(() => {
  for (const key of Object.keys(config))
    delete (config as Record<string, unknown>)[key]
  Object.assign(config, saved)
})

describe('setConfig deep merge', () => {
  it('merges a nested section instead of replacing it', () => {
    setConfig({ transactionDefaults: { retries: 5 } })

    expect(config.transactionDefaults.retries).toBe(5)
    // The two that used to vanish. `sqlStates` undefined means every retry
    // decision throws; `backoff` undefined means the retry delay math does.
    expect(config.transactionDefaults.sqlStates).toEqual(['40001', '40P01'])
    expect(config.transactionDefaults.backoff.baseMs).toBe(50)
  })

  it('merges two levels deep', () => {
    setConfig({ transactionDefaults: { backoff: { jitter: false } } })

    expect(config.transactionDefaults.backoff.jitter).toBe(false)
    expect(config.transactionDefaults.backoff.baseMs).toBe(50)
    expect(config.transactionDefaults.backoff.factor).toBe(2)
    expect(config.transactionDefaults.retries).toBe(2)
  })

  it('merges database.pool across successive calls', () => {
    const database = config.database.database

    setConfig({ database: { pool: { max: 20 } } })
    setConfig({ database: { pool: { idleTimeoutMs: 1000 } } })

    // Broken even before the type change: `database` merged, but `database.pool`
    // one level further down did not, so each call dropped the other's field.
    expect(config.database.pool?.max).toBe(20)
    expect(config.database.pool?.idleTimeoutMs).toBe(1000)
    expect(config.database.database).toBe(database)
  })

  it('merges sibling sections independently', () => {
    setConfig({ sql: { randomFunction: 'RAND()' } })

    expect(config.sql.randomFunction).toBe('RAND()')
    expect(config.sql.sharedLockSyntax).toBe('FOR SHARE')
    expect(config.sql.jsonContainsMode).toBe('operator')
  })

  it('replaces arrays wholesale rather than concatenating them', () => {
    setConfig({ transactionDefaults: { sqlStates: ['40002'] } })

    // A user narrowing the retriable set must stop retrying on 40001.
    expect(config.transactionDefaults.sqlStates).toEqual(['40002'])
  })

  it('replaces functions wholesale and never recurses into them', () => {
    const first = (): void => {}
    const second = (): void => {}

    setConfig({ hooks: { onQueryStart: first } })
    setConfig({ hooks: { onQueryStart: second } })

    expect(config.hooks?.onQueryStart).toBe(second)
    expect(typeof config.hooks?.onQueryStart).toBe('function')
  })

  it('accumulates sibling hooks instead of wiping them', () => {
    const start = (): void => {}
    const end = (): void => {}

    setConfig({ hooks: { onQueryStart: start } })
    setConfig({ hooks: { onQueryEnd: end } })

    expect(config.hooks?.onQueryStart).toBe(start)
    expect(config.hooks?.onQueryEnd).toBe(end)
  })

  it('assigns an explicit undefined but leaves absent keys alone', () => {
    // Presence, not value: this is how `resolve-dialect.test.ts` clears the
    // dialect and how `sqlite-bootstrap-pragmas.test.ts` un-does an override.
    setConfig({ dialect: undefined })
    expect(config.dialect).toBeUndefined()

    setConfig({ dialect: 'sqlite' })
    setConfig({ verbose: false })
    expect(config.dialect).toBe('sqlite')
    expect(config.snapshotDir).toBe('.qb')
  })

  it('assigns null without recursing into it', () => {
    expect(() => setConfig({ sqlite: null as any })).not.toThrow()
    expect(config.sqlite).toBeNull()
  })

  it('treats a self-referential config as a leaf instead of recursing forever', () => {
    // An embedding framework's config slice routinely carries a parent
    // back-pointer, and it typechecks — an optional field of an interface can
    // be that interface. Without a cycle guard this spins for seconds,
    // allocates gigabytes and dies with a stack overflow.
    const cyclic: any = { database: { host: 'cyclic-host' } }
    cyclic.database.root = cyclic

    const started = Bun.nanoseconds()
    expect(() => setConfig(cyclic)).not.toThrow()
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6

    expect(elapsedMs).toBeLessThan(500)
    expect(config.database.host).toBe('cyclic-host')
  })

  it('merges the same object appearing under two keys, both times', () => {
    // The cycle guard is a DEPTH chain, popped on the way out — a global seen-set
    // would treat the second occurrence as already-visited and silently drop it.
    const shared = { captureText: false }
    setConfig({ debug: shared, hooks: shared as any })

    expect(config.debug?.captureText).toBe(false)
    expect((config.hooks as any).captureText).toBe(false)
  })
})

describe('setConfig mutation discipline', () => {
  it('preserves the top-level config object identity', () => {
    // Reassigning `config` splits the binding under Bun's bundler and every
    // reader keeps seeing the old object — see the comment on `applyConfig`.
    const ref = config

    setConfig({ verbose: false })
    setConfig({ transactionDefaults: { retries: 4 } })
    setConfig({ database: { host: 'elsewhere' } })

    expect(config).toBe(ref)
  })

  it('replaces nested nodes rather than mutating them in place', () => {
    // Seven test files capture a nested node and hand it back later to restore
    // it. That only works if the merge left the object they are holding alone.
    const previous = config.database
    const host = previous.host

    setConfig({ database: { host: 'other' } })

    expect(config.database).not.toBe(previous)
    expect(previous.host).toBe(host)
    expect(config.database.host).toBe('other')
  })

  it('does not mutate defaultConfig', () => {
    // `config` used to be a SHALLOW spread of `defaultConfig`, so the two
    // shared every nested node and a write to one changed the other.
    expect(config.sql).not.toBe(defaultConfig.sql)

    setConfig({ sql: { randomFunction: 'RAND()' } })

    expect(defaultConfig.sql.randomFunction).toBe('RANDOM()')
  })

  it('ignores __proto__ arriving through a merge', () => {
    // The vector is bunfig's package.json config section, where JSON.parse
    // turns "__proto__" into an ordinary own property.
    setConfig(JSON.parse('{"__proto__":{"polluted":true}}'))
    expect(({} as any).polluted).toBeUndefined()
    expect((config as any).polluted).toBeUndefined()

    setConfig(JSON.parse('{"database":{"__proto__":{"alsoPolluted":true}}}'))
    expect(({} as any).alsoPolluted).toBeUndefined()
    expect((config.database as any).alsoPolluted).toBeUndefined()
  })
})

describe('db.configure', () => {
  it('deep-merges like setConfig instead of replacing a section', () => {
    const schema = buildDatabaseSchema({
      User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    } as any)
    const db = createQueryBuilder<typeof schema>({ schema })

    setConfig({ debug: { captureText: true } })
    db.configure({ debug: { captureText: false } })

    expect(config.debug?.captureText).toBe(false)
  })
})
