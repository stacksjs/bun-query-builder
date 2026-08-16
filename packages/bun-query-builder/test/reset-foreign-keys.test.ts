import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDatabase } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

const original = { dialect: config.dialect, database: { ...config.database } }
const workspaces: string[] = []

afterEach(() => {
  setConfig(original as any)
  resetConnection()
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true })
})

describe('resetDatabase foreign-key teardown', () => {
  it('drops parent and child tables even when plan order reaches the parent first', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bqb-fk-reset-'))
    workspaces.push(workspace)
    const modelsDir = join(workspace, 'app', 'Models')
    mkdirSync(modelsDir, { recursive: true })
    mkdirSync(join(workspace, 'database', 'migrations'), { recursive: true })
    writeFileSync(join(modelsDir, 'AChild.ts'), `export default { name: 'Child', table: 'children', belongsTo: ['Parent'], attributes: {} }`)
    writeFileSync(join(modelsDir, 'ZParent.ts'), `export default { name: 'Parent', table: 'parents', attributes: {} }`)

    const dbFile = join(workspace, 'database', 'test.sqlite')
    const sqlite = new Database(dbFile)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    sqlite.exec('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))')
    sqlite.exec('INSERT INTO parents (id) VALUES (1)')
    sqlite.exec('INSERT INTO children (id, parent_id) VALUES (1, 1)')
    sqlite.close()

    const originalCwd = process.cwd()
    process.chdir(workspace)
    setConfig({ dialect: 'sqlite', database: { database: dbFile }, verbose: false } as any)
    resetConnection()
    try {
      expect(await resetDatabase(modelsDir, { dialect: 'sqlite' })).toBeTrue()
      const check = new Database(dbFile, { readonly: true })
      const tables = check.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('parents', 'children')").all()
      check.close()
      expect(tables).toEqual([])
    }
    finally {
      process.chdir(originalCwd)
    }
  })

  it('preserves the migration corpus and snapshot for framework fresh replay', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bqb-preserve-migrations-'))
    workspaces.push(workspace)
    const modelsDir = join(workspace, 'app', 'Models')
    const migrationsDir = join(workspace, 'database', 'migrations')
    const snapshotDir = join(workspace, '.qb')
    mkdirSync(modelsDir, { recursive: true })
    mkdirSync(migrationsDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(modelsDir, 'Widget.ts'), `export default { name: 'Widget', table: 'widgets', attributes: {} }`)
    const migration = join(migrationsDir, '0000000001-create-widgets-table.sql')
    const snapshot = join(snapshotDir, 'model-snapshot.sqlite.json')
    writeFileSync(migration, '-- qb:generated\nCREATE TABLE widgets (id INTEGER PRIMARY KEY);')
    writeFileSync(snapshot, JSON.stringify({ version: 1, dialect: 'sqlite', hash: 'test', plan: { dialect: 'sqlite', tables: [] } }))

    const dbFile = join(workspace, 'database', 'test.sqlite')
    const sqlite = new Database(dbFile)
    sqlite.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)')
    sqlite.close()

    const originalCwd = process.cwd()
    process.chdir(workspace)
    setConfig({ dialect: 'sqlite', database: { database: dbFile }, migrationDir: 'database/migrations', snapshotDir: '.qb', verbose: false } as any)
    resetConnection()
    try {
      expect(await resetDatabase(modelsDir, { dialect: 'sqlite', preserveMigrationState: true })).toBeTrue()
      expect(existsSync(migration)).toBeTrue()
      expect(existsSync(snapshot)).toBeTrue()
    }
    finally {
      process.chdir(originalCwd)
    }
  })
})
