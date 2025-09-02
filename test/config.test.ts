import { describe, expect, it } from 'bun:test'
import { config } from '../src/config'

describe('test configuration', () => {
  it('should have MySQL dialect configured', () => {
    console.log('Main config dialect:', config.dialect)
    console.log('Test config dialect:', config.dialect)
    console.log('Database config:', config.database)
    
    expect(config.dialect).toBe('mysql')
    expect(config.database.database).toBe('test_db')
    expect(config.database.port).toBe(3306)
  })
})
