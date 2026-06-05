/**
 * Unit coverage for the shared relation-normalization helpers (#1042) — the
 * single source of truth now consumed by both meta.ts and migrations.ts.
 */

import { describe, expect, it } from 'bun:test'
import { normalizeRelationEntry, normalizeRelationList } from '../src/relation-utils'

describe('normalizeRelationEntry (#1042)', () => {
  it('unwraps string and object forms; rejects invalid', () => {
    expect(normalizeRelationEntry('User')).toEqual({ model: 'User' })
    expect(normalizeRelationEntry({ model: 'User', foreignKey: 'user_id', onDelete: 'cascade' }))
      .toEqual({ model: 'User', foreignKey: 'user_id', onDelete: 'cascade' })
    expect(normalizeRelationEntry({ noModel: true } as any)).toBeNull()
    expect(normalizeRelationEntry(42 as any)).toBeNull()
  })
})

describe('normalizeRelationList (#1042)', () => {
  it('flattens every supported declaration shape', () => {
    expect(normalizeRelationList(['Order', 'Customer']))
      .toEqual([{ model: 'Order' }, { model: 'Customer' }])
    expect(normalizeRelationList([{ model: 'Order', onDelete: 'cascade' }, 'User']))
      .toEqual([{ model: 'Order', onDelete: 'cascade' }, { model: 'User' }])
    expect(normalizeRelationList({ order: 'Order' })).toEqual([{ model: 'Order' }])
    expect(normalizeRelationList({ order: { model: 'Order', foreignKey: 'oid' } }))
      .toEqual([{ model: 'Order', foreignKey: 'oid' }])
    expect(normalizeRelationList(undefined)).toEqual([])
    // Invalid entries dropped.
    expect(normalizeRelationList(['User', null, { x: 1 }])).toEqual([{ model: 'User' }])
  })
})
