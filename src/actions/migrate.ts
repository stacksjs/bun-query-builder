import type { GenerateMigrationResult, MigrateOptions, SupportedDialect } from '../types'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMigrationPlan, createQueryBuilder, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '../'
import { config } from '../config'
import { bunSql } from '../db'

export async function generateMigration(dir: string, opts: MigrateOptions = {}): Promise<GenerateMigrationResult> {
  const dialect = String(opts.dialect || 'postgres') as SupportedDialect

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

  console.log('current dialect is', dialect)
  console.log(defaultStatePath)
  console.log(sqlStatements)
  if (opts.apply) {
    const qb = createQueryBuilder()
    // Use a temp file to execute multiple statements safely via file()
    const dirPath = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
    const filePath = join(dirPath, 'migration.sql')
    try {
      if (hasChanges) {
        writeFileSync(filePath, sql)
        await qb.file(filePath)
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

export async function executeMigration(migration: GenerateMigrationResult): Promise<boolean> {
  const { sqlStatements } = migration

  console.log('database dialect is', config.dialect)

  try {
    for (const sql of sqlStatements) {
      // Use raw SQL execution instead of template literal to avoid parameter binding issues
      await bunSql.unsafe(sql).execute()
    }

    console.log('-- Migration executed successfully')
  }
  catch (err) {
    console.error('-- Migration execution failed:', err)
    throw err
  }

  return true
}

export async function resetDatabase(dir: string, opts: MigrateOptions = {}): Promise<boolean> {
  const dialect = String(opts.dialect || 'postgres') as SupportedDialect
  const models = await loadModels({ modelsDir: dir })
  const plan = buildMigrationPlan(models, { dialect })

  try {
    // Get all table names from the migration plan
    const tableNames = plan.tables.map(table => table.table)

    if (tableNames.length === 0) {
      console.log('-- No tables found to drop')
      return true
    }

    console.log(`-- Dropping ${tableNames.length} tables: ${tableNames.join(', ')}`)

    // Drop tables in reverse order to handle foreign key constraints
    // (drop dependent tables first)
    for (const tableName of tableNames.reverse()) {
      const dropSql = dialect === 'mysql'
        ? `DROP TABLE IF EXISTS \`${tableName}\``
        : `DROP TABLE IF EXISTS "${tableName}" CASCADE`

      await bunSql.unsafe(dropSql).execute()
      console.log(`-- Dropped table: ${tableName}`)
    }

    // Clean up migration state file
    const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
    const statePath = String(opts.state || defaultStatePath)

    if (existsSync(statePath)) {
      const fs = await import('node:fs')
      fs.unlinkSync(statePath)
      console.log(`-- Removed migration state file: ${statePath}`)
    }

    console.log('-- Database reset completed successfully')
    return true
  }
  catch (err) {
    console.error('-- Database reset failed:', err)
    throw err
  }
}
