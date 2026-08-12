/**
 * `where(column, 'in', values)` on UPDATE and DELETE.
 *
 * `IN` takes a list, and the only way to express a list of bound values is one
 * placeholder per element. The select builder learned that in
 * stacksjs/bun-query-builder#1013; the write builders were left behind, so they
 * bound the whole array to a single placeholder and emitted `"id" in $1`.
 * Postgres answers `syntax error at or near "$1"`, SQLite rejects it too, and
 * the call site looks identical to the one that works on a select - which reads
 * as a bug in the caller rather than in the builder.
 *
 * The shape that found it: mark these notifications read, given the ids the
 * filter left.
 *
 *   db.updateTable('notifications')
 *     .set({ read_at: now })
 *     .where('user_id', '=', reader)
 *     .where('id', 'in', ids)
 *
 * The delete builder also interpolated its operator into the statement text
 * without checking it against the allowed set, which updateTable has always
 * done. That is asserted here too: a DELETE is the one statement where an
 * injected operator cannot be walked back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder } from '../src'

function qb() {
  const models = {
    notifications: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        user_id: { type: 'integer' },
        read_at: { type: 'text' },
      },
    },
  } as any

  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

// The dialect decides whether placeholders are `$n` or `?`, and it lives in
// process-wide config — so without pinning it here these assertions depended on
// whichever test file happened to run first. Pinned rather than hedged, because
// the numbering (`$2, $3`, not `$1, $2`) is exactly what this file is about:
// an IN that restarted at $1 would update every row in the table.
describe('IN on an UPDATE', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect; config.dialect = 'postgres' as any })
  afterEach(() => { config.dialect = dialect as any })

  it('renders one placeholder per element, parenthesised', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('id', 'in', [1, 2, 3])
      .toSQL())

    expect(sql).toContain('IN (')
    expect(sql).toContain('"id"')
    // The tell for the bug this replaces: IN followed by a bare placeholder.
    expect(sql).not.toMatch(/IN\s+\$\d/i)
  })

  it('numbers its placeholders after the ones SET already used', () => {
    // The SET clause binds first. An IN that restarted at $1 would update every
    // row in the table with the read timestamp shifted into the predicate.
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('id', 'in', [7, 8])
      .toSQL())

    expect(sql).toContain('IN ($2, $3)')
  })

  it('continues an existing WHERE with AND rather than opening a second one', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('user_id', '=', 5)
      .where('id', 'in', [1, 2])
      .toSQL())

    expect(sql.match(/WHERE/gi)).toHaveLength(1)
    expect(sql).toContain('AND')
  })

  it('accepts a single value as a list of one', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('id', 'in', 4)
      .toSQL())

    expect(sql).toContain('IN (')
  })

  it('NOT IN, too', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('id', 'not in', [1, 2])
      .toSQL())

    expect(sql).toContain('NOT IN (')
  })

  it('the array form behaves the same as the three-argument form', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where(['id', 'in', [1, 2]])
      .toSQL())

    expect(sql).toContain('IN ($2, $3)')
  })

  it('leaves ordinary operators alone', () => {
    const sql = String((qb() as any)
      .updateTable('notifications')
      .set({ read_at: 'now' })
      .where('user_id', '=', 5)
      .toSQL())

    expect(sql).toContain('"user_id" =')
    expect(sql).not.toContain('IN (')
  })
})

describe('IN on a DELETE', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect; config.dialect = 'postgres' as any })
  afterEach(() => { config.dialect = dialect as any })

  it('renders one placeholder per element', () => {
    const sql = String((qb() as any)
      .deleteFrom('notifications')
      .where('id', 'in', [1, 2, 3])
      .toSQL())

    expect(sql).toContain('IN (')
    expect(sql).not.toMatch(/IN\s+\$\d(?!\))/i)
  })

  it('continues an existing WHERE with AND', () => {
    const sql = String((qb() as any)
      .deleteFrom('notifications')
      .where('user_id', '=', 5)
      .where('id', 'in', [1, 2])
      .toSQL())

    expect(sql.match(/WHERE/gi)).toHaveLength(1)
    expect(sql).toContain('AND')
  })

  it('the array form, too', () => {
    const sql = String((qb() as any)
      .deleteFrom('notifications')
      .where(['id', 'not in', [1, 2]])
      .toSQL())

    expect(sql).toContain('NOT IN (')
  })

  it('refuses an operator that is not in the allowed set', () => {
    // updateTable has always asserted this and deleteFrom did not, so the
    // operator reached the statement text unchecked.
    expect(() => (qb() as any)
      .deleteFrom('notifications')
      .where('id', '= 1 OR 1=1 --', 1)
      .toSQL()).toThrow(/refusing to use/)
  })
})
