/**
 * Identifier injection on the SELECT / FROM / ORDER BY / GROUP BY family —
 * stacksjs/bun-query-builder#1181.
 *
 * These methods interpolated caller-supplied column names straight into SQL.
 * `quoteColumnForDialect` looked like protection and was not: it is a MySQL
 * quoter that returns anything it cannot parse verbatim, and returns its
 * argument untouched on every other dialect.
 *
 * Measured against live Postgres before the fix, with `?sort=` as the payload:
 *
 *   table exists before : true
 *   SQL built           : SELECT * FROM sec_users ORDER BY id; DROP TABLE sec_users; -- ASC
 *   table exists after  : false
 *
 * The stacked statement ran. The WHERE and join family already refused the
 * same input through `validateIdentifier`, and `orm.ts` had closed the ORDER BY
 * half after stacksjs/stacks#1858, so this was a gap in an existing defence.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, raw } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        team_id: { type: 'integer' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

const PAYLOAD = 'id; DROP TABLE users; --'
const REFUSED = /is not a plain column reference/

describe('identifier injection is refused (#1181)', () => {
  it('orderBy, the realistic entry point', () => {
    // A sort column is the most common request input that is legitimately a
    // column name, so this is the parameter most likely to be passed through.
    expect(() => qb().selectFrom('users').orderBy(PAYLOAD)).toThrow(REFUSED)
  })

  it('every other ORDER BY spelling', () => {
    expect(() => qb().selectFrom('users').orderByDesc(PAYLOAD)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').latest(PAYLOAD)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').oldest(PAYLOAD)).toThrow(REFUSED)
  })

  it('groupBy and distinctOn', () => {
    expect(() => qb().selectFrom('users').groupBy(PAYLOAD)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').distinctOn(PAYLOAD)).toThrow(REFUSED)
  })

  it('select and addSelect', () => {
    expect(() => qb().selectFrom('users').select([PAYLOAD])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').addSelect(PAYLOAD)).toThrow(REFUSED)
  })

  it('addSelect given an array, which bypassed the first fix', () => {
    // `addSelect` is variadic, so `addSelect(['a'])` - the shape `select`
    // takes - arrived as one array argument and reached the String() fallback
    // whole. renderSelectColumn now recurses instead.
    expect(() => qb().selectFrom('users').addSelect([PAYLOAD])).toThrow(REFUSED)
  })

  it('selectFrom, where the type says keyof DB but JS can pass anything', () => {
    expect(() => qb().selectFrom('users; DROP TABLE users; --')).toThrow(REFUSED)
  })

  it('a subquery is refused as well as a stacked statement', () => {
    // Stacked statements are the loud case; an ORDER BY subquery is the quiet
    // one, and is a working boolean oracle wherever stacking is blocked.
    expect(() => qb().selectFrom('users').orderBy('(SELECT secret FROM users LIMIT 1)')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').select(['name FROM users UNION SELECT 1 --'])).toThrow(REFUSED)
  })
})

describe('legitimate column references still work (#1181)', () => {
  it('plain, qualified and aliased names', () => {
    expect(String(qb().selectFrom('users').orderBy('name').toSQL())).toContain('ORDER BY')
    expect(String(qb().selectFrom('users').orderBy('users.name').toSQL())).toContain('ORDER BY')
    expect(String(qb().selectFrom('users').select(['name AS n']).toSQL())).toContain('name')
    expect(String(qb().selectFrom('users').groupBy('team_id').toSQL())).toContain('GROUP BY')
  })

  it('star, in the one place it belongs', () => {
    // Allowed for select, refused for ORDER BY, where it is not a column.
    expect(String(qb().selectFrom('users').select(['*']).toSQL())).toContain('*')
    expect(String(qb().selectFrom('users').select(['users.*']).toSQL())).toContain('users')
    expect(() => qb().selectFrom('users').orderBy('*')).toThrow(REFUSED)
  })

  it('addSelect still takes the array form', () => {
    expect(String(qb().selectFrom('users').addSelect(['name', 'team_id']).toSQL())).toContain('name')
  })

  it('expressions go through raw, which is the escape hatch', () => {
    // The strict rule is only tenable because this exists: `raw` and the *Raw
    // methods escape what they interpolate, and bypass the identifier check by
    // design rather than by accident.
    const sql = String(qb().selectFrom('users').select([raw('COUNT(*) AS c')]).toSQL())
    expect(sql).toContain('COUNT(*)')
  })
})
