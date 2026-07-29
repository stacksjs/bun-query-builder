/**
 * What a rollback is allowed to destroy.
 *
 * Rolling back undoes a schema change and removes its record. It is not a
 * request to delete the migration — that file is committed history, it is what
 * every other machine replays, and getting it back means finding it in git.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { migrateRollback } from '../src/actions/migrate-rollback'
import { config, setConfig } from '../src/config'

let workspace: string
let migrationsDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any

const FILE = '0000000002-alter-widgets-columns.sql'

function seedDatabase(): void {
  const db = new Database(dbFile, { create: true })
  try {
    db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, migration TEXT NOT NULL UNIQUE, executed_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
    db.exec('DROP TABLE IF EXISTS widgets')
    db.exec('CREATE TABLE widgets ("id" INTEGER PRIMARY KEY, "colour" TEXT)')
    db.exec('DELETE FROM migrations')
    db.exec(`INSERT INTO migrations (migration) VALUES ('${FILE}')`)
  }
  finally { db.close() }
}

function widgetColumns(): string[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return (db.query(`PRAGMA table_info("widgets")`).all() as Array<{ name: string }>).map(c => c.name)
  }
  finally { db.close() }
}

function migrationRows(): unknown[] {
  const db = new Database(dbFile, { readonly: true })
  try { return db.query('SELECT migration FROM migrations').all() }
  finally { db.close() }
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-rollback-'))
  migrationsDir = join(workspace, 'database', 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
  dbFile = join(workspace, 'database', 'app.sqlite')
  // A package.json so the workspace-root walk stops here.
  writeFileSync(join(workspace, 'package.json'), '{"name":"rollback-fixture"}')
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
  writeFileSync(join(migrationsDir, FILE), 'ALTER TABLE "widgets" ADD COLUMN "colour" TEXT;\n')
  seedDatabase()
})

describe('migrateRollback', () => {
  it('reverses the schema and removes the record', async () => {
    await migrateRollback({ steps: 1 })

    expect(widgetColumns()).not.toContain('colour')
    expect(migrationRows()).toHaveLength(0)
  })

  it('leaves the migration file on disk', async () => {
    // Deleting it destroys committed history: the file is what every other
    // machine replays, and rolling back on one machine must not decide that
    // for the rest of them.
    await migrateRollback({ steps: 1 })

    expect(existsSync(join(migrationsDir, FILE))).toBe(true)
  })

  it('deletes the file only when explicitly asked to', async () => {
    await migrateRollback({ steps: 1, deleteFiles: true })

    expect(existsSync(join(migrationsDir, FILE))).toBe(false)
  })

  it('can be re-applied after a rollback, because the file survived', async () => {
    await migrateRollback({ steps: 1 })

    // The forward migration is still there to run again.
    const db = new Database(dbFile)
    try { db.exec('ALTER TABLE "widgets" ADD COLUMN "colour" TEXT') }
    finally { db.close() }

    expect(widgetColumns()).toContain('colour')
  })
})
