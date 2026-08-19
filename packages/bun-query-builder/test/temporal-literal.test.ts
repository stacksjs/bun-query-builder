// The datetime literal MySQL will accept, and the one an application writes.
//
// `new Date().toISOString()` is `2026-08-19T04:37:11.396Z`. Postgres takes it;
// MySQL answers "Incorrect datetime value" and refuses the row, because the
// `T`, the fraction and the `Z` are all outside what a DATETIME literal may
// contain. So the obvious application code is correct until the engine changes
// under it - found here writing `last_seen_at` on a push subscription.

import { describe, expect, test } from 'bun:test'
import { temporalLiteral } from '../src/client'

describe('a date, in the shape the dialect accepts', () => {
  test('reshapes ISO-8601 for MySQL', () => {
    expect(temporalLiteral('2026-08-19T04:37:11.396Z', 'mysql')).toBe('2026-08-19 04:37:11')
    expect(temporalLiteral(new Date('2026-08-19T04:37:11.396Z'), 'mysql')).toBe('2026-08-19 04:37:11')
  })

  test('leaves a value already in that shape exactly as it is', () => {
    // Not a round trip through `new Date()`: parsing a zoneless string reads it
    // as *local* time, so `toISOString()` would shift the digits by the host's
    // offset and call it a fix.
    expect(temporalLiteral('2026-08-19 04:37:11', 'mysql')).toBe('2026-08-19 04:37:11')
    expect(temporalLiteral('2026-08-19T04:37:11', 'mysql')).toBe('2026-08-19 04:37:11')
  })

  test('fills in the seconds a shorter form leaves out', () => {
    expect(temporalLiteral('2026-08-19T04:37', 'mysql')).toBe('2026-08-19 04:37:00')
  })

  test('leaves anything that is not a date alone', () => {
    for (const value of ['not a date', '', 42, null, undefined, true])
      expect(temporalLiteral(value, 'mysql')).toBe(value as any)
  })

  test('does nothing on Postgres, which takes ISO-8601 as written', () => {
    expect(temporalLiteral('2026-08-19T04:37:11.396Z', 'postgres')).toBe('2026-08-19T04:37:11.396Z')
  })
})
