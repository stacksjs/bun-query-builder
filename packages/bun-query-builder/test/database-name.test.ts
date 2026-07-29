/**
 * Which database the maintenance commands think they are working on.
 *
 * `db:wipe` and `db:optimize` look their tables up in `information_schema`,
 * which needs the schema name. They read it from `process.env.DB_NAME` — a
 * variable this library neither documents nor reads anywhere else — and fell
 * back to the literal `'test'`, so on MySQL they listed the tables of whatever
 * database happened to be called `test` and quietly left the real one alone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { config, setConfig } from '../src/config'
import { resolveDatabaseName } from '../src/db'

const prevDatabase = config.database
const prevEnv = process.env.DB_DATABASE

afterEach(() => {
  setConfig({ database: prevDatabase })
  if (prevEnv === undefined)
    delete process.env.DB_DATABASE
  else
    process.env.DB_DATABASE = prevEnv
})

describe('resolveDatabaseName', () => {
  it('uses the configured database', () => {
    delete process.env.DB_DATABASE
    setConfig({ database: { ...prevDatabase, database: 'openfarming' } as any })
    expect(resolveDatabaseName()).toBe('openfarming')
  })

  it('lets DB_DATABASE win, the same variable the connection string reads', () => {
    setConfig({ database: { ...prevDatabase, database: 'from_config' } as any })
    process.env.DB_DATABASE = 'from_env'
    expect(resolveDatabaseName()).toBe('from_env')
  })

  it('strips the quotes a shell-exported value carries', () => {
    process.env.DB_DATABASE = '"quoted_db"'
    expect(resolveDatabaseName()).toBe('quoted_db')
  })

  it('never invents a database called "test"', () => {
    delete process.env.DB_DATABASE
    setConfig({ database: { ...prevDatabase, database: '' } as any })
    expect(resolveDatabaseName()).toBe('')
  })

  it('reads an explicitly passed config over the global one', () => {
    delete process.env.DB_DATABASE
    setConfig({ database: { ...prevDatabase, database: 'global_db' } as any })
    expect(resolveDatabaseName({ database: 'explicit_db' } as any)).toBe('explicit_db')
  })
})
