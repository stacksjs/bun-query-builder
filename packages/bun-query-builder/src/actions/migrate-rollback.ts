import type { SupportedDialect } from '@/types'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { config } from '@/config'
import { getDialectDriver } from '@/drivers'
import { createQueryBuilder } from '../index'

/**
 * Find workspace root by looking for package.json
 */
function findWorkspaceRoot(startPath: string): string {
  let currentPath = startPath

  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath
    }
    currentPath = dirname(currentPath)
  }

  return process.cwd()
}

function getSqlDirectory(workspaceRoot?: string): string {
  if (!workspaceRoot) {
    workspaceRoot = findWorkspaceRoot(process.cwd())
  }
  return join(workspaceRoot, 'sql')
}

export interface RollbackOptions {
  steps?: number
}

/**
 * Rollback migrations
 *
 * Note: This removes migration entries from the migrations table.
 * Since migrations are auto-generated from models, you should:
 * 1. Revert your model changes
 * 2. Run rollback to remove migration records
 * 3. Generate fresh migrations
 */
export async function migrateRollback(options: RollbackOptions = {}): Promise<void> {
  const dialect = config.dialect as SupportedDialect || 'postgres'
  const driver = getDialectDriver(dialect)
  const steps = options.steps || 1

  console.log('-- Rolling back migrations')
  console.log(`-- Steps: ${steps}`)
  console.log()

  try {
    const qb = createQueryBuilder()

    // Get executed migrations from database (ordered by execution time desc)
    let executedMigrations: Array<{ migration: string, executed_at?: string }> = []
    try {
      const query = `
        SELECT migration, executed_at
        FROM migrations
        ORDER BY executed_at DESC, migration DESC
      `
      executedMigrations = await qb.unsafe(query)
    }
    catch (err) {
      console.log('-- Migrations table not found. Nothing to rollback.')
      return
    }

    if (executedMigrations.length === 0) {
      console.log('-- No migrations to rollback')
      return
    }

    const migrationsToRollback = executedMigrations.slice(0, steps)

    console.log(`-- Found ${executedMigrations.length} executed migrations`)
    console.log(`-- Rolling back ${migrationsToRollback.length} migration(s):`)
    console.log()

    for (const migration of migrationsToRollback) {
      console.log(`  - ${migration.migration}`)
    }
    console.log()

    // Remove migration records from database
    for (const migration of migrationsToRollback) {
      try {
        const deleteSql = `DELETE FROM migrations WHERE migration = $1`
        await qb.unsafe(deleteSql, [migration.migration])
        console.log(`-- ✓ Removed migration record: ${migration.migration}`)

        // Optionally delete the migration file
        const sqlDir = getSqlDirectory()
        const filePath = join(sqlDir, migration.migration)
        if (existsSync(filePath)) {
          unlinkSync(filePath)
          console.log(`-- 🗑️  Deleted migration file: ${migration.migration}`)
        }
      }
      catch (err) {
        console.error(`-- ✗ Failed to rollback migration ${migration.migration}:`, err)
        throw err
      }
    }

    console.log()
    console.log('-- ⚠️  Important: Rollback only removes migration records.')
    console.log('-- To reverse schema changes:')
    console.log('--   1. Revert your model changes')
    console.log('--   2. Run `qb migrate:fresh` to rebuild the database')
    console.log('--   or manually write and execute reverse SQL')
  }
  catch (err) {
    console.error('-- Rollback failed:', err)
    throw err
  }
}
