/**
 * `whereNull` and `whereNotNull` on UPDATE and DELETE.
 *
 * The select builder has had both for a long time. Updates and deletes had
 * neither, and the omission is not cosmetic: `IS NULL` is a predicate rather
 * than a comparison, so `where(column, 'is', null)` binds the null and produces
 * `"col" is $1`, which every server rejects. With no `whereNull` to reach for,
 * an optimistic lock - claim this row only if nobody else has - could not be
 * written against a write at all.
 *
 * That is not hypothetical. `@stacksjs/queue` reserves a job with exactly that
 * shape, so every reserve threw `whereNull is not a function` into a bare
 * `catch` and the database queue driver never processed anything: the worker
 * polled forever and reported "Listening for jobs..." once a second.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    jobs: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        queue: { type: 'text' },
        reserved_at: { type: 'integer' },
        attempts: { type: 'integer' },
      },
    },
  } as any

  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('whereNull on an UPDATE', () => {
  it('renders IS NULL rather than binding the null', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ attempts: 1 })
      .whereNull('reserved_at')
      .toSQL())

    expect(sql).toContain('IS NULL')
    expect(sql).toContain('"reserved_at"')
    // The tell for the bug this replaces: a placeholder after IS.
    expect(sql).not.toMatch(/is\s+\$\d/i)
  })

  it('renders IS NOT NULL', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ attempts: 1 })
      .whereNotNull('reserved_at')
      .toSQL())

    expect(sql).toContain('IS NOT NULL')
  })

  /**
   * The reserve. A first `where` opens the clause and the null predicate has to
   * continue it with `AND`, or the statement reads `... WHERE id = $2 WHERE
   * reserved_at IS NULL` and fails on the second `WHERE`.
   */
  it('continues an existing WHERE with AND, which is what a reserve needs', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ reserved_at: 1700000000, attempts: 1 })
      .where('id', '=', 7)
      .whereNull('reserved_at')
      .toSQL())

    expect(sql).toMatch(/WHERE .*AND .*"reserved_at" IS NULL/s)
    expect(sql.match(/WHERE/g)).toHaveLength(1)
  })

  it('opens the clause with WHERE when it is the only condition', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ attempts: 1 })
      .whereNull('reserved_at')
      .toSQL())

    expect(sql).toMatch(/WHERE "reserved_at" IS NULL/)
  })

  it('quotes the identifier, so a column named oddly cannot end the string', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ attempts: 1 })
      .whereNull('weird"name')
      .toSQL())

    expect(sql).toContain('"weird""name" IS NULL')
  })

  it('chains with a following where', () => {
    const sql = String((qb() as any)
      .updateTable('jobs')
      .set({ attempts: 1 })
      .whereNull('reserved_at')
      .where('queue', '=', 'default')
      .toSQL())

    expect(sql).toMatch(/WHERE "reserved_at" IS NULL AND "queue" = /)
  })
})

describe('whereNull on a DELETE', () => {
  it('renders IS NULL rather than binding the null', () => {
    const sql = String((qb() as any).deleteFrom('jobs').whereNull('reserved_at').toSQL())

    expect(sql).toContain('"reserved_at" IS NULL')
    expect(sql).not.toMatch(/is\s+\$\d/i)
  })

  it('renders IS NOT NULL', () => {
    const sql = String((qb() as any).deleteFrom('jobs').whereNotNull('reserved_at').toSQL())

    expect(sql).toContain('"reserved_at" IS NOT NULL')
  })

  it('continues an existing WHERE with AND', () => {
    const sql = String((qb() as any)
      .deleteFrom('jobs')
      .where('queue', '=', 'default')
      .whereNull('reserved_at')
      .toSQL())

    expect(sql).toMatch(/WHERE .*AND .*"reserved_at" IS NULL/s)
    expect(sql.match(/WHERE/g)).toHaveLength(1)
  })
})
