/**
 * Rendering SQL is pure; writing migration files is an explicit step.
 *
 * `generateSql` / `generateSqlString` / `generateDiffOperations` used to write
 * one migration file per table as a side effect of being asked for SQL. A
 * caller that only wanted to look at the statements — a preview, a test
 * fixture, a function literally named `...String` — found
 * `0000000001-create-orders-table.sql` in whatever directory it was run from,
 * and the next real `migrate` applied it.
 *
 * Files are now written only with `write: true`, which `generateMigration`
 * passes for a non-preview run.
 */
import type { MigrationPlan } from '../src/migrations'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { generateMigration } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import {
  generateDiffOperations,
  generateDiffSqlString,
  generateSql,
  generateSqlString,
  GENERATED_MARKER,
  lastCreatedMigrationFiles,
} from '../src/migrations'

let workspace: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any

const migrationsDir = (): string => join(workspace, 'database', 'migrations')
const migrationFiles = (): string[] => existsSync(migrationsDir()) ? readdirSync(migrationsDir()).filter(f => f.endsWith('.sql')).sort() : []

function plan(columns: string[]): MigrationPlan {
  return {
    dialect: 'postgres',
    tables: [{
      table: 'orders',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        ...columns.map(name => ({ name, type: 'string' as const, isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false })),
      ],
      indexes: [],
    }],
  }
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-pure-render-'))
  writeFileSync(join(workspace, 'package.json'), '{"name":"pure-render-fixture"}')
  process.chdir(workspace)
  prevDatabase = config.database
  prevDialect = config.dialect
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

describe('SQL renderers write nothing', () => {
  it('generateSqlString returns the SQL and leaves the disk alone', () => {
    const sql = generateSqlString(plan(['status']))
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "orders"')
    expect(existsSync(migrationsDir())).toBe(false)
  })

  it('generateSql is pure by default', () => {
    expect(generateSql(plan(['status'])).join('\n')).toContain('"status"')
    expect(migrationFiles()).toEqual([])
  })

  it('generateDiffOperations / generateDiffSqlString are pure by default, and still describe the files', () => {
    const diff = generateDiffOperations(plan(['status']), plan(['status', 'coach_id']))
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].name).toBe('alter-orders-table')
    expect(diff.files[0].sql).toContain('ADD COLUMN "coach_id"')
    expect(generateDiffSqlString(plan(['status']), plan(['status', 'note']))).toContain('"note"')
    expect(migrationFiles()).toEqual([])
  })

  it('a pure call does not disturb lastCreatedMigrationFiles', () => {
    const before = lastCreatedMigrationFiles()
    generateDiffOperations(plan([]), plan(['x']))
    expect(lastCreatedMigrationFiles()).toEqual(before)
  })
})

describe('writing is explicit', () => {
  it('generateSql({ write: true }) writes one marked file per table', () => {
    generateSql(plan(['status']), { write: true })
    const files = migrationFiles()
    expect(files).toEqual(['0000000001-create-orders-table.sql'])
    expect(readFileSync(join(migrationsDir(), files[0]), 'utf8').startsWith(GENERATED_MARKER)).toBe(true)
    expect(lastCreatedMigrationFiles()).toEqual(files)
  })

  it('dryRun still wins over write', () => {
    rmSync(migrationsDir(), { recursive: true, force: true })
    generateDiffOperations(plan(['status']), plan(['status', 'y']), { write: true, dryRun: true })
    expect(migrationFiles()).toEqual([])
  })

  it('generateDiffOperations({ write: true }) writes the alter file', () => {
    generateDiffOperations(plan(['status']), plan(['status', 'coach_id']), { write: true })
    const files = migrationFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-alter-orders-table\.sql$/)
    expect(lastCreatedMigrationFiles()).toEqual(files)
  })

  it('generateMigration still writes its files, and a dry run does not', async () => {
    rmSync(migrationsDir(), { recursive: true, force: true })
    const modelsDir = join(workspace, 'models')
    mkdirSync(modelsDir, { recursive: true })
    writeFileSync(join(modelsDir, 'Order.ts'), `export default {
  name: 'Order',
  table: 'orders',
  attributes: { status: { validation: { rule: {} } } },
}
`)
    setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: join(workspace, 'app.sqlite') } })

    await generateMigration(modelsDir, { dialect: 'sqlite', dryRun: true })
    expect(migrationFiles()).toEqual([])

    await generateMigration(modelsDir, { dialect: 'sqlite' })
    expect(migrationFiles().some(f => f.endsWith('-create-orders-table.sql'))).toBe(true)
  })
})
