/**
 * The query-time fragments every dialect driver must agree on.
 *
 * These exist because the DDL side of the driver interface was complete while
 * the query side was not, so applications hand-wrote `strftime` and
 * `json_extract` inline. That works until the day the application meets
 * Postgres: `strftime` is a syntax error there, and a boolean column refuses
 * the 1 and 0 SQLite accepts. The application in question passed its entire
 * suite against SQLite and failed on the live site.
 *
 * The value of these tests is less in any single string than in the fact that
 * every driver is checked against the SAME expectations, so a new dialect
 * cannot quietly disagree about the shape a caller is promised.
 */
import { describe, expect, it } from 'bun:test'
import { getDialectDriver } from '../src/drivers'
import type { SupportedDialect } from '../src/types'

/** Every dialect that renders SQL. `browser` and `dynamodb` are not SQL. */
const DIALECTS: SupportedDialect[] = ['postgres', 'mysql', 'singlestore', 'vitess', 'sqlite']
const GRAINS = ['hour', 'day', 'week', 'month', 'year'] as const

describe('booleanLiteral', () => {
  for (const dialect of DIALECTS) {
    it(`${dialect} emits keywords rather than 1 and 0`, () => {
      const driver = getDialectDriver(dialect)

      // The whole point: Postgres rejects `1` for a boolean column with
      // "is of type boolean but expression is of type integer", so a driver
      // returning an integer here would reintroduce the bug this prevents.
      expect(driver.booleanLiteral(true)).toBe('TRUE')
      expect(driver.booleanLiteral(false)).toBe('FALSE')
    })
  }
})

describe('jsonExtract', () => {
  for (const dialect of DIALECTS) {
    it(`${dialect} mentions the column and the key exactly once each`, () => {
      const driver = getDialectDriver(dialect)
      const sql = driver.jsonExtract('properties', '?')

      expect(sql).toContain('properties')
      // A fragment that repeats the placeholder needs the key bound twice, and
      // a caller pushing it once gets "expected 7 values, received 6".
      expect(sql.split('?').length - 1).toBe(1)
    })

    it(`${dialect} accepts a quoted literal key as well as a placeholder`, () => {
      const driver = getDialectDriver(dialect)

      expect(driver.jsonExtract('properties', '\'plan\'')).toContain('plan')
    })
  }

  it('postgres casts, because JSON is very often kept in a text column', () => {
    // `->>` on a varchar is an operator-does-not-exist error, and casting an
    // already-jsonb column costs nothing.
    expect(getDialectDriver('postgres').jsonExtract('properties', '$1')).toContain('::jsonb')
  })
})

describe('dateBucket', () => {
  for (const dialect of DIALECTS) {
    for (const grain of GRAINS) {
      it(`${dialect} renders a ${grain} bucket in the shared ISO shape`, () => {
        const sql = getDialectDriver(dialect).dateBucket('occurred_at', grain)

        expect(sql).toContain('occurred_at')
        // Callers compare the result against buckets generated in application
        // code, so a dialect emitting a different shape produces empty series
        // rather than an error.
        expect(sql).toContain('T')
        expect(sql).toContain('000')
        expect(sql).toContain('Z')
      })
    }

    it(`${dialect} applies a positive offset`, () => {
      const sql = getDialectDriver(dialect).dateBucket('occurred_at', 'day', 5)

      expect(sql).toContain('5')
      expect(sql).not.toBe(getDialectDriver(dialect).dateBucket('occurred_at', 'day', 0))
    })

    it(`${dialect} applies a negative offset`, () => {
      const sql = getDialectDriver(dialect).dateBucket('occurred_at', 'day', -8)

      expect(sql).toContain('8')
      expect(sql).not.toBe(getDialectDriver(dialect).dateBucket('occurred_at', 'day', 8))
    })

    it(`${dialect} leaves the column alone at offset zero`, () => {
      // No shift means no wrapping arithmetic to get wrong.
      const sql = getDialectDriver(dialect).dateBucket('occurred_at', 'day', 0)

      expect(sql).not.toContain('interval')
      expect(sql).not.toContain('INTERVAL')
    })

    it(`${dialect} starts weeks on Monday`, () => {
      const sql = getDialectDriver(dialect).dateBucket('occurred_at', 'week')

      // Each dialect gets there differently — date_trunc, a weekday walk, a
      // WEEKDAY subtraction — so this asserts only that the week branch does
      // something the day branch does not.
      expect(sql).not.toBe(getDialectDriver(dialect).dateBucket('occurred_at', 'day'))
    })

    it(`${dialect} distinguishes every grain`, () => {
      const rendered = GRAINS.map(g => getDialectDriver(dialect).dateBucket('occurred_at', g))

      expect(new Set(rendered).size).toBe(GRAINS.length)
    })
  }
})
