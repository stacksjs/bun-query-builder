/**
 * Regression coverage for stacksjs/bun-query-builder#1032.
 *
 * Filed as "Postgres UPDATE/DELETE report 0 affected (extractChanges falls back
 * to array length)". Verified NOT reproducible against live Postgres: Bun
 * returns a non-RETURNING write result as an empty array carrying `count`, and
 * extractChanges checks `count` before the `length` fallback. These shape-based
 * unit tests lock that ordering in.
 */

import { describe, expect, it } from 'bun:test'
import { extractChanges, extractInsertId } from '../src/orm'

// A Bun result is an array; the metadata rides as extra own-properties.
function withProps<T extends any[]>(arr: T, props: Record<string, unknown>): T {
  return Object.assign(arr, props)
}

describe('extractChanges (#1032)', () => {
  it('Postgres UPDATE/DELETE: returns count, not the empty-array length', () => {
    // Exact live-PG shape: [] with count/affectedRows/command.
    const pgUpdate = withProps([] as any[], { count: 2, affectedRows: null, command: 'UPDATE' })
    expect(extractChanges(pgUpdate)).toBe(2)
    const pgDelete = withProps([] as any[], { count: 1, affectedRows: null, command: 'DELETE' })
    expect(extractChanges(pgDelete)).toBe(1)
  })

  it('MySQL: returns affectedRows', () => {
    expect(extractChanges({ affectedRows: 3 })).toBe(3)
  })

  it('falls back to array length only when no count/affectedRows', () => {
    expect(extractChanges(withProps([{}, {}] as any[], {}))).toBe(2)
    expect(extractChanges(null)).toBe(0)
  })
})

describe('extractInsertId (#1032 sibling)', () => {
  it('reads MySQL insertId and bun:sqlite lastInsertRowid; null otherwise', () => {
    expect(extractInsertId({ insertId: 5 })).toBe(5)
    expect(extractInsertId({ lastInsertRowid: 9 })).toBe(9)
    // Postgres write result carries lastInsertRowid: null → no id here (insert
    // path uses RETURNING instead).
    expect(extractInsertId(withProps([] as any[], { count: 1, lastInsertRowid: null }))).toBeNull()
  })
})
