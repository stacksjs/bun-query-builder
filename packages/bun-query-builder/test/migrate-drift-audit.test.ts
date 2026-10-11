/**
 * After applying migrations, the runner checks the live schema against the
 * models and says so when they disagree.
 *
 * The failure this catches is silent by construction. A generated
 * `CREATE TABLE IF NOT EXISTS orders (...)` applied to a database where
 * `orders` already exists in an older shape is a successful no-op: it is
 * recorded, the snapshot has already moved on, and the columns it would have
 * created are never added. That is how a local `orders` ended up a 4-column
 * table without `coach_id`, with every later diff agreeing there was nothing
 * to do.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { executeMigration, executeMigrationWithReport, saveMigrationSnapshot } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { buildMigrationPlan, GENERATED_MARKER, generateSqlFiles } from '../src/migrations'

const originalCwd = process.cwd()
const prevDatabase = config.database
const prevDialect = config.dialect
let workspace: string
let warn: ReturnType<typeof spyOn>

const models = {
  Order: {
    name: 'Order',
    table: 'orders',
    attributes: {
      status: { validation: { rule: {} } },
      coachId: { type: 'bigint', foreignKey: false, validation: { rule: {} } },
    },
  },
} as any

const plan = () => buildMigrationPlan(models, { dialect: 'sqlite' })

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'qb-drift-audit-'))
  writeFileSync(join(workspace, 'package.json'), '{"name":"drift-audit-fixture"}')
  process.chdir(workspace)
  const dbFile = join(workspace, 'app.sqlite')
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
  resetConnection()

  // The table already exists, in an older shape without coach_id...
  const db = new Database(dbFile)
  db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)')
  db.close()

  // ...the corpus holds the generated create for the models' shape...
  const dir = join(workspace, 'database', 'migrations')
  mkdirSync(dir, { recursive: true })
  const [create] = generateSqlFiles(plan()).files
  writeFileSync(join(dir, `0000000001-${create.name}.sql`), `${GENERATED_MARKER}\n${create.sql}`)

  // ...and the snapshot already says the models' shape exists.
  saveMigrationSnapshot(plan(), { dialect: 'sqlite', workspaceRoot: workspace })

  warn = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  resetConnection()
})

describe('the post-migration drift audit', () => {
  it('reports the column the no-op CREATE TABLE IF NOT EXISTS never added', async () => {
    const result = await executeMigrationWithReport()
    expect(result.ok).toBe(true)
    expect(result.executed).toEqual(['0000000001-create-orders-table.sql'])
    expect(result.drift?.clean).toBe(false)
    expect(result.drift?.missingColumns).toEqual([{ table: 'orders', column: 'coach_id', expected: 'integer' }])
    expect(result.drift?.missingTables).toEqual([])
  })

  it('warns on the console by default, without failing', async () => {
    expect(await executeMigration()).toBe(true)
    const printed = warn.mock.calls.map(args => String(args[0])).join('\n')
    expect(printed).toContain('orders.coach_id is missing')
  })

  it('fails in strict mode, after the migrations were applied', async () => {
    await expect(executeMigration(undefined, { strict: true })).rejects.toThrow(/orders\.coach_id is missing/)
    const db = new Database(join(workspace, 'app.sqlite'), { readonly: true })
    expect(db.query('SELECT migration FROM migrations').all()).toEqual([{ migration: '0000000001-create-orders-table.sql' }])
    db.close()
  })

  it('reports missing tables too', async () => {
    const withExtra = plan()
    withExtra.tables.push({ table: 'invoices', columns: [{ name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false }], indexes: [] })
    const result = await executeMigrationWithReport(undefined, { plan: withExtra })
    expect(result.drift?.missingTables).toEqual(['invoices'])
  })

  it('by default only audits a run that applied something; \'always\' audits every run', async () => {
    await executeMigrationWithReport()
    const idle = await executeMigrationWithReport()
    expect(idle.executed).toEqual([])
    expect(idle.drift).toBeUndefined()

    const always = await executeMigrationWithReport(undefined, { auditDrift: 'always' })
    expect(always.drift?.missingColumns.map(c => c.column)).toEqual(['coach_id'])
  })

  it('can be turned off', async () => {
    const result = await executeMigrationWithReport(undefined, { auditDrift: false })
    expect(result.drift).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is clean once the schema matches', async () => {
    const db = new Database(join(workspace, 'app.sqlite'))
    db.run('ALTER TABLE orders ADD COLUMN coach_id INTEGER')
    db.close()
    const result = await executeMigrationWithReport()
    expect(result.drift?.clean).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips the audit when there is no snapshot to compare with', async () => {
    rmSync(join(workspace, '.qb'), { recursive: true, force: true })
    const result = await executeMigrationWithReport(undefined, { strict: true })
    expect(result.drift).toBeUndefined()
  })
})
