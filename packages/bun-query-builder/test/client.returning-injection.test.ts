/**
 * Identifier injection on `returning()` — insert, update and delete.
 *
 * All three interpolated `cols.join(', ')` straight into the RETURNING clause,
 * and the two MySQL read-backs interpolated the same list into a `SELECT`.
 * RETURNING hands its columns back to the caller, so the slot was a read
 * primitive over the whole connection, the way `max()` was before #1181.
 * Measured before the fix:
 *
 *   .returning('id, (SELECT token FROM secrets LIMIT 1)')
 *   INSERT INTO "users"("name")VALUES($1) RETURNING id, (SELECT token FROM secrets LIMIT 1)
 *   UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING id, (SELECT token FROM secrets LIMIT 1)
 *   DELETE FROM "users" WHERE "id" = $1 RETURNING id, (SELECT token FROM secrets LIMIT 1)
 *
 * No stacked statement, so it works wherever the driver refuses multiple
 * statements — the same shape as #1185's sumOver reproduction.
 *
 * Two existing shapes had to keep working, and the second is why the guard
 * flattens rather than validating the arguments as given:
 *
 *   - `returningAll()` IS `returning('*')` (client.returning-all.test.ts).
 *   - `.returning(['id', 'uuid'])` arrives as ONE array argument, not two.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        uuid: { type: 'text' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

const REFUSED = /is not a plain column reference/
const PAYLOAD = 'id, (SELECT token FROM secrets LIMIT 1)'

describe('returning() refuses an injected column', () => {
  it('on an insert', () => {
    expect(() => qb().insertInto('users').values({ name: 'a' }).returning(PAYLOAD)).toThrow(REFUSED)
  })

  it('on an update', () => {
    expect(() => qb().updateTable('users').set({ name: 'a' }).where({ id: 1 }).returning(PAYLOAD)).toThrow(REFUSED)
  })

  it('on a delete', () => {
    expect(() => qb().deleteFrom('users').where({ id: 1 }).returning(PAYLOAD)).toThrow(REFUSED)
  })

  it('when only one name of several is hostile', () => {
    expect(() => qb().insertInto('users').values({ name: 'a' }).returning('id', PAYLOAD)).toThrow(REFUSED)
  })

  it('inside the array form, which arrives as one argument', () => {
    // `.returning(['id', 'uuid'])` is a single array argument, so a guard that
    // only checked the arguments as given would stringify the array whole and
    // never see the element.
    expect(() => qb().insertInto('users').values({ name: 'a' }).returning(['id', PAYLOAD])).toThrow(REFUSED)
  })

  it('on an insert with no rows, before the empty-batch short circuit', () => {
    // `if (noRows) return emptyReturningBuilder()` sat above the clause, so an
    // empty batch must not be a way to skip the check.
    expect(() => qb().insertInto('users').values([]).returning(PAYLOAD)).toThrow(REFUSED)
  })
})

describe('returning() keeps the shapes it already supported', () => {
  it('returningAll() is still RETURNING *', () => {
    expect(String(qb().insertInto('users').values({ name: 'a' }).returningAll().toSQL()))
      .toContain('RETURNING *')
    expect(String(qb().updateTable('users').set({ name: 'a' }).where({ id: 1 }).returningAll().toSQL()))
      .toContain('RETURNING *')
    expect(String(qb().deleteFrom('users').where({ id: 1 }).returningAll().toSQL()))
      .toContain('RETURNING *')
  })

  it("returning('*') spelled directly", () => {
    expect(String(qb().insertInto('users').values({ name: 'a' }).returning('*').toSQL()))
      .toContain('RETURNING *')
  })

  it('several names, and the array spelling of the same', () => {
    expect(String(qb().insertInto('users').values({ name: 'a' }).returning('id', 'name').toSQL()))
      .toContain('RETURNING id, name')
    // The one place the emitted text changed: the array form used to reach
    // `join(', ')` as a nested array and stringify to `id,uuid`, and now
    // flattens first, so it reads `id, uuid`. Whitespace only — every other
    // shape is byte-identical, checked by diffing the output against the
    // previous implementation.
    expect(String(qb().insertInto('users').values({ name: 'a' }).returning(['id', 'uuid']).toSQL()))
      .toContain('RETURNING id, uuid')
  })

  it('a qualified and an aliased name', () => {
    expect(String(qb().insertInto('users').values({ name: 'a' }).returning('users.id').toSQL()))
      .toContain('RETURNING users.id')
    expect(String(qb().insertInto('users').values({ name: 'a' }).returning('id AS k').toSQL()))
      .toContain('RETURNING id AS k')
  })
})
