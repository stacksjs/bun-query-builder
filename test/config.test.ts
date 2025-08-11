import { describe, expect, it } from 'bun:test'
import { config } from '../src/config'

describe('config defaults', () => {
  it('has sensible defaults', () => {
    expect(config.verbose).toBeTrue()
    expect(['postgres', 'mysql', 'sqlite']).toContain(config.dialect)
    expect(config.timestamps.createdAt.length).toBeGreaterThan(0)
    expect(config.pagination.defaultPerPage).toBeGreaterThan(0)
    expect(config.transactionDefaults.retries).toBeGreaterThanOrEqual(0)
  })

  it('includes sql and feature toggles', () => {
    expect(['RANDOM()', 'RAND()']).toContain(config.sql.randomFunction)
    expect(['FOR SHARE', 'LOCK IN SHARE MODE']).toContain(config.sql.sharedLockSyntax)
    expect(['operator', 'function']).toContain(config.sql.jsonContainsMode)
    expect(typeof config.features.distinctOn).toBe('boolean')
  })
})
