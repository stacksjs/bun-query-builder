/**
 * Identifier injection on the LIKE family, `reorder` and the aggregates.
 *
 * #1181 routed ORDER BY / GROUP BY / SELECT through `assertSafeColumnRef` and
 * #1185 did the same for the window functions. Thirteen methods on the same
 * builder were missed, so the defence those issues built had holes reachable
 * through the same kind of request input: a search box rather than a `?sort=`.
 *
 * Measured against live PostgreSQL 17 before the fix.
 *
 * `max()` returns `row.m` to the caller untouched, which makes its column slot
 * a read primitive over everything the connection can see:
 *
 *     legit max(salary): 200
 *     max(<subquery>)  : tok_live_DEADBEEF        // max('(SELECT token FROM inj_secrets LIMIT 1)')
 *
 * and the LIKE family appends a disjunction that defeats the filters already
 * on the query, so a tenant-scoped SELECT returned another tenant's row:
 *
 *     scoped, no search          rows=2  teams=a
 *     scoped + legit whereLike   rows=0  teams=
 *     whereLike  injected        rows=3  teams=a,secret
 *     whereILike injected        rows=3  teams=a,secret
 *
 * `OR 1=1` alone does not work on Postgres there - `AND LOWER(name)` puts text
 * in a boolean slot and is rejected - so the payloads above are shaped to stay
 * valid. That is a constraint on the attacker, not a defence.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        salary: { type: 'integer' },
        team: { type: 'text' },
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
// The shape that actually bypassed a tenant scope, not a textbook `OR 1=1`.
const BYPASS = 'name) IS NOT NULL OR TRUE OR LOWER(name'
const STACKED = 'id; DROP TABLE users; --'
const SUBQUERY = '(SELECT token FROM secrets LIMIT 1)'

describe('identifier injection is refused on the LIKE family', () => {
  it('whereLike and orWhereLike, the search-box entry point', () => {
    expect(() => qb().selectFrom('users').whereLike(BYPASS, '%x%')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orWhereLike(BYPASS, '%x%')).toThrow(REFUSED)
  })

  it('the ILIKE spellings, which interpolate without the LOWER() wrapper', () => {
    expect(() => qb().selectFrom('users').whereILike(`'' = '' OR TRUE OR name`, '%x%')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orWhereILike(`'' = '' OR TRUE OR name`, '%x%')).toThrow(REFUSED)
  })

  it('the negated spellings', () => {
    expect(() => qb().selectFrom('users').whereNotLike(BYPASS, '%x%')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orWhereNotLike(BYPASS, '%x%')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereNotILike(BYPASS, '%x%')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orWhereNotILike(BYPASS, '%x%')).toThrow(REFUSED)
  })

  it('the case-sensitive branch, which skips LOWER() and so needs its own check', () => {
    // `caseSensitive: true` interpolates the column bare rather than inside
    // LOWER(...), so it is a second code path through the same argument.
    expect(() => qb().selectFrom('users').whereLike(BYPASS, '%x%', true)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereNotLike(BYPASS, '%x%', true)).toThrow(REFUSED)
  })
})

describe('identifier injection is refused on reorder and the aggregates', () => {
  it('reorder, which took #1181 payload verbatim', () => {
    // latest()/oldest() sit eight lines below it and were fixed by #1181.
    expect(() => qb().selectFrom('users').reorder(STACKED)).toThrow(REFUSED)
  })

  it('max and min, which return the value to the caller', async () => {
    // These two are the severe ones: the result is handed back untouched, so
    // the column slot reads any table the connection can reach.
    await expect(qb().selectFrom('users').max(SUBQUERY)).rejects.toThrow(REFUSED)
    await expect(qb().selectFrom('users').min(SUBQUERY)).rejects.toThrow(REFUSED)
  })

  it('avg and sum, where Number() narrowed the leak rather than closing it', async () => {
    await expect(qb().selectFrom('users').avg(SUBQUERY)).rejects.toThrow(REFUSED)
    await expect(qb().selectFrom('users').sum(SUBQUERY)).rejects.toThrow(REFUSED)
  })

  it('a stacked statement through an aggregate', async () => {
    await expect(qb().selectFrom('users').sum(`salary) as s FROM users; DROP TABLE users; --`)).rejects.toThrow(REFUSED)
  })
})

describe('legitimate columns are unchanged', () => {
  it('the LIKE family still emits what it did, LOWER() wrapper included', () => {
    const sql = String(qb().selectFrom('users').where({ team: 'a' }).whereLike('name', '%zz%').toSQL())
    expect(sql).toContain('LOWER(name) LIKE LOWER(')
    // The filter the injected form destroyed is still there.
    expect(sql).toContain('team =')
  })

  it('case-sensitive LIKE skips the wrapper, as before', () => {
    const sql = String(qb().selectFrom('users').whereLike('name', '%zz%', true).toSQL())
    expect(sql).toContain('name LIKE ')
    expect(sql).not.toContain('LOWER(name)')
  })

  it('ILIKE and the negated spellings still build', () => {
    expect(String(qb().selectFrom('users').whereILike('name', '%zz%').toSQL())).toMatch(/ILIKE|LOWER\(name\)/)
    expect(String(qb().selectFrom('users').whereNotLike('name', '%zz%').toSQL())).toContain('NOT LIKE')
    expect(String(qb().selectFrom('users').whereNotILike('name', '%zz%').toSQL())).toMatch(/NOT ILIKE|NOT LIKE/)
  })

  it('a qualified column is still accepted everywhere', () => {
    expect(String(qb().selectFrom('users').whereLike('users.name', '%zz%').toSQL())).toContain('users.name')
    expect(String(qb().selectFrom('users').reorder('users.id', 'desc').toSQL())).toContain('ORDER BY users.id DESC')
  })

  it('reorder still replaces the existing ORDER BY rather than appending', () => {
    const sql = String(qb().selectFrom('users').orderBy('name').reorder('id', 'desc').toSQL())
    expect(sql).toContain('ORDER BY id DESC')
    expect(sql).not.toContain('name')
  })
})
