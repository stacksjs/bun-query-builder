import type { MigrationPlan } from '@/migrations'
import type { GenerateMigrationResult, MigrateOptions, SupportedDialect } from '@/types'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { config, getConfig } from '@/config'
import { withFreshConnection } from '@/db'
import { getDialectDriver } from '@/drivers'
import { buildMigrationPlan, createQueryBuilder, generateDiffOperations, generateSql, hashMigrationPlan, isGeneratedMigrationSql, lastCreatedMigrationFiles, loadModels } from '../index'
import { buildPlanFromDatabase } from './introspect-db'
import { findWorkspaceRoot, getSqlDirectory } from '@/workspace'

/**
 * Bring the corpus and the ledger in line with SQL that was just applied.
 *
 * `generateMigration({ apply: true })` writes migration files AND runs their
 * SQL, which leaves them waiting to be run a second time by the runner —
 * guaranteed `duplicate column name` on the very next `executeMigration`. So
 * the files it just executed are recorded here, exactly as the runner records
 * the ones it runs itself. They stay on disk: they are the schema, and the
 * next machine replays them from empty.
 *
 * Best-effort by design: the schema change has already landed, and failing the
 * whole call over bookkeeping would report a migration that did happen as one
 * that did not.
 */
async function settleAppliedFiles(qb: any, dialect: SupportedDialect, files: string[]): Promise<void> {
  if (files.length === 0)
    return

  const sqlDir = ensureSqlDirectory(getWorkspaceRoot())

  try {
    await createMigrationsTable(qb, dialect)
    for (const file of files) {
      await recordMigration(qb, file, dialect)
      info(`-- ✓ Recorded applied migration: ${file}`)
    }
  }
  catch (err) {
    info(`-- Could not record applied migrations (the schema change itself succeeded): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Whether a migration file was written by the generator rather than a person.
 *
 * Read from the marker in the file, never from its name: `alter-x-table.sql`
 * is an obvious name for somebody to give a hand-written migration, and
 * guessing from the name is how the runner used to delete their file. An
 * unreadable file counts as authored, which is the cautious reading.
 */
function isGeneratedMigration(filePath: string): boolean {
  try {
    return isGeneratedMigrationSql(readFileSync(filePath, 'utf8'))
  }
  catch {
    return false
  }
}

/**
 * Whether an error says the change this migration makes is already in place.
 *
 * Every supported dialect has its own wording for it — SQLite's `duplicate
 * column name`, MySQL's `Duplicate column name` / `Duplicate key name`,
 * Postgres's `already exists` (42701 / 42P07 / 42710). Deliberately narrow:
 * anything that is not an unambiguous "this already exists" is a real failure
 * and has to surface.
 */
function isAlreadyAppliedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /duplicate column name/i.test(message)
    || /duplicate key name/i.test(message)
    // MySQL for "that foreign key is already there". It has no
    // `ADD CONSTRAINT IF NOT EXISTS`, and a constraint created inline by a
    // `CREATE TABLE` is invisible to a snapshot written before this generator
    // emitted them that way - so a regeneration re-adds one that exists, and
    // the corpus stops on a change that is already made.
    || /duplicate foreign key constraint name/i.test(message)
    || /\balready exists\b/i.test(message)
}

/**
 * Informational stdout line — printed only when the active config has
 * `verbose: true`. Keeps the no-op `buddy migrate` (and any embedding
 * tool that doesn't want library chatter) quiet by default, while
 * preserving the verbose-CLI behaviour for `qb` directly. Errors and
 * `console.error` are intentionally NOT routed through this — they
 * always print so failures don't get swallowed.
 */
function info(message: string): void {
  if (config.verbose) console.log(message)
}

/**
 * Get the path to the model snapshot file for a given dialect.
 * This file stores the serialized migration plan from the last successful migration.
 */
function getSnapshotDir(workspaceRoot: string): string {
  // Configurable so an application can keep this with the rest of its
  // generated state rather than in a dot-directory at the project root.
  return join(workspaceRoot, config.snapshotDir || '.qb')
}

function getSnapshotPath(workspaceRoot: string, dialect: SupportedDialect): string {
  return join(getSnapshotDir(workspaceRoot), `model-snapshot.${dialect}.json`)
}

/**
 * Load the previous migration plan from the snapshot file.
 * Returns undefined if no snapshot exists or if the snapshot is invalid.
 */
function loadPlanSnapshot(workspaceRoot: string, dialect: SupportedDialect): MigrationPlan | undefined {
  const snapshotPath = getSnapshotPath(workspaceRoot, dialect)

  if (!existsSync(snapshotPath)) {
    return undefined
  }

  try {
    const raw = readFileSync(snapshotPath, 'utf8')
    const parsed = JSON.parse(raw)

    // Validate the snapshot structure
    if (parsed?.plan && Array.isArray(parsed.plan.tables) && parsed.plan.dialect) {
      return parsed.plan as MigrationPlan
    }

    // Legacy format support
    if (Array.isArray(parsed?.tables) && parsed?.dialect) {
      return parsed as MigrationPlan
    }

    info('-- Invalid snapshot format, treating as no previous state')
    return undefined
  }
  catch (err) {
    info(`-- Could not load snapshot, treating as no previous state: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * Save the current migration plan as a snapshot for future comparisons.
 * This is called after a successful migration generation.
 */
function savePlanSnapshot(workspaceRoot: string, dialect: SupportedDialect, plan: MigrationPlan): void {
  const snapshotPath = getSnapshotPath(workspaceRoot, dialect)
  const snapshotDir = getSnapshotDir(workspaceRoot)
  const hash = hashMigrationPlan(plan)

  // A no-op migration must also be a filesystem no-op. Keeping the existing
  // snapshot intact avoids timestamp-only diffs in every consuming project.
  if (existsSync(snapshotPath)) {
    try {
      const current = JSON.parse(readFileSync(snapshotPath, 'utf8'))
      if (current?.hash === hash && current?.dialect === dialect && current?.plan) {
        info('-- Model snapshot unchanged')
        return
      }
    }
    catch {
      // Invalid snapshots are replaced with the canonical format below.
    }
  }

  // Ensure the .qb directory exists
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true })
    info(`-- Created snapshot directory: ${snapshotDir}`)
  }

  const snapshot = {
    plan,
    hash,
    dialect,
    updatedAt: new Date().toISOString(),
  }

  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
  info(`-- Model snapshot saved to ${snapshotPath}`)
}

/**
 * Persist a plan returned by a dry-run migration after an embedding framework
 * has successfully written the SQL itself. This keeps preview semantics pure
 * while allowing a custom migration writer to advance the source-of-truth
 * snapshot only after its own persistence step succeeds.
 */
export function saveMigrationSnapshot(
  plan: MigrationPlan,
  options: { dialect?: SupportedDialect, workspaceRoot?: string } = {},
): void {
  const dialect = options.dialect ?? plan.dialect
  savePlanSnapshot(options.workspaceRoot ?? getWorkspaceRoot(), dialect, plan)
}

/**
 * Get workspace root.
 *
 * This used to be `process.cwd()` verbatim while every other command walked up
 * to the nearest package.json, so running `qb migrate` from a subdirectory
 * created an empty `<subdir>/database/migrations` and reported nothing to do,
 * while `migrate:status` in the same shell listed the real corpus.
 */
function getWorkspaceRoot(): string {
  return findWorkspaceRoot()
}

function ensureSqlDirectory(workspaceRoot?: string): string {
  const sqlDir = getSqlDirectory(workspaceRoot, config.migrationDir)
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    info(`-- Created SQL directory: ${sqlDir}`)
  }
  return sqlDir
}

/**
 * Generate migration files by comparing the stored model snapshot with current models.
 *
 * Workflow:
 * 1. Loads the previous migration plan from `.qb/model-snapshot.{dialect}.json`
 * 2. Loads current models from the source directory and builds a new migration plan
 * 3. Compares both plans to detect all changes:
 *    - Dropped tables, columns, indexes
 *    - New tables, columns, indexes
 *    - Modified columns (type changes, etc.)
 * 4. Generates SQL migration files for only the detected differences
 * 5. Saves the current plan as the new snapshot for future comparisons
 *
 * This follows Laravel's migration philosophy where model changes drive schema changes.
 * Simply update your models and run migrations - the system automatically figures out what changed.
 */
export async function generateMigration(dir?: string, opts: MigrateOptions = {}): Promise<GenerateMigrationResult> {
  // Load the config file before anything reads `snapshotDir`.
  //
  // `config` is a synchronous singleton of defaults plus whatever `setConfig`
  // supplied, and the file is only read by the async `getConfig()` - which is
  // deliberate, so a background load cannot race an early query. Migrations are
  // a CLI operation with no such race, and they DO need the file: a caller that
  // set `snapshotDir` in query-builder.config.ts otherwise had it ignored and
  // the snapshot written to `.qb`, no matter what the host framework
  // configured in its own process.
  await getConfig()

  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  const dialect = opts.dialect || config.dialect || 'postgres'

  // Get workspace root - always use current working directory
  const workspaceRoot = getWorkspaceRoot()

  // Load current models from source directory and build migration plan
  const models = await loadModels({ modelsDir: dir })
  const plan = buildMigrationPlan(models, { dialect, vitessSharded: opts.vitessSharded })

  let previous: MigrationPlan | undefined
  // True when `previous` is the live schema rather than a model snapshot.
  let reconciledFromDatabase = false

  if (!opts.full) {
    // Load previous state from the snapshot file (primary source)
    previous = loadPlanSnapshot(workspaceRoot, dialect)

    if (previous) {
      info('-- Comparing with stored model snapshot')
    }
    else {
      // Fallback: Try legacy state file location
      const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
      const statePath = String(opts.state || defaultStatePath)

      if (existsSync(statePath)) {
        try {
          const raw = readFileSync(statePath, 'utf8')
          const parsed = JSON.parse(raw)
          previous = parsed?.plan && parsed.plan.tables ? parsed.plan : (parsed?.tables ? parsed : undefined)
          if (previous) {
            info('-- Comparing with legacy state file (will migrate to new snapshot format)')
          }
        }
        catch {
          // ignore corrupt state; treat as no previous
        }
      }

      // Self-heal: with no snapshot (fresh checkout, lost/gitignored `.qb`,
      // or `--from-db`), reconcile against the LIVE database schema instead of
      // emitting a full create. This keeps `buddy migrate` correct even when
      // the snapshot is gone — the DB itself becomes the source of truth for
      // "what already exists". The diff's storage-type canonicalization keeps
      // the lossy reverse mapping from producing spurious ALTERs.
      if (!previous || opts.fromDb) {
        try {
          const livePlan = await buildPlanFromDatabase(dialect)
          // Only reconcile against tables the MODELS know about. The models
          // directory is frequently a subset of the database (framework tables,
          // other apps sharing the DB), and an introspected table absent from
          // the models must NOT be read as "drop this table" — it's simply
          // outside this migration's scope. Filtering to the model set keeps
          // self-heal from emitting destructive drops for unrelated tables.
          const modelTables = new Set(plan.tables.map(t => t.table))
          const scoped = livePlan.tables.filter(t => modelTables.has(t.table))
          if (scoped.length > 0) {
            previous = { dialect: livePlan.dialect, tables: scoped }
            // Everything in `previous` is now introspected rather than
            // declared. The diff has to know: a column the models don't
            // mention is evidence of nothing and must not be read as a
            // removal (see `preserveUnknownColumns`).
            reconciledFromDatabase = true
            info(`-- No snapshot; reconciling against live database (${scoped.length} matching table${scoped.length === 1 ? '' : 's'})`)
          }
        }
        catch (err) {
          info(`-- Could not introspect live database, treating as no previous state: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (!previous) {
        info('-- No previous snapshot found, generating full migration')
      }
    }
  }
  else {
    info('-- Full migration requested, ignoring any previous state')
  }

  const diff = opts.full
    ? { statements: generateSql(plan, { dryRun: opts.dryRun }), operations: plan.tables.map((t: MigrationPlan['tables'][number]) => ({ kind: 'create_table' as const, table: t.table, destructive: false, sql: '' })) }
    : generateDiffOperations(previous, plan, {
        applyRenames: opts.applyRenames,
        dryRun: opts.dryRun,
        preserveUnknownColumns: reconciledFromDatabase,
      })
  const sqlStatements = diff.statements
  const operations = diff.operations

  const sql = sqlStatements.join('\n')

  const hasChanges = sqlStatements.some(stmt => /\b(?:CREATE|ALTER|DROP)\b/i.test(stmt))

  if (opts.apply) {
    // Execute the generated SQL against the configured database.
    //
    // This used to write the statements to a temp file, log "Migration
    // applied" and return — the execution step was never there. Callers got a
    // success line, an untouched database, and a snapshot advanced as though
    // the schema had moved, which is the worst of the three: the next diff
    // compared against a state that had never been reached.
    const dirPath = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
    const filePath = join(dirPath, 'migration.sql')

    try {
      if (hasChanges) {
        // Via a file, so a multi-statement migration runs as one script the
        // way the migration corpus does, rather than as N parsed queries.
        writeFileSync(filePath, sql)
        const qb = createQueryBuilder()
        await qb.file(filePath)
        info('-- Migration applied')
        await settleAppliedFiles(qb, dialect, lastCreatedMigrationFiles())
      }
      else {
        info('-- No changes; nothing to apply')
      }
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      throw err
    }
    finally {
      rmSync(dirPath, { recursive: true, force: true })
    }
  }

  // Always save the current plan as a snapshot after generating migrations
  // (except on a dry-run preview, which must not advance state). This ensures
  // the next migration will only include new changes.
  if (!opts.dryRun)
    savePlanSnapshot(workspaceRoot, dialect, plan)

  return { sql, sqlStatements, hasChanges, plan, operations }
}

/**
 * The directories `executeMigration` should enumerate, in the order given.
 *
 * Omitting the argument means the configured corpus, and creates it when it is
 * missing — a fresh project has no `database/migrations` until something writes
 * one. Naming directories means exactly those: they are not created, and one
 * that does not exist is a caller error rather than an empty corpus, because
 * the alternative is a run that silently applies nothing and reports success.
 *
 * Relative paths resolve against the workspace root, the same root
 * `config.migrationDir` resolves against, so a caller does not have to know
 * which directory the process happens to have been started from.
 */
function resolveMigrationDirs(dirs: string | string[] | undefined, workspaceRoot: string): string[] {
  if (dirs === undefined)
    return [ensureSqlDirectory(workspaceRoot)]

  const named = Array.isArray(dirs) ? dirs : [dirs]

  // An empty list is refused rather than read as "the configured corpus" or as
  // "no corpus". Both readings are silent: the first ignores what the caller
  // asked for, the second skips every migration and exits zero. A caller that
  // means the configured default omits the argument.
  if (named.length === 0)
    throw new Error('executeMigration was given an empty list of directories. Pass at least one directory, or omit the argument to use the configured migrationDir.')

  return named.map(dir => (isAbsolute(dir) ? dir : join(workspaceRoot, dir)))
}

/**
 * The `.sql` corpus across every directory, in run order.
 *
 * Sorted globally by basename rather than per directory, because the basename
 * IS the ordinal: a package's tables carry foreign keys into the application's
 * and never the reverse, so sorting each directory separately and running them
 * back to back puts `REFERENCES "users"` before `users` exists. Postgres and
 * MySQL reject that; SQLite does not, so per-directory ordering fails on deploy
 * having passed locally.
 *
 * The ledger keys on the bare basename, so a basename cannot repeat across
 * directories. Left alone, the second file would look already-executed and be
 * skipped — a migration that never ran, on a run that reported success. It is
 * refused here instead, naming both paths.
 */
function collectMigrationFiles(dirs: string[]): Array<{ name: string, path: string }> {
  const byName = new Map<string, string>()

  for (const dir of dirs) {
    if (!existsSync(dir))
      throw new Error(`Migration directory not found: ${dir}`)

    for (const name of readdirSync(dir).filter(file => file.endsWith('.sql'))) {
      const claimed = byName.get(name)
      if (claimed !== undefined)
        throw new Error(`Duplicate migration file name across directories: "${name}" appears in both ${claimed} and ${join(dir, name)}. Migrations are recorded by file name, so names must be unique across every directory in a run.`)

      byName.set(name, join(dir, name))
    }
  }

  return [...byName]
    .map(([name, path]) => ({ name, path }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The advisory-lock name every migrate run contends on.
 *
 * Constant on purpose: two processes must pick the same key to serialise, and
 * migrations are global to a database rather than per-model or per-directory.
 */
const MIGRATION_LOCK_KEY = 'bun-query-builder:migrate'

/**
 * Statements that cannot run inside a transaction, so a file containing one
 * must be applied unwrapped.
 *
 * Postgres rejects `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY`
 * inside a transaction block outright, and `VACUUM` likewise — and building an
 * index concurrently is exactly what a migration on a live table SHOULD do, so
 * refusing to support it is not an option. Files that use them keep the old
 * unwrapped behaviour and say so, rather than failing on something they were
 * right to write.
 *
 * A file that opens its own transaction belongs here too. `SQLiteDriver
 * .rebuildTable` emits SQLite's own table-recreate recipe — `PRAGMA
 * foreign_keys=OFF`, `BEGIN`, build, copy, swap, `COMMIT`, `PRAGMA
 * foreign_keys=ON` — because the pragma is ignored inside a transaction and
 * has to bracket it. Wrapping that file raised `cannot start a transaction
 * within a transaction` and took the whole migration down, so any table whose
 * column type or constraint changed could never be migrated on SQLite.
 */
const NON_TRANSACTIONAL_SQL = /\bCONCURRENTLY\b|^\s*VACUUM\b|^\s*BEGIN\s*(?:;|TRANSACTION\b)|^\s*PRAGMA\s+foreign_keys\b/im

/**
 * Whether this dialect can roll a failed migration file back.
 *
 * Postgres has fully transactional DDL. SQLite does too, for the statements a
 * migration uses. MySQL does NOT: `CREATE TABLE`, `ALTER TABLE` and friends
 * force an implicit commit, so wrapping a file there produces a transaction
 * that silently commits mid-way and hands back false confidence — worse than
 * not wrapping, because it looks like it worked.
 */
function supportsTransactionalDdl(dialect: SupportedDialect): boolean {
  return dialect === 'postgres' || dialect === 'sqlite'
}

/**
 * Run `fn` while holding the migration advisory lock.
 *
 * Two processes booting at once — an ordinary rolling deploy — both read the
 * same pending set and both apply it. The lock makes the second wait for the
 * first, then find nothing pending.
 *
 * The lock is taken on a RESERVED connection and released on the same one.
 * That is not incidental: a Postgres session lock lives until it is released
 * or the session ends, and a pooled connection does not end when it goes back
 * to the pool. Taking it on a pooled builder would strand the lock on whatever
 * connection happened to serve the call, and the next migrate would wait
 * forever on a lock nobody meant to hold.
 *
 * SQLite has no advisory-lock primitive and a single-writer file, so it runs
 * unlocked rather than throwing.
 */
async function withMigrationLock<T>(dialect: SupportedDialect, fn: () => Promise<T>): Promise<T> {
  if (dialect === 'sqlite')
    return await fn()

  const qb = createQueryBuilder() as any
  let reserved: any
  try {
    reserved = await qb.reserve()
  }
  catch {
    // A driver that cannot reserve (or a mock) should not block migrating.
    return await fn()
  }

  let held = false
  try {
    await reserved.advisoryLock(MIGRATION_LOCK_KEY)
    held = true
    return await fn()
  }
  finally {
    try {
      if (held)
        await reserved.advisoryUnlock(MIGRATION_LOCK_KEY)
    }
    finally {
      reserved.release?.()
    }
  }
}

/**
 * Run every pending migration file, in order, and record each one.
 *
 * `dirs` is the corpus to run. Omit it for the configured `migrationDir`,
 * which is what the CLI and every caller inside this package do. Pass a
 * directory, or a list of them, to run a corpus assembled from more than one
 * place — an application's own migrations plus those shipped by each installed
 * package, say. Files from every directory are ordered together by file name,
 * so a package's migration can be placed before or after the application's
 * deliberately; see {@link collectMigrationFiles} for why that has to be one
 * global ordering and why file names must be unique across the whole run.
 *
 * The argument used to be declared and then ignored, so a caller passing the
 * wrong directory got the configured one anyway and never found out. It is
 * honoured now, which means a caller that was passing something other than a
 * migrations directory — the models directory was the common one — will see
 * that directory enumerated instead.
 */
export async function executeMigration(dirs?: string | string[]): Promise<boolean> {
  // Load the config file before anything reads `snapshotDir`.
  //
  // `config` is a synchronous singleton of defaults plus whatever `setConfig`
  // supplied, and the file is only read by the async `getConfig()` - which is
  // deliberate, so a background load cannot race an early query. Migrations are
  // a CLI operation with no such race, and they DO need the file: a caller that
  // set `snapshotDir` in query-builder.config.ts otherwise had it ignored and
  // the snapshot written to `.qb`, no matter what the host framework
  // configured in its own process.
  await getConfig()

  const workspaceRoot = getWorkspaceRoot()
  const dialect = config.dialect || 'postgres'

  const scriptFiles = collectMigrationFiles(resolveMigrationDirs(dirs, workspaceRoot))

  if (scriptFiles.length === 0) {
    info('-- No migration files found to execute')
    return true
  }

  info(`-- Found ${scriptFiles.length} script files to execute`)

  try {
    const qb = createQueryBuilder()

    // Everything from here runs under the migration lock, INCLUDING creating
    // the ledger table and reading it.
    //
    // Reading it inside is what stops two processes agreeing on the same
    // pending set and both applying it. Creating it inside is the subtler
    // half: `CREATE TABLE IF NOT EXISTS` is not atomic in Postgres, and two
    // sessions running it at the same instant race in the system catalogue —
    // one of them gets `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"` and, since this rethrows, exits non-zero.
    // Leaving it outside the lock meant the very scenario the lock exists for,
    // two concurrent boots, still had a way to fail. Caught by the locking
    // regression test failing intermittently in CI while passing locally.
    return await withMigrationLock(dialect, async () => {
      // Create migrations table if it doesn't exist
      await createMigrationsTable(qb, dialect)

      // Get already executed migrations
      const executedMigrations = await getExecutedMigrations(qb, dialect)

      /*
       * Every migration file is permanent, and every one that runs is recorded.
       *
       * Generated ALTERs used to be "transient": replayed on every migrate
       * rather than recorded, then deleted from disk once applied. That made
       * the corpus a log of one machine's session instead of the schema. Change
       * an attribute, migrate, and the ALTER that carried the change was gone —
       * so a teammate who cloned the repo and migrated got the table as it was
       * BEFORE the change, with no error and no clue. The generator writes each
       * change once (`createMigrationFile` refuses to write a statement the
       * corpus already contains), so there is nothing left for replay to fix,
       * and everything to lose by deleting the evidence.
       */
      const pending = scriptFiles.filter(file => !executedMigrations.includes(file.name))

      if (pending.length === 0) {
        info('-- No pending migrations to execute')
        return true
      }

      info(`-- Executing ${pending.length} migration${pending.length === 1 ? '' : 's'}`)

      for (const { name: file, path: filePath } of pending) {
        info(`-- Executing: ${file}`)

        try {
          // Apply the file and record it as ONE unit where the dialect allows.
          //
          // Unwrapped, a file is applied statement by statement: if statement 3
          // throws, statements 1 and 2 are already committed and the file is
          // neither applied nor cleanly re-runnable. Recording inside the same
          // transaction closes the matching gap at the other end, where the
          // schema changed but the process died before the ledger was written.
          const wrappable = supportsTransactionalDdl(dialect)
            && !NON_TRANSACTIONAL_SQL.test(readFileSync(filePath, 'utf-8'))

          if (wrappable) {
            await qb.transaction(async (tx: any) => {
              await tx.file(filePath)
              await recordMigration(tx, file, dialect)
            })
          }
          else {
            await qb.file(filePath)
            await recordMigration(qb, file, dialect)
            if (!supportsTransactionalDdl(dialect))
              info(`--   (${dialect} commits DDL implicitly, so ${file} was not applied atomically)`)
            else
              info(`--   (${file} contains a statement that cannot run in a transaction, so it was not applied atomically)`)
          }
          info(`-- ✓ Migration ${file} executed and recorded`)
        }
        catch (err) {
          // A generated migration whose change is already in place is not a
          // failure, it is a bookkeeping gap: the file was applied on a run that
          // died before recording it, or under the old transient behaviour that
          // never recorded it at all. Record it and carry on — the schema is
          // where the file says it should be. Anything else, including every
          // authored migration, fails loudly.
          if (isGeneratedMigration(filePath) && isAlreadyAppliedError(err)) {
            await recordMigration(qb, file, dialect)
            info(`-- ✓ Migration ${file} was already applied; recorded it (${err instanceof Error ? err.message : String(err)})`)
            continue
          }
          console.error(`-- ✗ Migration ${file} failed:`, err)
          throw err
        }
      }

        info('-- All migrations executed successfully')
        return true
    })
  }
  catch (err) {
    console.error('-- Migration execution failed:', err)
    throw err
  }

  return true
}

export async function resetDatabase(dir?: string, opts: MigrateOptions = {}): Promise<boolean> {
  // Load the config file before anything reads `snapshotDir`.
  //
  // `config` is a synchronous singleton of defaults plus whatever `setConfig`
  // supplied, and the file is only read by the async `getConfig()` - which is
  // deliberate, so a background load cannot race an early query. Migrations are
  // a CLI operation with no such race, and they DO need the file: a caller that
  // set `snapshotDir` in query-builder.config.ts otherwise had it ignored and
  // the snapshot written to `.qb`, no matter what the host framework
  // configured in its own process.
  await getConfig()

  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  // Fall back to the CONFIGURED dialect before the hardcoded default. A
  // sqlite-configured app calling resetDatabase() without an explicit dialect
  // was generating Postgres DDL (`DROP TABLE ... CASCADE`) against a sqlite
  // connection: every statement raised a syntax error that the surrounding
  // try/catch swallowed as "table may not exist", so the reset silently did
  // nothing.
  const dialect = opts.dialect || config.dialect || 'postgres'
  const driver = getDialectDriver(dialect)
  const workspaceRoot = getWorkspaceRoot()

  // Foreign-key toggles are connection-local in SQLite and MySQL. Reset used
  // a new connection for every DROP, while callers disabled constraints on a
  // different connection, so parent tables survived whenever a child still
  // referenced them. Run the toggle and DROP on the same connection.
  const dropTableForReset = async (tableName: string): Promise<void> => {
    const dropSql = driver.dropTable(tableName)
    await withFreshConnection(async (bunSql) => {
      if (dialect === 'sqlite') await bunSql.unsafe('PRAGMA foreign_keys = OFF').execute()
      if (dialect === 'mysql' || dialect === 'vitess') await bunSql.unsafe('SET FOREIGN_KEY_CHECKS = 0').execute()
      try {
        await bunSql.unsafe(dropSql).execute()
      }
      finally {
        if (dialect === 'sqlite') await bunSql.unsafe('PRAGMA foreign_keys = ON').execute()
        if (dialect === 'mysql' || dialect === 'vitess') await bunSql.unsafe('SET FOREIGN_KEY_CHECKS = 1').execute()
      }
    })
  }

  try {
    // Drop migrations table first to clear migration history
    try {
      await dropTableForReset('migrations')
      info('-- Dropped migrations table')
    }
    catch (err) {
      // Ignore errors when dropping migrations table
      console.error(err)
    }

    // Try to load models and get table names and enum types
    let tableNames: string[] = []
    let enumTypeNames: string[] = []
    try {
      const models = await loadModels({ modelsDir: dir })
      const plan = buildMigrationPlan(models, { dialect })
      tableNames = plan.tables.map(table => table.table)

      // Extract enum type names from all tables
      const enumTypes = new Set<string>()
      for (const table of plan.tables) {
        for (const column of table.columns) {
          if (column.type === 'enum' && column.enumValues && column.enumValues.length > 0) {
            // Table-qualified to match the CREATE TYPE names generateMigration
            // emits (see ColumnPlan.enumTypeName) so the drop path lines up.
            const enumTypeName = `${table.table}_${column.name}_type`
            enumTypes.add(enumTypeName)
          }
        }
      }
      enumTypeNames = Array.from(enumTypes)
    }
    catch (err) {
      console.error(err)
      tableNames = []
      enumTypeNames = []
    }

    if (tableNames.length === 0) {
      info('-- No tables found to drop')
    }
    else {
      info(`-- Dropping ${tableNames.length} tables: ${tableNames.join(', ')}`)

      // Drop tables in reverse order to handle foreign key constraints
      // (drop dependent tables first)
      for (const tableName of tableNames.reverse()) {
        try {
          await dropTableForReset(tableName)
          info(`-- Dropped table: ${tableName}`)
        }
        catch (err) {
          console.error(err)
          // Ignore errors when dropping tables (they might not exist)
          info(`-- Table ${tableName} may not exist, skipping drop`)
        }
      }
    }

    // Drop enum types after dropping tables
    if (enumTypeNames.length > 0) {
      info(`-- Dropping ${enumTypeNames.length} enum types: ${enumTypeNames.join(', ')}`)

      for (const enumTypeName of enumTypeNames) {
        try {
          const dropEnumSql = driver.dropEnumType(enumTypeName)
          if (dropEnumSql) {
            await withFreshConnection(async (bunSql) => {
              await bunSql.unsafe(dropEnumSql).execute()
              info(`-- Dropped enum type: ${enumTypeName}`)
            })
          }
        }
        catch (err) {
          console.error(err)
          // Ignore errors when dropping enum types (they might not exist)
          info(`-- Enum type ${enumTypeName} may not exist, skipping drop`)
        }
      }
    }
    else {
      info('-- No enum types found to drop')
    }

    // Clean up migration files — but only when there is a models
    // directory to regenerate them from (tableNames is populated above
    // from that same `loadModels` call). Projects that haven't created
    // an app/Models override yet run entirely on committed, hand-shipped
    // migrations; deleting those unconditionally left the project with
    // zero migration files and no way to get them back, since nothing
    // would repopulate the directory afterward.
    if (tableNames.length > 0 && !opts.preserveMigrationState) {
      try {
        await deleteMigrationFiles(dir, workspaceRoot, opts)
      }
      catch (err) {
        console.error(err)
        info('-- Could not clean up migration files')
      }
    }
    else if (tableNames.length === 0) {
      info('-- No models directory found; keeping committed migration files in place')
    }
    else {
      info('-- Preserving migration files and model snapshot for fresh replay')
    }

    // Clear generated directory to force fresh migration generation
    if (!opts.preserveMigrationState) {
      try {
        await clearGeneratedDirectory(workspaceRoot)
      }
      catch (err) {
        console.error(err)
        info('-- Could not clear generated directory')
      }
    }

    info('-- Database reset completed successfully')
    return true
  }
  catch (err) {
    console.error('-- Database reset failed:', err)
    // Don't throw the error, just log it and continue
    return false
  }
}

export async function deleteMigrationFiles(dir?: string, workspaceRoot?: string, opts: MigrateOptions = {}): Promise<void> {
  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  if (!workspaceRoot) {
    workspaceRoot = getWorkspaceRoot()
  }

  const dialect = String(opts.dialect || config.dialect || 'postgres') as SupportedDialect

  // Clean up the new snapshot file
  const snapshotPath = getSnapshotPath(workspaceRoot, dialect)
  if (existsSync(snapshotPath)) {
    unlinkSync(snapshotPath)
    info(`-- Removed model snapshot file: ${snapshotPath}`)
  }

  // Clean up legacy migration state file
  const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
  const statePath = String(opts.state || defaultStatePath)

  if (existsSync(statePath)) {
    unlinkSync(statePath)
    info(`-- Removed legacy migration state file: ${statePath}`)
  }

  removeGeneratedMigrationFiles(getSqlDirectory(workspaceRoot, config.migrationDir))
}

/**
 * Clear the generator's own output from a migrations directory — and only that.
 *
 * `migrate:fresh` used to delete every `.sql` file here. The generated ones
 * are about to be rewritten from the models, so those are fair game; a
 * hand-written migration is not. It is schema nothing else knows how to
 * produce, and removing it left the project with a corpus that could no longer
 * rebuild its own database. The marker the generator stamps into its files is
 * what tells the two apart, and an unreadable file counts as authored.
 */
function removeGeneratedMigrationFiles(sqlDir: string): void {
  if (!existsSync(sqlDir))
    return

  let removed = 0
  const kept: string[] = []

  for (const file of readdirSync(sqlDir).filter(f => f.endsWith('.sql'))) {
    if (!isGeneratedMigration(join(sqlDir, file))) {
      kept.push(file)
      continue
    }
    unlinkSync(join(sqlDir, file))
    info(`-- Removed generated migration file: ${file}`)
    removed += 1
  }

  info(`-- Cleaned up ${removed} generated migration file${removed === 1 ? '' : 's'} from migrations directory`)
  if (kept.length > 0)
    info(`-- Kept ${kept.length} hand-written migration${kept.length === 1 ? '' : 's'}: ${kept.slice(0, 5).join(', ')}${kept.length > 5 ? `, +${kept.length - 5} more` : ''}`)
}

/**
 * @deprecated This function is no longer needed. Model snapshots are now stored as JSON migration plans.
 * Keeping for backward compatibility but this is now a no-op.
 */
export async function copyModelsToGenerated(_dir?: string, _workspaceRoot?: string): Promise<void> {
  // No-op: Model snapshots are now stored as JSON migration plans in .qb/model-snapshot.{dialect}.json
  // This function is kept for backward compatibility but does nothing.
}

/**
 * Clear the generated directory to force fresh migration generation
 * This is called during migrate:fresh to ensure all models are treated as new
 */
export async function clearGeneratedDirectory(workspaceRoot?: string): Promise<void> {
  if (!workspaceRoot) {
    workspaceRoot = getWorkspaceRoot()
  }

  const generatedDir = join(workspaceRoot, 'generated')

  if (existsSync(generatedDir)) {
    try {
      rmSync(generatedDir, { recursive: true, force: true })
      info('-- Cleared generated directory')
    }
    catch (err) {
      console.error('-- Failed to clear generated directory:', err)
    }
  }
}

async function createMigrationsTable(qb: any, dialect: SupportedDialect): Promise<void> {
  const driver = getDialectDriver(dialect)
  const createTableSql = driver.createMigrationsTable()

  try {
    await qb.unsafe(createTableSql).execute()
    info('-- Migrations table ready')
  }
  catch (err) {
    console.error('-- Failed to create migrations table:', err)
    throw err
  }
}

async function getExecutedMigrations(qb: any, dialect: SupportedDialect): Promise<string[]> {
  const driver = getDialectDriver(dialect)
  try {
    const result = await qb.unsafe(driver.getExecutedMigrationsQuery()).execute()
    return result.map((row: any) => row.migration)
  }
  catch (err) {
    console.error('-- Failed to get executed migrations:', err)
    // If table doesn't exist or query fails, return empty array
    return []
  }
}

async function recordMigration(qb: any, migrationFile: string, dialect: SupportedDialect): Promise<void> {
  const driver = getDialectDriver(dialect)
  try {
    info(`-- Recording migration: ${migrationFile}`)
    await qb.unsafe(driver.recordMigrationQuery(), [migrationFile]).execute()
    info(`-- Successfully recorded migration: ${migrationFile}`)
  }
  catch (err) {
    console.error(`-- Failed to record migration ${migrationFile}:`, err)
    throw err
  }
}
