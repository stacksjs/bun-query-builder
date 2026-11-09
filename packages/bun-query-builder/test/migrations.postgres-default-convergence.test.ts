/**
 * `generateMigration({ fromDb: true })` has to converge: apply what it writes,
 * run it again, and the second run should have nothing to say.
 *
 * On Postgres it never did. Every run re-emitted
 *
 *   ALTER TABLE "activities" ALTER COLUMN "created_at" SET default (now() AT TIME ZONE 'utc');
 *   ALTER TABLE "coupons" ALTER COLUMN "is_active" SET default true;
 *
 * for all 104 timestamp columns and all 25 boolean defaults of a Stacks dev
 * database - about 130 statements, written into a fresh `auto-misc` file each
 * time. Both came from `canonicalizeDefault` reading the live default out of
 * `information_schema.columns.column_default`, which is how Postgres *stores*
 * the expression rather than how it was written:
 *
 *  - `DEFAULT (now() AT TIME ZONE 'utc')` is stored as
 *    `(now() AT TIME ZONE 'utc'::text)`. The cast strip was anchored to the end
 *    of the string, and this cast sits before the closing parenthesis, so the
 *    live default never reached the UTC marker the model side canonicalizes to.
 *  - a live boolean default arrives as the text `true`, which the SQL-function
 *    check returned as `TRUE`, while the model's JS `true` became `1`.
 *
 * The test is the one the issue asked for: put the live spelling and the model
 * spelling of the same default through `canonicalizeDefault` and expect them to
 * come out equal.
 */

import { describe, expect, it } from 'bun:test'
import { canonicalizeDefault, UTC_CLOCK_DEFAULT } from '../src/migrations'

function column(type: string, defaultValue: unknown) {
  return {
    name: 'x',
    type,
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    hasDefault: true,
    defaultValue,
  } as any
}

const canonical = (type: string, defaultValue: unknown) =>
  canonicalizeDefault(column(type, defaultValue), 'postgres')

describe('canonicalizeDefault on Postgres: live spelling vs model spelling', () => {
  /** The spelling Postgres hands back for `(now() AT TIME ZONE 'utc')`. */
  it('reads the stored UTC clock with its inner cast as the UTC marker', () => {
    expect(canonical('datetime', '(now() AT TIME ZONE \'utc\'::text)')).toBe(UTC_CLOCK_DEFAULT)
  })

  it('agrees with the model spelling of the UTC clock', () => {
    expect(canonical('datetime', '(now() AT TIME ZONE \'utc\'::text)'))
      .toBe(canonical('datetime', '(now() AT TIME ZONE \'utc\')'))
  })

  /** The other spellings of the same clock still land on the marker. */
  it.each([
    'UTC_TIMESTAMP',
    'utc_timestamp()',
    'timezone(\'utc\'::text, now())',
    'timezone(\'utc\', now())',
    'now() AT TIME ZONE \'utc\'',
    '(NOW() AT TIME ZONE \'UTC\'::TEXT)',
  ])('reads %p as the UTC marker', (spelling) => {
    expect(canonical('datetime', spelling)).toBe(UTC_CLOCK_DEFAULT)
  })

  /** The local clock is a different value, and that difference is the bug. */
  it('keeps CURRENT_TIMESTAMP distinct from the UTC clock', () => {
    expect(canonical('datetime', 'CURRENT_TIMESTAMP')).not.toBe(UTC_CLOCK_DEFAULT)
  })

  it('agrees on a boolean default of true', () => {
    expect(canonical('boolean', 'true')).toBe(canonical('boolean', true))
  })

  it('agrees on a boolean default of false', () => {
    expect(canonical('boolean', 'false')).toBe(canonical('boolean', false))
  })

  it.each([
    ['true', '1'],
    ['TRUE', '1'],
    ['t', '1'],
    ['1', '1'],
    ['false', '0'],
    ['FALSE', '0'],
    ['f', '0'],
    ['0', '0'],
  ])('normalizes the live boolean %p to %p', (live, expected) => {
    expect(canonical('boolean', live)).toBe(expected)
  })

  /** TRUE/FALSE outside a boolean column keep reading as SQL keywords. */
  it('leaves TRUE alone on a non-boolean column', () => {
    expect(canonical('string', 'TRUE')).toBe('TRUE')
  })
})

describe('canonicalizeDefault: casts away from the end of the expression', () => {
  it.each([
    ['\'active\'::text', 'active'],
    ['\'pending\'::character varying(20)', 'pending'],
    ['\'{}\'::jsonb', '{}'],
    ['\'{}\'::text[]', '{}'],
    ['(0)::numeric(10,2)', '0'],
    ['nextval(\'users_id_seq\'::regclass)', 'nextval(\'users_id_seq\')'],
  ])('strips the cast in %p', (live, expected) => {
    expect(canonical('string', live)).toBe(expected)
  })

  /** A `::` that is part of the value itself is not a cast. */
  it('keeps a :: that lives inside the string literal', () => {
    expect(canonical('string', '\'a::b\'::text')).toBe('a::b')
  })

  /** Only the type name and its own continuation words are consumed. */
  it('does not swallow the tail of an expression after a cast', () => {
    expect(canonical('string', '\'x\'::text || \'y\'::text')).toBe('\'x\' || \'y\'')
  })
})

/**
 * The same family of difference: Postgres brackets the expression it stored, so
 * a `decimal` column declared `DEFAULT 0` reads back as `(0)::numeric(10,2)`
 * while the model says `0`.
 */
describe('canonicalizeDefault: parentheses and quotes the engine added', () => {
  it('agrees with the model on a bracketed numeric default', () => {
    expect(canonical('decimal', '(0)::numeric(10,2)')).toBe(canonical('decimal', 0))
  })

  it.each([
    ['(0)::numeric(10,2)', '0'],
    ['(\'x\'::text)', 'x'],
    ['((1))', '1'],
  ])('unwraps %p to %p', (live, expected) => {
    expect(canonical('string', live)).toBe(expected)
  })

  /** Parentheses that belong to the expression stay where they are. */
  it.each([
    '(a) || (b)',
    'nextval(\'users_id_seq\')',
  ])('leaves the parentheses of %p alone', (expr) => {
    expect(canonical('string', expr)).toBe(expr)
  })

  /** A quote the engine doubled inside a literal is one character. */
  it('undoubles an escaped quote', () => {
    expect(canonical('string', '\'it\'\'s\'::text')).toBe('it\'s')
  })
})
