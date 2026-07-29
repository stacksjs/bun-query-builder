import type { SupportedDialect } from '@/types'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { config } from '@/config'
import { getDialectDriver } from '@/drivers'
import { createQueryBuilder } from '../index'
import { getSqlDirectory } from '@/workspace'

export interface MigrationStatus {
  file: string
  status: 'executed' | 'pending'
  executedAt?: string
}

/**
 * Get migration status - shows which migrations have been executed and which are pending
 */
export async function migrateStatus(): Promise<MigrationStatus[]> {
  const dialect = config.dialect as SupportedDialect || 'postgres'
  const driver = getDialectDriver(dialect)
  const sqlDir = getSqlDirectory()

  console.log('-- Migration Status')
  console.log(`-- Dialect: ${dialect}`)
  console.log(`-- SQL directory: ${sqlDir}`)
  console.log()

  if (!existsSync(sqlDir)) {
    console.log('-- No SQL directory found. No migrations have been created yet.')
    return []
  }

  const files = readdirSync(sqlDir)
  const migrationFiles = files.filter(file => file.endsWith('.sql')).sort()

  if (migrationFiles.length === 0) {
    console.log('-- No migration files found')
    return []
  }

  try {
    const qb = createQueryBuilder()

    // Get executed migrations from database
    let executedMigrations: Array<{ migration: string, executed_at?: string }> = []
    try {
      const result = await qb.unsafe(driver.getExecutedMigrationsQuery())
      executedMigrations = result
    }
    catch (err) {
      console.log('-- Migrations table not found. All migrations are pending.', err)
      console.log()
    }

    const executedMap = new Map(
      executedMigrations.map(m => [m.migration, m.executed_at]),
    )

    /*
     * Status comes from the ledger, for every file.
     *
     * Anything matching `alter-*-table` used to be reported as "transient —
     * not tracked" on the strength of its NAME, from the days when generated
     * ALTERs were replayed rather than recorded. They are recorded now, so
     * that branch reported executed migrations as untracked and hand-written
     * ones — which were never transient at any point — along with them.
     */
    const statuses: MigrationStatus[] = migrationFiles.map(file => ({
      file,
      // Presence in the ledger, not truthiness of the timestamp: a row whose
      // `executed_at` is null — or a driver that does not select the column —
      // still means the migration ran.
      status: executedMap.has(file) ? 'executed' as const : 'pending' as const,
      executedAt: executedMap.get(file),
    }))

    // Display results
    const executed = statuses.filter(s => s.status === 'executed')
    const pending = statuses.filter(s => s.status === 'pending')

    console.log(`-- Total migrations: ${migrationFiles.length}`)
    console.log(`-- Executed: ${executed.length}`)
    console.log(`-- Pending: ${pending.length}`)
    console.log()

    if (executed.length > 0) {
      console.log('✓ Executed Migrations:')
      for (const migration of executed) {
        console.log(`  - ${migration.file} ${migration.executedAt ? `(${new Date(migration.executedAt).toLocaleString()})` : ''}`)
      }
      console.log()
    }

    if (pending.length > 0) {
      console.log('○ Pending Migrations:')
      for (const migration of pending) {
        console.log(`  - ${migration.file}`)
      }
      console.log()
    }

    return statuses
  }
  catch (err) {
    console.error('-- Failed to get migration status:', err)
    throw err
  }
}

/**
 * List all migrations (alias for status)
 */
export async function migrateList(): Promise<MigrationStatus[]> {
  return migrateStatus()
}
