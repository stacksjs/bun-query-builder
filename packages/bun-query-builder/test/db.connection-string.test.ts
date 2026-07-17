/**
 * Regression coverage for the `DB_*` env preference in `createConnectionString`.
 *
 * Consumers that bundle multiple bun-query-builder module instances (e.g. the
 * vendored Stacks framework) can leave an instance on the built-in
 * `test_db`/`postgres` defaults, because `setConfig()` only mutates one
 * instance's module-scoped config. When the host process declares a matching
 * `DB_CONNECTION`, every instance must build its connection string from the
 * `DB_*` env values instead of its (possibly stale/default) config object.
 * Without these tests a downstream project carried a redundant postinstall
 * patch for months without noticing the upstream fix already existed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DatabaseConfig } from '../src/types'
import { createConnectionString } from '../src/db'

const ENV_KEYS = [
  'DB_CONNECTION',
  'DB_DATABASE',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_HOST',
  'DB_PORT',
  'DB_SSL',
] as const

/** The built-in defaults every instance starts from (see src/config.ts). */
const defaultLikeConfig: DatabaseConfig = {
  database: 'test_db',
  username: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
}

describe('createConnectionString DB_* env preference', () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>

  beforeEach(() => {
    // Start each test from a clean slate so no ambient DB_* leaks in.
    saved = {} as typeof saved
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore the original environment exactly (unset vars stay unset).
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = saved[key]!
    }
  })

  it('prefers env values over the config object when DB_CONNECTION matches (postgres)', () => {
    process.env.DB_CONNECTION = 'postgres'
    process.env.DB_DATABASE = 'training'
    process.env.DB_USERNAME = 'env_user'
    process.env.DB_PASSWORD = 'env_pass'
    process.env.DB_HOST = 'db.example.com'
    process.env.DB_PORT = '5433'

    expect(createConnectionString('postgres', defaultLikeConfig))
      .toBe('postgres://env_user:env_pass@db.example.com:5433/training')
  })

  it('strips surrounding quotes from DB_DATABASE', () => {
    process.env.DB_CONNECTION = 'postgres'
    process.env.DB_DATABASE = '"training"'
    process.env.DB_USERNAME = 'env_user'
    process.env.DB_PASSWORD = 'env_pass'
    process.env.DB_HOST = 'db.example.com'
    process.env.DB_PORT = '5433'

    expect(createConnectionString('postgres', defaultLikeConfig))
      .toBe('postgres://env_user:env_pass@db.example.com:5433/training')

    process.env.DB_DATABASE = '\'training\''
    expect(createConnectionString('postgres', defaultLikeConfig))
      .toBe('postgres://env_user:env_pass@db.example.com:5433/training')
  })

  it('builds a mysql:// string from env when DB_CONNECTION=mysql', () => {
    process.env.DB_CONNECTION = 'mysql'
    process.env.DB_DATABASE = 'training'
    process.env.DB_USERNAME = 'env_user'
    process.env.DB_PASSWORD = 'env_pass'
    process.env.DB_HOST = 'db.example.com'
    process.env.DB_PORT = '3307'

    expect(createConnectionString('mysql', defaultLikeConfig))
      .toBe('mysql://env_user:env_pass@db.example.com:3307/training')
  })

  it('builds a mysql:// string from env when DB_CONNECTION=singlestore', () => {
    process.env.DB_CONNECTION = 'singlestore'
    process.env.DB_DATABASE = 'training'
    process.env.DB_USERNAME = 'env_user'
    process.env.DB_PASSWORD = 'env_pass'
    process.env.DB_HOST = 'db.example.com'
    process.env.DB_PORT = '3307'

    expect(createConnectionString('singlestore', defaultLikeConfig))
      .toBe('mysql://env_user:env_pass@db.example.com:3307/training')
  })

  it('appends ?ssl=true when DB_SSL=true', () => {
    process.env.DB_CONNECTION = 'postgres'
    process.env.DB_DATABASE = 'training'
    process.env.DB_USERNAME = 'env_user'
    process.env.DB_PASSWORD = 'env_pass'
    process.env.DB_HOST = 'db.example.com'
    process.env.DB_PORT = '5433'
    process.env.DB_SSL = 'true'

    expect(createConnectionString('postgres', defaultLikeConfig))
      .toBe('postgres://env_user:env_pass@db.example.com:5433/training?ssl=true')
  })

  it('uses dbConfig.url when DB_CONNECTION is unset', () => {
    const url = 'postgres://cfg_user:cfg_pass@cfg-host:5433/cfgdb'
    expect(createConnectionString('postgres', { ...defaultLikeConfig, url })).toBe(url)
  })

  it('builds from dbConfig fields when DB_CONNECTION is unset', () => {
    process.env.DB_DATABASE = 'ignored_env_db'
    process.env.DB_USERNAME = 'ignored_env_user'

    expect(createConnectionString('postgres', {
      database: 'cfgdb',
      username: 'cfg_user',
      password: 'cfg_pass',
      host: 'cfg-host',
      port: 5433,
    })).toBe('postgres://cfg_user:cfg_pass@cfg-host:5433/cfgdb')
  })

  it('ignores env when DB_CONNECTION does not match the dialect', () => {
    process.env.DB_CONNECTION = 'mysql'
    process.env.DB_DATABASE = 'ignored_env_db'
    process.env.DB_USERNAME = 'ignored_env_user'

    expect(createConnectionString('postgres', {
      database: 'cfgdb',
      username: 'cfg_user',
      password: 'cfg_pass',
      host: 'cfg-host',
      port: 5433,
    })).toBe('postgres://cfg_user:cfg_pass@cfg-host:5433/cfgdb')
  })
})
