import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetDatabase } from '../src/actions/migrate'
import { config, defaultConfig } from '../src/config'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

/**
 * `config` is a process-wide singleton and ~27 test files legitimately
 * repoint it (usually at sqlite) for their own duration. `bun test` does not
 * run files in a fixed order, so asserting on whatever the previous file left
 * behind failed intermittently — CI observed `dialect: 'sqlite'` here while
 * local runs happened to get a kind ordering.
 *
 * These assertions are about the SHIPPED DEFAULTS, so pin that baseline
 * explicitly rather than trusting ambient state, and put back exactly what
 * was found.
 */
describe('test configuration', () => {
  let saved: Record<string, any>

  beforeAll(async () => {
    saved = { ...config }
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    // Set up database for config tests
    await setupDatabase()
  })

  afterAll(async () => {
    // Clean up database after config tests
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })
    for (const k of Object.keys(config)) delete (config as any)[k]
    Object.assign(config, saved)
  })

  it('should have postgres dialect configured', () => {
    expect(config.dialect).toBe('postgres')
    // Database may be 'test_db' (external Postgres) or 'postgres' (embedded PGlite)
    expect(['test_db', 'postgres']).toContain(config.database.database)
    expect(typeof config.database.port).toBe('number')
  })
})
