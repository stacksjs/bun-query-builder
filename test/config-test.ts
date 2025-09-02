import { describe, expect, it } from 'bun:test'
import { config } from '../src/config'

describe('test configuration', () => {
  it('should have MySQL dialect configured', () => {
    expect(config.dialect).toBe('mysql')
    expect(config.database.database).toBe('test_db')
    expect(config.database.port).toBe(3306)
  })
})
