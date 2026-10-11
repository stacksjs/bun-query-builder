/**
 * `generateMigration({ fromDb: true })` diffs against the live database even
 * when a model snapshot exists.
 *
 * It used to be honoured only when there was NO snapshot. With one present the
 * option was silently ignored and the diff compared models against the
 * snapshot — which is exactly the comparison that cannot see a database that
 * drifted. A table created by an older `CREATE TABLE IF NOT EXISTS` with fewer
 * columns stayed that way, and `--from-db` reported nothing to do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { generateMigration, saveMigrationSnapshot } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { buildMigrationPlan } from '../src/migrations'

let workspace: string
let modelsDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any

const model = {
  name: 'Order',
  table: 'orders',
  attributes: {
    status: { validation: { rule: {} } },
    coachId: { type: 'bigint', foreignKey: false, validation: { rule: {} } },
    legacyNote: { validation: { rule: {} } },
  },
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-from-db-'))
  writeFileSync(join(workspace, 'package.json'), '{"name":"from-db-fixture"}')
  modelsDir = join(workspace, 'models')
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(modelsDir, 'Order.ts'), `export default ${JSON.stringify(model, null, 2)}\n`)
  dbFile = join(workspace, 'app.sqlite')
  process.chdir(workspace)

  prevDatabase = config.database
  prevDialect = config.dialect
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
  resetConnection()

  // The live table is the drifted, 3-column shape an earlier no-op
  // `CREATE TABLE IF NOT EXISTS` left behind; it also carries a column no
  // model declares, which a live diff must keep.
  const db = new Database(dbFile)
  db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, hand_added TEXT)')
  db.close()

  // ...while the snapshot already claims the models' full shape.
  saveMigrationSnapshot(buildMigrationPlan({ Order: model } as any, { dialect: 'sqlite' }), { dialect: 'sqlite', workspaceRoot: workspace })
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  resetConnection()
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

describe('generateMigration fromDb with a snapshot present', () => {
  it('without fromDb, the snapshot is the comparison and the drift is invisible', async () => {
    const result = await generateMigration(modelsDir, { dialect: 'sqlite', dryRun: true })
    expect(result.hasChanges).toBe(false)
  })

  it('with fromDb, the live schema is the comparison and the missing columns are added', async () => {
    const result = await generateMigration(modelsDir, { dialect: 'sqlite', dryRun: true, fromDb: true })
    expect(result.hasChanges).toBe(true)
    expect(result.sql).toContain('ADD COLUMN "coach_id"')
    expect(result.sql).toContain('ADD COLUMN "legacy_note"')
    // Only what is missing: the table is not recreated.
    expect(result.sql).not.toMatch(/CREATE TABLE/i)
  })

  it('keeps live columns no model declares (preserveUnknownColumns semantics)', async () => {
    const result = await generateMigration(modelsDir, { dialect: 'sqlite', dryRun: true, fromDb: true })
    expect(result.sql).not.toContain('hand_added')
    expect(result.operations?.some(op => op.kind === 'drop_column' || op.kind === 'rebuild_table')).toBe(false)
  })
})
