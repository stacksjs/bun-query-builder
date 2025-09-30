import type { GenerateMigrationResult, MigrateOptions, SupportedDialect } from '@/types'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '@/config'
import { bunSql } from '@/db'
import { buildMigrationPlan, createQueryBuilder, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '@/index'
import { getDialectDriver } from '@/drivers'

function ensureSqlDirectory(): string {
  const sqlDir = getSqlDirectory()
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    console.log(`-- Created SQL directory: ${sqlDir}`)
  }
  return sqlDir
}

export async function generateMigration(dir: string, opts: MigrateOptions = {}): Promise<GenerateMigrationResult> {
  const dialect = String(opts.dialect || config.dialect || 'postgres') as SupportedDialect

  // Copy model files to generated directory
  await copyModelsToGenerated(dir)

  const models = await loadModels({ modelsDir: dir })
  const plan = buildMigrationPlan(models, { dialect })

  const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
  const statePath = String(opts.state || defaultStatePath)

  let previous: any | undefined
  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      previous = parsed?.plan && parsed.plan.tables ? parsed.plan : (parsed?.tables ? parsed : undefined)
    }
    catch {
      // ignore corrupt state; treat as no previous
    }
  }

  const sqlStatements = opts.full ? generateSql(plan) : generateDiffSql(previous, plan)
  const sql = sqlStatements.join('\n')

  const hasChanges = sqlStatements.some(stmt => /\b(?:CREATE|ALTER)\b/i.test(stmt))

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
      // On success, write state snapshot with current plan and hash
      writeFileSync(statePath, JSON.stringify({ plan, hash: hashMigrationPlan(plan), updatedAt: new Date().toISOString() }, null, 2))
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      throw err
    }
  }

  return { sql, sqlStatements, hasChanges, plan }
}

export async function executeMigration(): Promise<boolean> {
  const sqlDir = ensureSqlDirectory()
  const dialect = config.dialect || 'postgres'

  const files = readdirSync(sqlDir)
  const scriptFiles = files.filter(file => file.endsWith('.sql')).sort()

  if (scriptFiles.length === 0) {
    throw new Error('No script files found. Run generateMigration first.')
  }

  console.log('database dialect is', dialect)
  console.log(`-- Found ${scriptFiles.length} script files to execute`)

  try {
    const qb = createQueryBuilder()

    // Create migrations table if it doesn't exist
    await createMigrationsTable(qb, dialect)

    // Get already executed migrations
    const executedMigrations = await getExecutedMigrations(qb, dialect)

    // Filter out already executed migrations
    const pendingMigrations = scriptFiles.filter(file => !executedMigrations.includes(file))

    if (pendingMigrations.length === 0) {
      console.log('-- No pending migrations to execute')
      return true
    }

    console.log(`-- Executing ${pendingMigrations.length} pending migrations`)

    for (const file of pendingMigrations) {
      const filePath = join(sqlDir, file)
      console.log(`-- Executing: ${file}`)

      try {
        await qb.file(filePath)
        await recordMigration(qb, file, dialect)
        console.log(`-- ✓ Migration ${file} executed successfully`)
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

export async function resetDatabase(dir: string, opts: MigrateOptions = {}): Promise<boolean> {
  const dialect = String(opts.dialect || 'postgres') as SupportedDialect
  const driver = getDialectDriver(dialect)

  try {
    // Drop migrations table first to clear migration history
    const dropMigrationsSql = driver.dropTable('migrations')

    try {
      await bunSql.unsafe(dropMigrationsSql).execute()
      console.log('-- Dropped migrations table')
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
          await bunSql.unsafe(dropSql).execute()
          console.log(`-- Dropped table: ${tableName}`)
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
            await bunSql.unsafe(dropEnumSql).execute()
            console.log(`-- Dropped enum type: ${enumTypeName}`)
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
      await deleteMigrationFiles(dir, opts)
    }
    catch (err) {
      console.error(err)
      console.log('-- Could not clean up migration files')
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

export async function deleteMigrationFiles(dir: string, opts: MigrateOptions = {}): Promise<void> {
  const dialect = String(opts.dialect || 'postgres') as SupportedDialect

  // Clean up migration state file
  const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
  const statePath = String(opts.state || defaultStatePath)

  if (existsSync(statePath)) {
    unlinkSync(statePath)
    console.log(`-- Removed migration state file: ${statePath}`)
  }

  // Clean up all files in the sql directory
  const sqlDir = ensureSqlDirectory()
  if (existsSync(sqlDir)) {
    const sqlFiles = readdirSync(sqlDir)
    const migrationFiles = sqlFiles.filter(file => file.endsWith('.sql'))

    for (const file of migrationFiles) {
      const filePath = join(sqlDir, file)
      unlinkSync(filePath)
      console.log(`-- Removed migration file: ${file}`)
    }
    console.log(`-- Cleaned up ${migrationFiles.length} migration files from sql directory`)
  }
}

export async function copyModelsToGenerated(dir: string): Promise<void> {
  try {
    // Ensure the generated directory exists at the workspace root
    const generatedDir = join(__dirname, '..', '..', 'generated')
    if (!existsSync(generatedDir)) {
      mkdirSync(generatedDir, { recursive: true })
      console.log('-- Created generated directory')
    }

    // Read all files from the models directory
    const files = readdirSync(dir)

    // Filter for TypeScript files
    const modelFiles = files.filter(file => file.endsWith('.ts') || file.endsWith('.js'))

    if (modelFiles.length === 0) {
      console.log('-- No model files found to copy')
      return
    }

    console.log(`-- Copying ${modelFiles.length} model files to generated directory`)

    // Copy each model file to the generated directory
    for (const file of modelFiles) {
      const sourcePath = join(dir, file)
      const destPath = join(generatedDir, file)

      copyFileSync(sourcePath, destPath)
      console.log(`-- Copied: ${file}`)
    }

    console.log('-- Model files copied successfully')
  }
  catch (err) {
    console.error('-- Failed to copy model files:', err)
    throw err
  }
}

function getSqlDirectory(): string {
  return join(__dirname, '..', '..', 'sql')
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
