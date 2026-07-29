/**
 * `migrate:status` has one job: say which migrations have run.
 *
 * It used to answer that from the FILENAME for anything matching
 * `alter-*-table`, reporting it as "transient — not tracked" whether or not it
 * had run, because generated ALTERs were once replayed rather than recorded.
 * They are recorded now, and a status command that contradicts the ledger it
 * is reporting on is worse than no status command.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { migrateStatus } from '../src/actions/migrate-status'
import { config, setConfig } from '../src/config'

let workspace: string
let migrationsDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-status-'))
  migrationsDir = join(workspace, 'database', 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
  dbFile = join(workspace, 'database', 'app.sqlite')
  writeFileSync(join(workspace, 'package.json'), '{"name":"status-fixture"}')
  process.chdir(workspace)

  prevDatabase = config.database
  prevDialect = config.dialect
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of ['0000000001-create-widgets-table.sql', '0000000002-alter-widgets-table.sql', '0000000003-alter-widgets-columns.sql'])
    writeFileSync(join(migrationsDir, f), 'SELECT 1;\n')

  const db = new Database(dbFile, { create: true })
  try {
    db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, migration TEXT NOT NULL UNIQUE, executed_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
    db.exec('DELETE FROM migrations')
    db.exec(`INSERT INTO migrations (migration) VALUES ('0000000001-create-widgets-table.sql')`)
    db.exec(`INSERT INTO migrations (migration) VALUES ('0000000002-alter-widgets-table.sql')`)
  }
  finally { db.close() }
})

describe('migrateStatus', () => {
  it('reports an executed ALTER as executed, not as untracked', async () => {
    const statuses = await migrateStatus()
    const altered = statuses.find(s => s.file === '0000000002-alter-widgets-table.sql')

    expect(altered?.status).toBe('executed')
    expect(altered?.executedAt).toBeTruthy()
  })

  it('reports an ALTER that has not run as pending', async () => {
    const statuses = await migrateStatus()
    expect(statuses.find(s => s.file === '0000000003-alter-widgets-columns.sql')?.status).toBe('pending')
  })

  it('agrees with the ledger for every file', async () => {
    const statuses = await migrateStatus()
    expect(statuses.map(s => `${s.file}:${s.status}`)).toEqual([
      '0000000001-create-widgets-table.sql:executed',
      '0000000002-alter-widgets-table.sql:executed',
      '0000000003-alter-widgets-columns.sql:pending',
    ])
  })
})
