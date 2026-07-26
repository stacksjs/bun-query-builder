import { describe, expect, it } from 'bun:test'
import { createConnectionString } from '../src/db'

describe('createConnectionString — sqlite URLs', () => {
  const base = { database: 'app.db' }

  it('strips the scheme and authority from an authority-less relative URL', () => {
    expect(createConnectionString('sqlite', { ...base, url: 'sqlite://./other.db' })).toBe('./other.db')
  })

  it('keeps the leading slash of an absolute path', () => {
    expect(createConnectionString('sqlite', { ...base, url: 'sqlite:///var/lib/app.db' })).toBe('/var/lib/app.db')
  })

  it('accepts the scheme-only and file: forms', () => {
    expect(createConnectionString('sqlite', { ...base, url: 'sqlite:app.db' })).toBe('app.db')
    expect(createConnectionString('sqlite', { ...base, url: 'file:app.db' })).toBe('app.db')
  })

  it('passes :memory: through', () => {
    expect(createConnectionString('sqlite', { ...base, url: 'sqlite::memory:' })).toBe(':memory:')
  })

  it('leaves a bare path untouched', () => {
    expect(createConnectionString('sqlite', { ...base, url: './plain.db' })).toBe('./plain.db')
  })

  it('does not touch network-dialect URLs', () => {
    const url = 'postgres://u:p@h:5432/d'
    expect(createConnectionString('postgres', { ...base, url })).toBe(url)
  })
})
