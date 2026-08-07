/**
 * The attribute-to-column-name conversion the migration generator performs.
 *
 * It carried a third rule, `.replace(/(\d)([A-Z])/gi, '$1_$2')`, and the `i`
 * flag is the whole bug: it made the rule match a digit followed by a
 * *lowercase* letter, which is never a word boundary. `p256dh` is one token -
 * it is the name the Push API gives a subscription key - and it came out of the
 * generator as `p256_dh`.
 *
 * The application's model said `p256dh`. The generated migration said
 * `p256_dh`. The query that read it back found nothing, and nothing anywhere
 * raised an error: both spellings look plausible and the symptom is an empty
 * result. That combination is why this is pinned rather than left to review.
 *
 * Without the flag the rule was redundant with `([a-z\d])([A-Z])` above it,
 * which already splits `sha256Sum` on the only boundary it has - so it was
 * removed rather than corrected.
 */

import { describe, expect, it } from 'bun:test'

/** Kept in step with `snakeCase` in `src/migrations.ts`. */
function snakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

describe('column names from model attributes', () => {
  it('splits on a case change, which is where the boundary is', () => {
    expect(snakeCase('companyName')).toBe('company_name')
    expect(snakeCase('billingEmail')).toBe('billing_email')
    expect(snakeCase('createdAt')).toBe('created_at')
    expect(snakeCase('isPersonal')).toBe('is_personal')
  })

  it('handles an acronym run', () => {
    expect(snakeCase('HTMLParser')).toBe('html_parser')
    expect(snakeCase('userID')).toBe('user_id')
  })

  it('does not split a digit from a lowercase letter', () => {
    // The regression. Every one of these is a single token in the
    // specification it comes from, and every one used to gain an underscore.
    expect(snakeCase('p256dh')).toBe('p256dh')
    expect(snakeCase('utf8text')).toBe('utf8text')
    expect(snakeCase('base64url')).toBe('base64url')
    expect(snakeCase('sha256sum')).toBe('sha256sum')
    expect(snakeCase('oauth2')).toBe('oauth2')
    expect(snakeCase('ipv4address')).toBe('ipv4address')
  })

  it('still splits a digit from an uppercase letter', () => {
    // A real boundary, and already handled by the lowercase-to-uppercase rule.
    // This is what the removed rule was presumably meant to catch, and it never
    // needed to.
    expect(snakeCase('sha256Sum')).toBe('sha256_sum')
    expect(snakeCase('base64Url')).toBe('base64_url')
    expect(snakeCase('ipv4Address')).toBe('ipv4_address')
  })

  it('leaves an already snake_case name alone', () => {
    // Model attributes are written both ways and a generator that mangled the
    // second would rename half a schema on the next regeneration.
    expect(snakeCase('user_id')).toBe('user_id')
    expect(snakeCase('last_seen_at')).toBe('last_seen_at')
    expect(snakeCase('p256dh')).toBe('p256dh')
  })
})
