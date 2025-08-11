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
})
