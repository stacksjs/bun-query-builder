/**
 * Regression coverage for the sqlite bootstrap-pragma hole.
 *
 * SQLite scopes `foreign_keys` / `busy_timeout` / `wal_autocheckpoint` to the
 * CONNECTION (they cannot persist in the database file) and ships with
 * `foreign_keys = OFF`. The library opens sqlite connections in two
 * independent layers — the query-builder connection (`SQLiteWrapper`) and the
 * model-layer executor (`configureOrm`/`getExecutor`) — and historically only
 * the former got any bootstrap (`journal_mode = WAL` alone). The executor is
 * the connection every `Model.create()/save()/delete()` writes through, so on
 * a real deployment the ORM write path ran with FK enforcement OFF: orphan
 * rows inserted silently while `REFERENCES ... ON DELETE CASCADE` in the
 * schema did nothing.
 *
 * These tests pin the fix: every library-opened sqlite connection gets
 * `DEFAULT_SQLITE_PRAGMAS` (WAL + foreign_keys=ON + busy_timeout), the list
 * is overridable via `config.sqlite.pragmas`, and caller-supplied Database
 * instances are left untouched.
 */

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, it } from 'bun:test'
import { config, setConfig } from '../src/config'
import { createQueryBuilder, resetConnection } from '../src/index'
import { configureOrm, createModel, getDatabase } from '../src/orm'
import { DEFAULT_SQLITE_PRAGMAS } from '../src/sqlite-pragmas'

// Config is process-wide; restore whatever sibling test files rely on.
const originalDialect = config.dialect
const originalDatabase = { ...config.database }
const originalSqlite = config.sqlite

afterAll(() => {
  setConfig({ dialect: originalDialect, database: originalDatabase, sqlite: originalSqlite } as any)
  resetConnection()
})

describe('DEFAULT_SQLITE_PRAGMAS', () => {
  it('includes FK enforcement, WAL, and a busy timeout', () => {
    expect(DEFAULT_SQLITE_PRAGMAS).toContain('PRAGMA foreign_keys = ON')
    expect(DEFAULT_SQLITE_PRAGMAS).toContain('PRAGMA journal_mode = WAL')
    expect(DEFAULT_SQLITE_PRAGMAS).toContain('PRAGMA busy_timeout = 5000')
  })
})

describe('query-builder connection (SQLiteWrapper)', () => {
  it('bootstraps foreign_keys and busy_timeout, not just WAL', async () => {
    setConfig({ dialect: 'sqlite', database: { database: ':memory:' } } as any)
    resetConnection()
    const qb = createQueryBuilder() as any
    expect(await qb.unsafe('PRAGMA foreign_keys').execute()).toEqual([{ foreign_keys: 1 }])
    expect(await qb.unsafe('PRAGMA busy_timeout').execute()).toEqual([{ timeout: 5000 }])
  })

  it('honors a config.sqlite.pragmas override (replaces the defaults)', async () => {
    setConfig({
      dialect: 'sqlite',
      database: { database: ':memory:' },
      sqlite: { pragmas: ['PRAGMA busy_timeout = 1234'] },
    } as any)
    resetConnection()
    const qb = createQueryBuilder() as any
    expect(await qb.unsafe('PRAGMA busy_timeout').execute()).toEqual([{ timeout: 1234 }])
    // The override REPLACES the defaults — foreign_keys stays at sqlite's
    // default (off) because the custom list doesn't set it.
    expect(await qb.unsafe('PRAGMA foreign_keys').execute()).toEqual([{ foreign_keys: 0 }])
    // Restore defaults for the rest of the file.
    setConfig({ dialect: 'sqlite', database: { database: ':memory:' }, sqlite: undefined } as any)
    resetConnection()
  })
})

describe('model-executor connection (configureOrm/getExecutor)', () => {
  it('bootstraps the Database configureOrm creates', () => {
    configureOrm({ database: ':memory:' })
    const raw = getDatabase()
    expect(raw.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(raw.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  })

  it('enforces FKs on the real model write path (Model.create → executor)', async () => {
    configureOrm({ database: ':memory:' })
    const raw = getDatabase()
    raw.run('CREATE TABLE bp_parents (id INTEGER PRIMARY KEY)')
    raw.run('CREATE TABLE bp_children (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES bp_parents(id) ON DELETE CASCADE)')

    const Child = createModel({
      name: 'BPChild',
      table: 'bp_children',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: {
        parent_id: { type: 'number', fillable: true },
      },
    } as const)

    // No explicit `id` — save() treats a set primary key as "row exists"
    // and takes its UPDATE branch; only the autoincrement path exercises
    // the INSERT that real Model.create() calls perform.
    //
    // Pre-fix this orphan insert succeeded silently: the executor's raw
    // Database had foreign_keys OFF regardless of the query-builder
    // connection's bootstrap.
    await expect(Child.create({ parent_id: 999 } as any)).rejects.toThrow(/FOREIGN KEY constraint failed/)

    raw.run('INSERT INTO bp_parents (id) VALUES (1)')
    await Child.create({ parent_id: 1 } as any)
    expect(raw.query('SELECT COUNT(*) AS count FROM bp_children').get()).toEqual({ count: 1 })

    // And the schema's ON DELETE CASCADE actually fires now.
    raw.run('DELETE FROM bp_parents WHERE id = 1')
    expect(raw.query('SELECT COUNT(*) AS count FROM bp_children').get()).toEqual({ count: 0 })
  })

  it('leaves a caller-supplied Database untouched (bring-your-own pragmas)', () => {
    const own = new Database(':memory:')
    expect(own.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
    configureOrm({ database: own })
    expect(getDatabase().query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
    own.close()
  })
})
