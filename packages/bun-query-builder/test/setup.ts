import { resolve } from 'node:path'
import { executeMigration, generateMigration, resetDatabase } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'

// Absolute path to examples/models directory (relative to this file's location)
export const EXAMPLES_MODELS_PATH: string = resolve(__dirname, '../../../examples/models')

let configOverridden = false
let savedDatabaseConfig: any = null
let stopFn: (() => Promise<void>) | null = null

/**
 * Ensure a Postgres connection is available for tests.
 *
 * Strategy (in order):
 * 1. Try the configured external Postgres
 * 2. Start Postgres via pantry (if `pantry` CLI is available)
 */
export async function ensurePostgres(): Promise<void> {
  // 1. Try external Postgres first
  try {
    const { getOrCreateBunSql } = await import('../src/db')
    const sql = getOrCreateBunSql()
    await sql`SELECT 1 as ok`
    return
  }
  catch {
    // Not available
  }

  // Save original config
  savedDatabaseConfig = { ...config.database }

  // 2. Start Postgres via pantry
  const { PantryService } = await import(
    '/Users/chrisbreuer/Code/Tools/pantry/packages/pantry-test/src/service.ts'
  )

  if (!PantryService.isAvailable()) {
    throw new Error('No Postgres available and pantry CLI not found. Install pantry: https://pantry.dev')
  }

  const svc = new PantryService({ name: 'postgres', quiet: true })
  const status = await svc.ensureRunning()

  if (!status.running || !status.port) {
    throw new Error('pantry failed to start Postgres')
  }

  const username = process.env.USER ?? 'postgres'
  setConfig({
    database: {
      database: 'postgres',
      username,
      password: '',
      host: 'localhost',
      port: status.port,
    },
  })
  resetConnection()
  configOverridden = true
  stopFn = () => svc.stop()

  // Verify the connection actually works (pantry may report running but launchd can fail)
  const { getOrCreateBunSql } = await import('../src/db')
  try {
    const sql = getOrCreateBunSql(true)
    await sql`SELECT 1 as ok`
  }
  catch (err) {
    // Connection failed — restore config and stop
    await svc.stop()
    if (savedDatabaseConfig) {
      setConfig({ database: savedDatabaseConfig })
      resetConnection()
      savedDatabaseConfig = null
    }
    configOverridden = false
    stopFn = null
    throw new Error(`pantry started Postgres but connection failed: ${(err as Error).message}`)
  }
}

/**
 * Tear down Postgres and restore config.
 */
export async function teardownPostgres(): Promise<void> {
  if (stopFn) {
    await stopFn()
    stopFn = null
  }

  if (configOverridden && savedDatabaseConfig) {
    setConfig({ database: savedDatabaseConfig })
    resetConnection()
    savedDatabaseConfig = null
    configOverridden = false
  }
}

export async function setupDatabase(): Promise<void> {
  try {
    await ensurePostgres()

    // Reset database first to ensure clean slate
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })

    await generateMigration(EXAMPLES_MODELS_PATH, { dialect: config.dialect, full: true })

    await executeMigration()
  }
  catch (error) {
    console.error('Migration failed:', error)
  }
}
