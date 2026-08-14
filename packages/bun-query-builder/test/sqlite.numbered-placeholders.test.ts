/**
 * `$1`-style placeholders have to mean on SQLite what they mean on Postgres:
 * `$n` is the n-th value, wherever it appears and however often.
 *
 * bun:sqlite treats `$1` as a NAME. Handed an array it binds values to those
 * names in order of FIRST APPEARANCE and ignores the numbers, so any statement
 * whose placeholders are not already in ascending order silently binds the
 * wrong values:
 *
 *   sql.unsafe('SELECT $2 AS a, $1 AS b', ['ONE', 'TWO'])  ->  a=ONE, b=TWO
 *
 * No error, no warning, wrong answer. It bites hardest in the queries that
 * repeat a parameter, which in practice are authorisation checks of the shape
 * "owner_id = $2 OR EXISTS (SELECT 1 ... user_id = $2)" - a permission decision
 * computed from whichever values happened to line up.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { bindNumberedPlaceholders } from '../src/db'

describe('bindNumberedPlaceholders', () => {
  test('binds by index, not by order of appearance', () => {
    const { sql, params } = bindNumberedPlaceholders('SELECT $2 AS a, $1 AS b', ['ONE', 'TWO'])

    expect(sql).toBe('SELECT ? AS a, ? AS b')
    expect(params).toEqual(['TWO', 'ONE'])
  })

  test('a repeated placeholder binds the same value at every occurrence', () => {
    const { sql, params } = bindNumberedPlaceholders(
      'SELECT 1 FROM projects p WHERE p.id = $1 AND (p.owner_id = $2 OR EXISTS (SELECT 1 FROM m WHERE m.user_id = $2))',
      [7, 42],
    )

    expect(sql).not.toContain('$')
    expect(params).toEqual([7, 42, 42])
  })

  test('already-ascending statements keep working', () => {
    const { sql, params } = bindNumberedPlaceholders('SELECT $1, $2, $3', ['a', 'b', 'c'])

    expect(sql).toBe('SELECT ?, ?, ?')
    expect(params).toEqual(['a', 'b', 'c'])
  })

  test('placeholders inside string literals are data, not parameters', () => {
    const { sql, params } = bindNumberedPlaceholders(
      `SELECT '$1 is a price' AS label, $1 AS value`,
      ['nine'],
    )

    expect(sql).toBe(`SELECT '$1 is a price' AS label, ? AS value`)
    expect(params).toEqual(['nine'])
  })

  test('an escaped quote does not end the literal early', () => {
    const { sql } = bindNumberedPlaceholders(
      `SELECT 'it''s $1 here' AS label, $1 AS value`,
      ['x'],
    )

    expect(sql).toBe(`SELECT 'it''s $1 here' AS label, ? AS value`)
  })

  test('placeholders inside quoted identifiers and comments are left alone', () => {
    const { sql, params } = bindNumberedPlaceholders(
      'SELECT "col$1" FROM t -- $1 in a comment\nWHERE id = $1',
      [3],
    )

    expect(sql).toContain('"col$1"')
    expect(sql).toContain('-- $1 in a comment')
    expect(sql).toContain('WHERE id = ?')
    expect(params).toEqual([3])
  })

  test('block comments are skipped too', () => {
    const { sql } = bindNumberedPlaceholders('SELECT /* $1 */ $1', ['v'])

    expect(sql).toBe('SELECT /* $1 */ ?')
  })

  test('statements with no numbered placeholders pass through untouched', () => {
    const positional = bindNumberedPlaceholders('SELECT ?, ?', ['a', 'b'])
    expect(positional.sql).toBe('SELECT ?, ?')
    expect(positional.params).toEqual(['a', 'b'])

    const none = bindNumberedPlaceholders('SELECT 1', [])
    expect(none.sql).toBe('SELECT 1')
  })

  test('referencing more parameters than were provided is an error, not a silent NULL', () => {
    expect(() => bindNumberedPlaceholders('SELECT $1, $3', ['only-one', 'and-two']))
      .toThrow('SQL references $3 but only 2 values were provided')
  })
})

describe('against a real sqlite database', () => {
  /** What the wrapper now does: rewrite, then bind. */
  function run(db: Database, sql: string, params: any[]): any[] {
    const bound = bindNumberedPlaceholders(sql, params)
    return db.prepare(bound.sql).all(...bound.params)
  }

  test('bun:sqlite really does bind $n by appearance, so the rewrite is load bearing', () => {
    const db = new Database(':memory:')

    // The bug, reproduced against the driver rather than asserted from memory:
    // handed the numbers out of order, bun:sqlite fills them by position.
    const raw = db.prepare('SELECT $2 AS a, $1 AS b').all('ONE', 'TWO') as Array<{ a: string, b: string }>
    expect(raw[0]).toEqual({ a: 'ONE', b: 'TWO' })

    // With the rewrite, $n means the n-th value.
    const fixed = run(db, 'SELECT $2 AS a, $1 AS b', ['ONE', 'TWO']) as Array<{ a: string, b: string }>
    expect(fixed[0]).toEqual({ a: 'TWO', b: 'ONE' })

    db.close()
  })

  test('an authorisation-shaped query answers with the values it was given', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE p (id INTEGER PRIMARY KEY, owner_id INTEGER)')
    db.run('CREATE TABLE m (project_id INTEGER, user_id INTEGER)')
    db.run('INSERT INTO p (id, owner_id) VALUES (1, 42)')
    db.run('INSERT INTO m (project_id, user_id) VALUES (1, 7)')

    const check = `SELECT 1 AS ok FROM p
      WHERE p.id = $1
        AND (p.owner_id = $2 OR EXISTS (SELECT 1 FROM m WHERE m.project_id = p.id AND m.user_id = $2))`

    expect(run(db, check, [1, 42])).toHaveLength(1) // the owner
    expect(run(db, check, [1, 7])).toHaveLength(1) // a member
    expect(run(db, check, [1, 99])).toHaveLength(0) // a stranger

    db.close()
  })
})
