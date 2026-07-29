/**
 * The full lifecycle of a database that carries BOTH kinds of schema:
 * model-driven columns the generator owns, and hand-written columns a person
 * added in a migration of their own.
 *
 * Each step runs the real `generateMigration` against a real SQLite file with
 * real rows in it, in the order an app actually hits them: create, hand-edit,
 * reconcile with no snapshot, migrate again with a snapshot, add an attribute,
 * change a type, remove an attribute. What must hold at every step is that the
 * hand-written column and its data are still there, and that the model-driven
 * half still migrates normally.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { executeMigration, generateMigration } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { GENERATED_MARKER, isGeneratedMigrationSql } from '../src/migrations'

let workspace: string
let modelsDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any

/** Write the Farm model with whatever attributes this step declares. */
function writeFarmModel(attributes: string, extra = ''): void {
  writeFileSync(join(modelsDir, 'Farm.ts'), `export default {
  name: 'Farm',
  table: 'farms',
  primaryKey: 'id',
  belongsTo: ['User'],
  ${extra}
  attributes: { ${attributes} },
}
`)
}

/** Run the generator the way a CLI does: apply the SQL to the live database. */
async function migrate(opts: { fromDb?: boolean } = {}): Promise<{ sql: string, ops: any[] }> {
  const res = await generateMigration(modelsDir, { dialect: 'sqlite', apply: true, ...opts })
  return { sql: (res.sqlStatements ?? []).join('\n'), ops: res.operations ?? [] }
}

function columnsOf(table: string): string[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name)
  }
  finally { db.close() }
}

function rows(sql: string): any[] {
  const db = new Database(dbFile, { readonly: true })
  try { return db.query(sql).all() as any[] }
  finally { db.close() }
}

function exec(...statements: string[]): void {
  const db = new Database(dbFile, { create: true })
  try {
    for (const s of statements) db.exec(s)
  }
  finally { db.close() }
}

/** Delete the model snapshot, the way a fresh checkout or a wiped cache does. */
function removeSnapshot(): void {
  rmSync(join(workspace, '.qb'), { recursive: true, force: true })
  rmSync(join(workspace, 'database', 'model-snapshot.sqlite.json'), { force: true })
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-lifecycle-'))
  modelsDir = join(workspace, 'models')
  mkdirSync(modelsDir, { recursive: true })
  mkdirSync(join(workspace, 'database'), { recursive: true })
  dbFile = join(workspace, 'database', 'app.sqlite')
  process.chdir(workspace)

  prevDatabase = config.database
  prevDialect = config.dialect
  // `setConfig` rather than assignment: `generateMigration` awaits
  // `getConfig()`, which loads the config file over anything not marked
  // explicit — a bare assignment gets clobbered and the run silently targets
  // the default database instead of this workspace's.
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

describe('hand-written and model-driven migrations, on one database', () => {
  it('1. creates the table from the models, foreign key column included', async () => {
    writeFarmModel(`name: { validation: { rule: {} } }`)
    await migrate()

    const columns = columnsOf('farms')
    expect(columns).toContain('name')
    // From `belongsTo: ['User']`, with no User model in the directory: the
    // column still has to exist, because the ORM writes it.
    expect(columns).toContain('user_id')
  })

  it('2. keeps a hand-written column when the schema is reconciled without a snapshot', async () => {
    exec(
      'ALTER TABLE farms ADD COLUMN legacy_note TEXT',
      `INSERT INTO farms (id, name, legacy_note) VALUES (1, 'Lindenbach', 'added by hand')`,
    )
    // The state a fresh checkout is in: database ahead of the snapshot.
    removeSnapshot()

    const { sql, ops } = await migrate()

    expect(ops.some(o => o.kind === 'drop_column')).toBe(false)
    expect(sql).not.toContain('DROP COLUMN')
    expect(columnsOf('farms')).toContain('legacy_note')
    expect(rows('SELECT legacy_note FROM farms WHERE id = 1')[0].legacy_note).toBe('added by hand')
  })

  it('3. keeps it on the next run, now that a snapshot exists', async () => {
    const { ops } = await migrate()

    expect(ops.some(o => o.kind === 'drop_column')).toBe(false)
    expect(columnsOf('farms')).toContain('legacy_note')
  })

  it('4. adds a newly declared attribute alongside it', async () => {
    writeFarmModel(`name: { validation: { rule: {} } }, region: { validation: { rule: {} } }`)
    await migrate()

    const columns = columnsOf('farms')
    expect(columns).toContain('region')
    expect(columns).toContain('legacy_note')
    expect(rows('SELECT legacy_note FROM farms WHERE id = 1')[0].legacy_note).toBe('added by hand')
  })

  it('5. survives a table rebuild caused by an unrelated type change', async () => {
    // A rebuild recreates the table from the target plan — the one place a
    // preserved column can vanish without any drop operation being emitted.
    removeSnapshot()
    writeFarmModel(`name: { validation: { rule: {} } }, region: { validation: { rule: {} } }, hectares: { validation: { rule: {} } }`)
    await migrate()
    exec('UPDATE farms SET region = \'Niederbayern\' WHERE id = 1')

    removeSnapshot()
    await migrate()

    const columns = columnsOf('farms')
    expect(columns).toContain('legacy_note')
    const row = rows('SELECT legacy_note, region FROM farms WHERE id = 1')[0]
    expect(row.legacy_note).toBe('added by hand')
    expect(row.region).toBe('Niederbayern')
  })

  it('6. still drops a column when an attribute is removed and a snapshot proves it', async () => {
    // The other half of the contract: preservation must not turn into a
    // freeze. With a snapshot in hand, a removed attribute is a real removal.
    await migrate() // ensure the snapshot matches the current models
    writeFarmModel(`name: { validation: { rule: {} } }, hectares: { validation: { rule: {} } }`)

    const { ops } = await migrate()

    expect(ops.some(o => o.kind === 'drop_column' && o.column === 'region')).toBe(true)
    expect(columnsOf('farms')).not.toContain('region')
    // ...and the hand-written column is still not collateral.
    expect(columnsOf('farms')).toContain('legacy_note')
    expect(rows('SELECT legacy_note FROM farms WHERE id = 1')[0].legacy_note).toBe('added by hand')
  })

  it('7. leaves the database usable: every row survived the whole sequence', () => {
    const row = rows('SELECT id, name, legacy_note FROM farms WHERE id = 1')[0]
    expect(row.id).toBe(1)
    expect(row.name).toBe('Lindenbach')
    expect(row.legacy_note).toBe('added by hand')
  })

  it('8. wrote migration files rather than only touching the database', () => {
    // The generated corpus is what a second machine replays, so it has to
    // exist on disk, not just in the applied database.
    expect(existsSync(join(workspace, 'database', 'migrations'))).toBe(true)
  })
})

describe('the runner tells authored migrations from generated ones', () => {
  const migrationsDir = (): string => join(workspace, 'database', 'migrations')

  it('stamps every generated file with its provenance', async () => {
    writeFarmModel(`name: { validation: { rule: {} } }, hectares: { validation: { rule: {} } }, tenure: { validation: { rule: {} } }`)
    await migrate()

    const generated = readdirSync(migrationsDir()).filter(f => f.endsWith('.sql'))
    expect(generated.length).toBeGreaterThan(0)
    for (const file of generated) {
      const sql = readFileSync(join(migrationsDir(), file), 'utf8')
      expect(isGeneratedMigrationSql(sql)).toBe(true)
    }
  })

  it('runs an authored migration once, records it, and leaves it on disk', async () => {
    // Named exactly like a generated ALTER, which is what a person would
    // naturally call it — and what used to get their file deleted.
    const authored = join(migrationsDir(), '9000000001-alter-farms-table.sql')
    writeFileSync(authored, 'ALTER TABLE farms ADD COLUMN steward TEXT;\n')

    await executeMigration(modelsDir)

    expect(existsSync(authored)).toBe(true)
    expect(columnsOf('farms')).toContain('steward')
    expect(rows(`SELECT migration FROM migrations WHERE migration = '9000000001-alter-farms-table.sql'`)).toHaveLength(1)
  })

  it('does not replay it on the next run, so it cannot fail as a duplicate', async () => {
    // Recorded means run-once. Replaying an ADD COLUMN is the `duplicate
    // column name` failure that takes a whole migrate run down with it.
    await executeMigration(modelsDir)

    expect(existsSync(join(migrationsDir(), '9000000001-alter-farms-table.sql'))).toBe(true)
    expect(columnsOf('farms')).toContain('steward')
  })

  it('keeps and records a generated ALTER too — it is the record of a schema change', async () => {
    // Generated ALTERs used to be transient: replayed rather than recorded,
    // then deleted once applied. That made the corpus a log of one machine's
    // session, so a change made here never reached anybody else's database.
    const generated = join(migrationsDir(), '9000000002-alter-farms-table.sql')
    writeFileSync(generated, `${GENERATED_MARKER}\nALTER TABLE farms ADD COLUMN drainage TEXT;\n`)

    await executeMigration(modelsDir)

    expect(existsSync(generated)).toBe(true)
    expect(columnsOf('farms')).toContain('drainage')
    expect(rows(`SELECT migration FROM migrations WHERE migration = '9000000002-alter-farms-table.sql'`)).toHaveLength(1)
  })
})
