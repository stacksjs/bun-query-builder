import { describe, expect, it } from 'bun:test'
import { config } from '../src/config'
import { testConfigApplied } from './test-config'

describe('test configuration', () => {
  it('should have MySQL dialect configured', () => {
    console.log('Main config dialect:', config.dialect)
    console.log('Test config dialect:', testConfigApplied.dialect)
    console.log('Database config:', testConfigApplied.database)
    
    expect(testConfigApplied.dialect).toBe('mysql')
    expect(testConfigApplied.database.database).toBe('test_db')
    expect(testConfigApplied.database.port).toBe(3306)
  })
})
