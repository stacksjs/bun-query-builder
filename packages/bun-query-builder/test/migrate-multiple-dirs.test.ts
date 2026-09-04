/**
 * Running one migration corpus that lives in more than one directory.
 *
 * `executeMigration` declared a `dir` argument and then threw it away, always
 * enumerating `config.migrationDir` — so a caller could not point it anywhere
 * else, and a caller pointing it at the wrong place never found out. Honouring
 * the argument is the small half. The half that matters is a list: an
 * application's own migrations plus the ones each installed package ships,
 * where a package's tables carry foreign keys into the application's and never
 * the reverse.
 *
 * Running each directory in turn does not work, because the file name is the
 * ordinal and per-directory sorting loses the cross-directory order. These
 * tests pin the global ordering, and the two ways a multi-directory run can go
 * quietly wrong: a name that repeats across directories (the ledger keys on the
 * bare name, so one file would be recorded and the other silently skipped) and
 * a directory that is not there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { executeMigration } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'

let workspace: string
let appDir: string
let packageDir: string
let dbFile: string
let originalCwd: string
let prevDatabase: any
let prevDialect: any
let dbCounter = 0

/** The application's own corpus, at the configured `database/migrations`. */
const USERS = '0000000001-create-users.sql'
const USERS_SQL = 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "email" TEXT);\n'

/**
 * The application's, again — but ordered AFTER the package's file, and
 * depending on it. A run that sorts each directory separately reaches this one
 * while "posts" does not yet exist, and `ALTER TABLE` on a missing table fails
 * on every dialect including SQLite, which tolerates a dangling REFERENCES.
 */
const AUTHORS = '0000000003-add-author-to-posts.sql'
const AUTHORS_SQL = 'ALTER TABLE "posts" ADD COLUMN "author_id" INTEGER;\n'

/** The package's, ordered between the two application files. */
const POSTS = '0000000002-create-posts.sql'
const POSTS_SQL = 'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY, "user_id" INTEGER REFERENCES "users"("id"));\n'

/** Point the builder at a database file no migration has ever run against. */
function useFreshDatabase(): string {
  dbCounter += 1
  dbFile = join(workspace, 'database', `app-${dbCounter}.sqlite`)
  setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: dbFile } })
  return dbFile
}

/** Reads the database as it stands, treating "never created" as "nothing there". */
function read<T>(query: string): T[] {
  if (!existsSync(dbFile))
    return []

  const db = new Database(dbFile, { readonly: true })
  try { return db.query(query).all() as T[] }
  finally { db.close() }
}

function recorded(): string[] {
  return read<{ migration: string }>('SELECT migration FROM migrations ORDER BY id').map(row => row.migration)
}

function columnsOf(table: string): string[] {
  return read<{ name: string }>(`PRAGMA table_info("${table}")`).map(column => column.name)
}

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'qb-multi-dir-')))
  appDir = join(workspace, 'database', 'migrations')
  packageDir = join(workspace, 'node_modules', 'loghq', 'database', 'migrations')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(workspace, 'package.json'), '{"name":"multi-dir-fixture"}')
  process.chdir(workspace)

  prevDatabase = config.database
  prevDialect = config.dialect
})

afterAll(() => {
  setConfig({ dialect: prevDialect, database: prevDatabase })
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(appDir, { recursive: true, force: true })
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })
  mkdirSync(packageDir, { recursive: true })
  useFreshDatabase()
})

describe('executeMigration across several directories', () => {
  beforeEach(() => {
    writeFileSync(join(appDir, USERS), USERS_SQL)
    writeFileSync(join(appDir, AUTHORS), AUTHORS_SQL)
    writeFileSync(join(packageDir, POSTS), POSTS_SQL)
  })

  it('orders every file by name across all of them, not one directory at a time', async () => {
    await executeMigration([appDir, packageDir])

    expect(recorded()).toEqual([USERS, POSTS, AUTHORS])
    expect(columnsOf('posts')).toContain('author_id')
  })

  it('orders the same way whichever order the directories are given in', async () => {
    await executeMigration([packageDir, appDir])

    expect(recorded()).toEqual([USERS, POSTS, AUTHORS])
  })

  it('records the bare file name, whichever directory the file came from', async () => {
    await executeMigration([appDir, packageDir])

    expect(recorded()).not.toContain(join(packageDir, POSTS))
  })

  it('runs nothing on a second pass', async () => {
    await executeMigration([appDir, packageDir])
    await executeMigration([appDir, packageDir])

    expect(recorded()).toEqual([USERS, POSTS, AUTHORS])
  })

  it('refuses a directory that is not there rather than reporting an empty corpus', async () => {
    const missing = join(workspace, 'node_modules', 'not-installed', 'database', 'migrations')

    await expect(executeMigration([appDir, missing])).rejects.toThrow(/not found/i)
    expect(recorded()).toEqual([])
  })

  it('refuses a file name that repeats across directories', async () => {
    // The ledger keys on the bare name, so the second file would look already
    // executed and be skipped — a migration that never ran, on a run that
    // reported success.
    writeFileSync(join(packageDir, USERS), 'CREATE TABLE "loghq_users" ("id" INTEGER PRIMARY KEY);\n')

    await expect(executeMigration([appDir, packageDir])).rejects.toThrow(new RegExp(USERS))
    expect(recorded()).toEqual([])
  })

  it('refuses an empty list rather than guessing what it meant', async () => {
    await expect(executeMigration([])).rejects.toThrow(/empty list/i)
  })
})

describe('executeMigration with a single directory', () => {
  it('runs the directory it was given', async () => {
    writeFileSync(join(packageDir, POSTS), 'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY);\n')

    await executeMigration(packageDir)

    expect(recorded()).toEqual([POSTS])
  })

  it('resolves a relative directory against the workspace root', async () => {
    writeFileSync(join(packageDir, POSTS), 'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY);\n')

    await executeMigration('node_modules/loghq/database/migrations')

    expect(recorded()).toEqual([POSTS])
  })
})

describe('executeMigration with no argument', () => {
  it('still runs the configured migrationDir, so existing callers are unchanged', async () => {
    writeFileSync(join(appDir, USERS), USERS_SQL)
    writeFileSync(join(packageDir, POSTS), POSTS_SQL)

    await executeMigration()

    expect(recorded()).toEqual([USERS])
  })
})
