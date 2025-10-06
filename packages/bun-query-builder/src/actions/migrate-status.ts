import type { SupportedDialect } from '@/types'
import { existsSync, readdirSync } from 'node:fs'
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

export interface MigrationStatus {
  file: string
  status: 'executed' | 'pending' | 'transient'
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
      const result = await qb.unsafe(driver.getExecutedMigrationsQuery()).execute()
      executedMigrations = result
    }
    catch (err) {
      console.log('-- Migrations table not found. All migrations are pending.')
      console.log()
    }

    const executedMap = new Map(
      executedMigrations.map(m => [m.migration, m.executed_at]),
    )

    const statuses: MigrationStatus[] = migrationFiles.map((file) => {
      // Transient migrations (ALTER TABLE migrations)
      if (file.includes('alter-') && file.includes('-table')) {
        return {
          file,
          status: 'transient' as const,
        }
      }

      const executedAt = executedMap.get(file)
      return {
        file,
        status: executedAt ? 'executed' as const : 'pending' as const,
        executedAt,
      }
    })

    // Display results
    const executed = statuses.filter(s => s.status === 'executed')
    const pending = statuses.filter(s => s.status === 'pending')
    const transient = statuses.filter(s => s.status === 'transient')

    console.log(`-- Total migrations: ${migrationFiles.length}`)
    console.log(`-- Executed: ${executed.length}`)
    console.log(`-- Pending: ${pending.length}`)
    console.log(`-- Transient: ${transient.length}`)
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

    if (transient.length > 0) {
      console.log('⚡ Transient Migrations (ALTER TABLE - not tracked):')
      for (const migration of transient) {
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
