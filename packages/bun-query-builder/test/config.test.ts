import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

describe('test configuration', () => {
  beforeAll(async () => {
    // Set up database for config tests
    await setupDatabase()
  })

  afterAll(async () => {
    // Clean up database after config tests
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'postgres' })
  })

  it('should have MySQL dialect configured', () => {
    console.log('Main config dialect:', config.dialect)
    console.log('Test config dialect:', config.dialect)
    console.log('Database config:', config.database)

    expect(config.dialect).toBe('postgres')
    expect(config.database.database).toBe('test_db')
    expect(config.database.port).toBe(5432)
  })
})
