import type { MigrationPlan } from '@/migrations'
import type { GenerateMigrationResult, MigrateOptions, SupportedDialect } from '@/types'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { config } from '@/config'
import { withFreshConnection } from '@/db'
import { getDialectDriver } from '@/drivers'
import { buildMigrationPlan, createQueryBuilder, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '../index'

/**
 * Get the path to the model snapshot file for a given dialect.
 * This file stores the serialized migration plan from the last successful migration.
 */
function getSnapshotPath(workspaceRoot: string, dialect: SupportedDialect): string {
  const snapshotDir = join(workspaceRoot, '.qb')
  return join(snapshotDir, `model-snapshot.${dialect}.json`)
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

    console.log('-- Invalid snapshot format, treating as no previous state')
    return undefined
  }
  catch (err) {
    console.log('-- Could not load snapshot, treating as no previous state:', err)
    return undefined
  }
}

/**
 * Save the current migration plan as a snapshot for future comparisons.
 * This is called after a successful migration generation.
 */
function savePlanSnapshot(workspaceRoot: string, dialect: SupportedDialect, plan: MigrationPlan): void {
  const snapshotPath = getSnapshotPath(workspaceRoot, dialect)
  const snapshotDir = join(workspaceRoot, '.qb')

  // Ensure the .qb directory exists
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true })
    console.log(`-- Created snapshot directory: ${snapshotDir}`)
  }

  const snapshot = {
    plan,
    hash: hashMigrationPlan(plan),
    dialect,
    updatedAt: new Date().toISOString(),
  }

  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
  console.log(`-- Model snapshot saved to ${snapshotPath}`)
}

/**
 * Get workspace root - always use process.cwd() for consistency
 */
function getWorkspaceRoot(): string {
  return process.cwd()
}

function ensureSqlDirectory(workspaceRoot?: string): string {
  const sqlDir = getSqlDirectory(workspaceRoot)
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    console.log(`-- Created SQL directory: ${sqlDir}`)
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
  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  const dialect = opts.dialect || config.dialect || 'postgres'

  // Get workspace root - always use current working directory
  const workspaceRoot = getWorkspaceRoot()

  // Load current models from source directory and build migration plan
  const models = await loadModels({ modelsDir: dir })
  const plan = buildMigrationPlan(models, { dialect })

  let previous: MigrationPlan | undefined

  if (!opts.full) {
    // Load previous state from the snapshot file (primary source)
    previous = loadPlanSnapshot(workspaceRoot, dialect)

    if (previous) {
      console.log('-- Comparing with stored model snapshot')
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
            console.log('-- Comparing with legacy state file (will migrate to new snapshot format)')
          }
        }
        catch {
          // ignore corrupt state; treat as no previous
        }
      }

      if (!previous) {
        console.log('-- No previous snapshot found, generating full migration')
      }
    }
  }
  else {
    console.log('-- Full migration requested, ignoring any previous state')
  }

  const sqlStatements = opts.full ? generateSql(plan) : generateDiffSql(previous, plan)

  const sql = sqlStatements.join('\n')

  const hasChanges = sqlStatements.some(stmt => /\b(?:CREATE|ALTER|DROP)\b/i.test(stmt))

  if (opts.apply) {
    // Use a temp file to execute multiple statements safely via file()
    const dirPath = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
    const filePath = join(dirPath, 'migration.sql')

    try {
      if (hasChanges) {
        writeFileSync(filePath, sql)
        console.log('-- Migration applied')
      }
      else {
        console.log('-- No changes; nothing to apply')
      }
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      throw err
    }
  }

  // Always save the current plan as a snapshot after generating migrations
  // This ensures the next migration will only include new changes
  savePlanSnapshot(workspaceRoot, dialect, plan)

  return { sql, sqlStatements, hasChanges, plan }
}

export async function executeMigration(dir?: string): Promise<boolean> {
  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  const workspaceRoot = getWorkspaceRoot()
  const sqlDir = ensureSqlDirectory(workspaceRoot)
  const dialect = config.dialect || 'postgres'

  const files = readdirSync(sqlDir)
  const scriptFiles = files.filter(file => file.endsWith('.sql')).sort()

  if (scriptFiles.length === 0) {
    console.log('-- No migration files found to execute')
    return true
  }

  console.log(`-- Found ${scriptFiles.length} script files to execute`)

  try {
    const qb = createQueryBuilder()

    // Create migrations table if it doesn't exist
    await createMigrationsTable(qb, dialect)

    // Get already executed migrations
    const executedMigrations = await getExecutedMigrations(qb, dialect)

    // Separate migrations into permanent (CREATE) and transient (ALTER)
    const permanentMigrations: string[] = []
    const transientMigrations: string[] = []

    for (const file of scriptFiles) {
      // ALTER TABLE migrations are transient (not tracked)
      if (file.includes('alter-') && file.includes('-table')) {
        transientMigrations.push(file)
      }
      // Everything else is permanent (CREATE TABLE, CREATE INDEX, etc.)
      else if (!executedMigrations.includes(file)) {
        permanentMigrations.push(file)
      }
    }

    const totalPending = permanentMigrations.length + transientMigrations.length

    if (totalPending === 0) {
      console.log('-- No pending migrations to execute')
      return true
    }

    console.log(`-- Executing ${totalPending} migrations (${permanentMigrations.length} permanent, ${transientMigrations.length} transient)`)

    // Execute permanent migrations first (CREATE TABLE, etc.)
    for (const file of permanentMigrations) {
      const filePath = join(sqlDir, file)
      console.log(`-- Executing: ${file}`)

      try {
        await qb.file(filePath)
        await recordMigration(qb, file, dialect)
        console.log(`-- ✓ Migration ${file} executed and recorded`)
      }
      catch (err) {
        console.error(`-- ✗ Migration ${file} failed:`, err)
        throw err
      }
    }

    // Execute transient migrations (ALTER TABLE) but don't record them
    for (const file of transientMigrations) {
      const filePath = join(sqlDir, file)
      console.log(`-- Executing: ${file} (transient)`)

      try {
        await qb.file(filePath)
        console.log(`-- ✓ Migration ${file} executed (not recorded)`)

        // Delete the transient migration file after successful execution
        unlinkSync(filePath)
        console.log(`-- 🗑️  Deleted transient migration: ${file}`)
      }
      catch (err) {
        console.error(`-- ✗ Migration ${file} failed:`, err)
        throw err
      }
    }

    console.log('-- All migrations executed successfully')
  }
  catch (err) {
    console.error('-- Migration execution failed:', err)
    throw err
  }

  return true
}

export async function resetDatabase(dir?: string, opts: MigrateOptions = {}): Promise<boolean> {
  if (!dir) {
    dir = join(process.cwd(), 'app/Models')
  }

  const dialect = opts.dialect || 'postgres'
  const driver = getDialectDriver(dialect)
  const workspaceRoot = getWorkspaceRoot()

  try {
    // Drop migrations table first to clear migration history
    const dropMigrationsSql = driver.dropTable('migrations')

    try {
      await withFreshConnection(async (bunSql) => {
        await bunSql.unsafe(dropMigrationsSql).execute()
        console.log('-- Dropped migrations table')
      })
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
            const enumTypeName = `${column.name}_type`
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
      console.log('-- No tables found to drop')
    }
    else {
      console.log(`-- Dropping ${tableNames.length} tables: ${tableNames.join(', ')}`)

      // Drop tables in reverse order to handle foreign key constraints
      // (drop dependent tables first)
      for (const tableName of tableNames.reverse()) {
        try {
          const dropSql = driver.dropTable(tableName)
          await withFreshConnection(async (bunSql) => {
            await bunSql.unsafe(dropSql).execute()
            console.log(`-- Dropped table: ${tableName}`)
          })
        }
        catch (err) {
          console.error(err)
          // Ignore errors when dropping tables (they might not exist)
          console.log(`-- Table ${tableName} may not exist, skipping drop`)
        }
      }
    }

    // Drop enum types after dropping tables
    if (enumTypeNames.length > 0) {
      console.log(`-- Dropping ${enumTypeNames.length} enum types: ${enumTypeNames.join(', ')}`)

      for (const enumTypeName of enumTypeNames) {
        try {
          const dropEnumSql = driver.dropEnumType(enumTypeName)
          if (dropEnumSql) {
            await withFreshConnection(async (bunSql) => {
              await bunSql.unsafe(dropEnumSql).execute()
              console.log(`-- Dropped enum type: ${enumTypeName}`)
            })
          }
        }
        catch (err) {
          console.error(err)
          // Ignore errors when dropping enum types (they might not exist)
          console.log(`-- Enum type ${enumTypeName} may not exist, skipping drop`)
        }
      }
    }
    else {
      console.log('-- No enum types found to drop')
    }

    // Clean up migration files
    try {
      await deleteMigrationFiles(dir, workspaceRoot, opts)
    }
    catch (err) {
      console.error(err)
      console.log('-- Could not clean up migration files')
    }

    // Clear generated directory to force fresh migration generation
    try {
      await clearGeneratedDirectory(workspaceRoot)
    }
    catch (err) {
      console.error(err)
      console.log('-- Could not clear generated directory')
    }

    console.log('-- Database reset completed successfully')
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

  const dialect = String(opts.dialect || 'postgres') as SupportedDialect

  // Clean up the new snapshot file
  const snapshotPath = getSnapshotPath(workspaceRoot, dialect)
  if (existsSync(snapshotPath)) {
    unlinkSync(snapshotPath)
    console.log(`-- Removed model snapshot file: ${snapshotPath}`)
  }

  // Clean up legacy migration state file
  const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
  const statePath = String(opts.state || defaultStatePath)

  if (existsSync(statePath)) {
    unlinkSync(statePath)
    console.log(`-- Removed legacy migration state file: ${statePath}`)
  }

  // Clean up all files in the sql directory
  const sqlDir = getSqlDirectory(workspaceRoot)
  if (existsSync(sqlDir)) {
    const sqlFiles = readdirSync(sqlDir)
    const migrationFiles = sqlFiles.filter(file => file.endsWith('.sql'))

    for (const file of migrationFiles) {
      const filePath = join(sqlDir, file)
      unlinkSync(filePath)
      console.log(`-- Removed migration file: ${file}`)
    }
    console.log(`-- Cleaned up ${migrationFiles.length} migration files from migrations directory`)
  }
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
      console.log('-- Cleared generated directory')
    }
    catch (err) {
      console.error('-- Failed to clear generated directory:', err)
    }
  }
}

function getSqlDirectory(workspaceRoot?: string): string {
  if (!workspaceRoot) {
    workspaceRoot = getWorkspaceRoot()
  }

  return join(workspaceRoot, 'database', 'migrations')
}

async function createMigrationsTable(qb: any, dialect: SupportedDialect): Promise<void> {
  const driver = getDialectDriver(dialect)
  const createTableSql = driver.createMigrationsTable()

  try {
    await qb.unsafe(createTableSql).execute()
    console.log('-- Migrations table ready')
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
    console.log(`-- Recording migration: ${migrationFile}`)
    await qb.unsafe(driver.recordMigrationQuery(), [migrationFile]).execute()
    console.log(`-- Successfully recorded migration: ${migrationFile}`)
  }
  catch (err) {
    console.error(`-- Failed to record migration ${migrationFile}:`, err)
    throw err
  }
}
