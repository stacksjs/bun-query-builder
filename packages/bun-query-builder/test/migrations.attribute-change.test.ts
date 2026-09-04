/**
 * Changing a model attribute after it has been migrated.
 *
 * The migration corpus is not a log of what one machine happened to do — it is
 * the schema, replayable from empty on a machine that has never seen this
 * database. So every attribute change has to leave a migration behind that a
 * second machine can run, and running the corpus twice must not blow up.
 *
 * These tests exercise that from both ends: the machine where the change was
 * made, and a fresh database with nothing but the committed files.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { executeMigration, generateMigration } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'

let workspace: string
let modelsDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any
let dbCounter = 0

function writeModel(attributes: string): void {
  writeFileSync(join(modelsDir, 'Widget.ts'), `export default {
  name: 'Widget',
  table: 'widgets',
  primaryKey: 'id',
  attributes: { ${attributes} },
}
`)
}

function migrationsDir(): string {
  return join(workspace, 'database', 'migrations')
}

function migrationFiles(): string[] {
  try { return readdirSync(migrationsDir()).filter(f => f.endsWith('.sql')).sort() }
  catch { return [] }
}

/** Point the builder at a different database file — a machine that has never seen this schema. */
function useFreshDatabase(): string {
  dbCounter += 1
  const fresh = join(workspace, 'database', `fresh-${dbCounter}.sqlite`)
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: fresh } })
  return fresh
}

function useOriginalDatabase(): void {
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
}

function columnsOf(file: string, table: string): string[] {
  if (!existsSync(file))
    return []
  const db = new Database(file, { readonly: true })
  try {
    return (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name)
  }
  finally { db.close() }
}

/** Drop the snapshot, the way a fresh checkout or a cleared cache does. */
function removeSnapshot(): void {
  rmSync(join(workspace, '.qb'), { recursive: true, force: true })
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'qb-attr-change-'))
  modelsDir = join(workspace, 'models')
  mkdirSync(modelsDir, { recursive: true })
  mkdirSync(join(workspace, 'database'), { recursive: true })
  dbFile = join(workspace, 'database', 'app.sqlite')
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

describe('an attribute added after the table was migrated', () => {
  beforeAll(async () => {
    useOriginalDatabase()
    writeModel(`name: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })
    await executeMigration()
  })

  it('writes a migration for the change', async () => {
    const before = migrationFiles()
    writeModel(`name: { validation: { rule: {} } }, colour: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })

    const added = migrationFiles().filter(f => !before.includes(f))
    expect(added).toHaveLength(1)
    expect(readFileSync(join(migrationsDir(), added[0]), 'utf8')).toContain('colour')
  })

  it('applies it to the database it was generated on', async () => {
    await executeMigration()
    expect(columnsOf(dbFile, 'widgets')).toContain('colour')
  })

  it('KEEPS that migration on disk — it is the only record of the change', () => {
    // A generated ALTER used to be deleted the moment it ran, which left the
    // corpus describing the ORIGINAL table and nothing else.
    const altering = migrationFiles().filter(f => readFileSync(join(migrationsDir(), f), 'utf8').includes('colour'))
    expect(altering.length).toBeGreaterThan(0)
  })

  it('replays onto a database that has never seen this schema', async () => {
    // The point of the whole corpus: a teammate clones, migrates, and gets the
    // same table. If the ALTER is not in the files, they get yesterday's table.
    const fresh = useFreshDatabase()
    await executeMigration()
    useOriginalDatabase()

    expect(columnsOf(fresh, 'widgets')).toContain('name')
    expect(columnsOf(fresh, 'widgets')).toContain('colour')
  })

  it('does not re-run on the machine that already applied it', async () => {
    const before = migrationFiles()
    await executeMigration()

    // Recorded, so it is not replayed — replaying an ADD COLUMN is the
    // `duplicate column name` failure that takes the whole run down.
    expect(migrationFiles()).toEqual(before)
    expect(columnsOf(dbFile, 'widgets')).toContain('colour')
  })

  it('does not write a second migration when nothing changed', async () => {
    const before = migrationFiles()
    await generateMigration(modelsDir, { dialect: 'sqlite' })
    expect(migrationFiles()).toEqual(before)
  })
})

describe('a series of changes, each landing its own migration', () => {
  it('adds one migration per change, and they stack in order', async () => {
    useOriginalDatabase()
    const start = migrationFiles().length

    writeModel(`name: { validation: { rule: {} } }, colour: { validation: { rule: {} } }, size: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })
    await executeMigration()

    writeModel(`name: { validation: { rule: {} } }, colour: { validation: { rule: {} } }, size: { validation: { rule: {} } }, weight: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })
    await executeMigration()

    expect(migrationFiles().length).toBe(start + 2)

    const fresh = useFreshDatabase()
    await executeMigration()
    useOriginalDatabase()

    const columns = columnsOf(fresh, 'widgets')
    expect(columns).toContain('colour')
    expect(columns).toContain('size')
    expect(columns).toContain('weight')
  })
})

describe('two changes migrated inside the same second', () => {
  it('gives each its own file instead of overwriting one with the other', async () => {
    useOriginalDatabase()
    const start = migrationFiles().length

    // No waiting between them: the sequence is `unix seconds + counter`, and
    // the counter resets per run, so both used to land on the same filename.
    writeModel(`name: { validation: { rule: {} } }, colour: { validation: { rule: {} } }, size: { validation: { rule: {} } }, weight: { validation: { rule: {} } }, finish: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })
    writeModel(`name: { validation: { rule: {} } }, colour: { validation: { rule: {} } }, size: { validation: { rule: {} } }, weight: { validation: { rule: {} } }, finish: { validation: { rule: {} } }, grade: { validation: { rule: {} } }`)
    await generateMigration(modelsDir, { dialect: 'sqlite' })

    expect(migrationFiles().length).toBe(start + 2)

    const bodies = migrationFiles().map(f => readFileSync(join(migrationsDir(), f), 'utf8')).join('\n')
    expect(bodies).toContain('finish')
    expect(bodies).toContain('grade')
  })

  it('runs both, on this machine and on a fresh one', async () => {
    await executeMigration()
    expect(columnsOf(dbFile, 'widgets')).toContain('finish')
    expect(columnsOf(dbFile, 'widgets')).toContain('grade')

    const fresh = useFreshDatabase()
    await executeMigration()
    useOriginalDatabase()

    const columns = columnsOf(fresh, 'widgets')
    expect(columns).toContain('finish')
    expect(columns).toContain('grade')
  })

  it('keeps the corpus in the order the changes were made', () => {
    // Files run in filename order, so an ALTER must never sort before the
    // CREATE TABLE it depends on.
    const files = migrationFiles()
    const create = files.findIndex(f => f.includes('create-widgets-table'))
    const alters = files.map((f, i) => ({ f, i })).filter(x => x.f.includes('alter-'))
    expect(create).toBe(0)
    for (const alter of alters)
      expect(alter.i).toBeGreaterThan(create)
  })
})

describe('a migration applied but never recorded', () => {
  it('records a generated migration whose change is already in place', async () => {
    // The state a crash between "applied" and "recorded" leaves behind, and
    // the state every corpus written under the old transient behaviour is in.
    useOriginalDatabase()
    const orphan = join(migrationsDir(), '9500000001-alter-widgets-table.sql')
    writeFileSync(orphan, `-- qb:generated\nALTER TABLE widgets ADD COLUMN colour TEXT;\n`)

    // `colour` is already on the table, so this SQL cannot succeed.
    await executeMigration()

    expect(existsSync(orphan)).toBe(true)
    expect(columnsOf(dbFile, 'widgets')).toContain('colour')
  })

  it('does not swallow a real failure in an authored migration', async () => {
    const broken = join(migrationsDir(), '9500000002-add-broken.sql')
    writeFileSync(broken, 'ALTER TABLE no_such_table ADD COLUMN whatever TEXT;\n')

    // A real error, and an authored file: it must surface rather than be
    // recorded away. Only an unambiguous "already exists" is forgiven, and
    // only for a migration the generator wrote.
    let threw = false
    try { await executeMigration() }
    catch { threw = true }
    finally { rmSync(broken, { force: true }) }

    expect(threw).toBe(true)
  })
})

describe('the snapshot going missing does not duplicate work', () => {
  it('does not write a second copy of a migration the corpus already has', async () => {
    useOriginalDatabase()
    const before = migrationFiles()

    // A fresh checkout: models and migrations committed, snapshot not.
    removeSnapshot()
    await generateMigration(modelsDir, { dialect: 'sqlite' })

    // The diff recomputes changes that are already in the corpus. Writing them
    // again would apply the same ALTER twice on the next machine.
    expect(migrationFiles()).toEqual(before)
  })

  it('leaves the database untouched and still replayable afterwards', async () => {
    await executeMigration()
    expect(columnsOf(dbFile, 'widgets')).toContain('weight')

    const fresh = useFreshDatabase()
    await executeMigration()
    useOriginalDatabase()
    expect(columnsOf(fresh, 'widgets')).toContain('weight')
  })
})
