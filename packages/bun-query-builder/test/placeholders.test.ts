/**
 * `?` placeholders, rewritten for Postgres.
 *
 * The motivating failure: a WHERE built as `project_id = ? AND occurred_at >= ?`
 * is rejected by Postgres with `syntax error at or near "AND"`, which points at
 * a token that is not the problem. An application written against SQLite meets
 * this the first time its raw SQL runs on Postgres.
 *
 * Most of these are about what must NOT be rewritten. A global replace passes
 * the simple cases and corrupts a query the day somebody stores a question mark.
 */
import { describe, expect, it } from 'bun:test'
import { toDialectPlaceholders } from '../src/sql-fragments'

describe('toDialectPlaceholders', () => {
  it('numbers placeholders in order for postgres', () => {
    expect(toDialectPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', 'postgres'))
      .toBe('SELECT * FROM t WHERE a = $1 AND b = $2')
  })

  it('keeps counting past nine', () => {
    const sql = `SELECT ${Array.from({ length: 11 }, () => '?').join(', ')}`

    expect(toDialectPlaceholders(sql, 'postgres')).toContain('$10')
    expect(toDialectPlaceholders(sql, 'postgres')).toContain('$11')
  })

  it.each(['sqlite', 'mysql', 'singlestore', 'vitess'] as const)('leaves %s untouched', (dialect) => {
    const sql = 'SELECT * FROM t WHERE a = ? AND b = ?'

    expect(toDialectPlaceholders(sql, dialect)).toBe(sql)
  })

  it('leaves a question mark inside a string literal alone', () => {
    const sql = 'SELECT * FROM t WHERE label = \'why?\' AND a = ?'

    expect(toDialectPlaceholders(sql, 'postgres'))
      .toBe('SELECT * FROM t WHERE label = \'why?\' AND a = $1')
  })

  it('handles a doubled quote inside a literal', () => {
    // The '' is an escaped apostrophe, not the end of the string, so the ?
    // after it is still inside the literal.
    const sql = 'SELECT \'it\'\'s ok?\' , ?'

    expect(toDialectPlaceholders(sql, 'postgres')).toBe('SELECT \'it\'\'s ok?\' , $1')
  })

  it('leaves a question mark inside a quoted identifier alone', () => {
    const sql = 'SELECT "weird?column" FROM t WHERE a = ?'

    expect(toDialectPlaceholders(sql, 'postgres'))
      .toBe('SELECT "weird?column" FROM t WHERE a = $1')
  })

  it('leaves a dollar-quoted block alone', () => {
    const sql = 'SELECT $tag$ a ? b $tag$, ?'

    expect(toDialectPlaceholders(sql, 'postgres')).toBe('SELECT $tag$ a ? b $tag$, $1')
  })

  it('leaves an empty-tag dollar-quoted block alone', () => {
    const sql = 'SELECT $$ a ? b $$, ?'

    expect(toDialectPlaceholders(sql, 'postgres')).toBe('SELECT $$ a ? b $$, $1')
  })

  it('does not disturb existing numbered placeholders', () => {
    // A statement already written for Postgres passes through unharmed, so this
    // is safe to apply to every statement rather than only the ones known to
    // use `?`.
    const sql = 'SELECT * FROM t WHERE a = $1 AND b = $2'

    expect(toDialectPlaceholders(sql, 'postgres')).toBe(sql)
  })

  it('survives an unterminated literal rather than looping', () => {
    expect(() => toDialectPlaceholders('SELECT \'unterminated', 'postgres')).not.toThrow()
  })

  it('returns an empty string unchanged', () => {
    expect(toDialectPlaceholders('', 'postgres')).toBe('')
  })
})
