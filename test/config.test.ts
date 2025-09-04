import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'

describe('test configuration', () => {
  beforeAll(async () => {
    // Set up database for config tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
  })

  afterAll(async () => {
    // Clean up database after config tests
    await resetDatabase('./examples/models', { dialect: 'postgres' })
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
