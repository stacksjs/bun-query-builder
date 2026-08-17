import { resolve } from 'node:path'
import { SQL } from 'bun'
import { generateMigration, resetDatabase } from '../src/actions/migrate'
import { config, setConfig } from '../src/config'
import { closeConnection, resetConnection } from '../src/db'

// Absolute path to examples/models directory (relative to this file's location)
export const EXAMPLES_MODELS_PATH: string = resolve(__dirname, '../../../examples/models')

let configOverridden = false
let savedDatabaseConfig: any = null
let stopFn: (() => Promise<void>) | null = null

async function ensureConfiguredPostgresDatabase(): Promise<boolean> {
  if (config.dialect !== 'postgres')
    return false

  const database = config.database.database
  if (!database || database === 'postgres')
    return false

  const admin = new SQL({
    adapter: 'postgres',
    hostname: config.database.host,
    port: config.database.port,
    database: 'postgres',
    username: config.database.username,
    password: config.database.password,
    max: 1,
  })

  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${database}) AS exists
    `

    if (!existing[0]?.exists) {
      const identifier = `"${database.replaceAll('"', '""')}"`
      await admin.unsafe(`CREATE DATABASE ${identifier}`)
    }

    resetConnection()
    const { getOrCreateBunSql } = await import('../src/db')
    const sql = getOrCreateBunSql(true)
    await sql`SELECT 1 as ok`
    return true
  }
  catch {
    return false
  }
  finally {
    await admin.close()
  }
}

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
    // The server may be healthy while only the declared test database is
    // missing. Provision it through the standard Postgres maintenance
    // database before attempting to start a second local service.
    if (await ensureConfiguredPostgresDatabase())
      return
  }

  // Save original config
  savedDatabaseConfig = { ...config.database }

  // 2. Start Postgres via pantry
  const { PantryService } = await import('ts-pantry/testing')

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
    await closeConnection()
    await ensurePostgres()

    // Reset database first to ensure clean slate
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })

    await generateMigration(EXAMPLES_MODELS_PATH, { dialect: config.dialect, full: true, apply: true })
  }
  catch (error) {
    console.error('Migration failed:', error)
  }
}
