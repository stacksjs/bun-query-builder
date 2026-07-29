/**
 * Which dialect a command runs against.
 *
 * Every CLI command declared `--dialect` with `{ default: 'postgres' }` and
 * passed the result straight through, so the default arrived at the action as
 * an explicit choice and beat the project's own configuration. A SQLite app
 * running `qb migrate` generated Postgres DDL, and `qb db:wipe` went looking
 * for `pg_tables`, unless every single invocation repeated `--dialect sqlite`.
 * The `|| config.dialect` fallbacks the actions carried were unreachable.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { config, resolveDialect, setConfig } from '../src/config'

const prevDialect = config.dialect
const prevEnv = { DB_DIALECT: process.env.DB_DIALECT, DB_CONNECTION: process.env.DB_CONNECTION }

afterEach(() => {
  setConfig({ dialect: prevDialect })
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
})

describe('resolveDialect', () => {
  it('uses the configured dialect when the caller says nothing', () => {
    delete process.env.DB_DIALECT
    delete process.env.DB_CONNECTION
    setConfig({ dialect: 'sqlite' })
    expect(resolveDialect()).toBe('sqlite')
    expect(resolveDialect(undefined)).toBe('sqlite')
    // An empty string is "unset" too — that is what an unfilled CLI flag gives.
    expect(resolveDialect('')).toBe('sqlite')
  })

  it('honours an explicit choice over everything', () => {
    setConfig({ dialect: 'sqlite' })
    process.env.DB_DIALECT = 'mysql'
    expect(resolveDialect('postgres')).toBe('postgres')
  })

  it('falls back to the environment before the config default', () => {
    delete process.env.DB_CONNECTION
    setConfig({ dialect: 'postgres' })
    process.env.DB_DIALECT = 'sqlite'
    expect(resolveDialect()).toBe('sqlite')
  })

  it('reads DB_CONNECTION too, the variable the connection string uses', () => {
    delete process.env.DB_DIALECT
    setConfig({ dialect: 'postgres' })
    process.env.DB_CONNECTION = 'mysql'
    expect(resolveDialect()).toBe('mysql')
  })

  it('ends at postgres only when nothing else says otherwise', () => {
    delete process.env.DB_DIALECT
    delete process.env.DB_CONNECTION
    setConfig({ dialect: undefined as any })
    expect(resolveDialect()).toBe('postgres')
  })
})
