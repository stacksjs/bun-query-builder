/**
 * `where(column, 'is', null)` and `where(column, 'is not', null)`.
 *
 * Both operators are in the allowed set and the types offer them, but every
 * `where` except the internal condition helper bound the null into a
 * placeholder: `"coach_id" is $4`. SQLite reads `IS ?` bound to null as
 * `IS NULL`, so tests passed; PostgreSQL rejects it as a syntax error, so the
 * same query failed on the production database. Each form now renders the
 * predicate itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'

function qb() {
  const models = {
    plans: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        coach_id: { type: 'integer' },
        athlete_id: { type: 'integer' },
      },
    },
  } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  }) as any
}

const BOUND_IS = /\bis\s+(not\s+)?(\$\d|\?)/i

describe('where(column, \'is\', null)', () => {
  let dialect: string
  beforeEach(() => {
    dialect = config.dialect
    config.dialect = 'postgres' as any
  })
  afterEach(() => { config.dialect = dialect as any })

  it('select: string form renders IS NULL and keeps later placeholders numbered', () => {
    const sql = String(qb().selectFrom('plans').where('athlete_id', '=', 1).where('coach_id', 'is', null).where('id', '=', 2).toSQL())
    expect(sql).toMatch(/"?coach_id"? IS NULL/)
    expect(sql).not.toMatch(BOUND_IS)
    expect(sql).toContain('$2')
    expect(sql).not.toContain('$3')
  })

  it('select: is not, and the array form', () => {
    expect(String(qb().selectFrom('plans').where('coach_id', 'is not', null).toSQL())).toMatch(/IS NOT NULL/)
    expect(String(qb().selectFrom('plans').where(['coach_id', 'is', null]).toSQL())).toMatch(/IS NULL/)
  })

  it('select: andWhere and orWhere', () => {
    const sql = String(qb().selectFrom('plans').where('id', '=', 1).orWhere('coach_id', 'is', null).andWhere('athlete_id', 'is not', null).toSQL())
    expect(sql).toMatch(/coach_id"? IS NULL/)
    expect(sql).toMatch(/athlete_id"? IS NOT NULL/)
    expect(sql).not.toMatch(BOUND_IS)
  })

  it('update and delete', () => {
    const update = String(qb().updateTable('plans').set({ athlete_id: 3 }).where('coach_id', 'is', null).toSQL())
    expect(update).toMatch(/IS NULL/)
    expect(update).not.toMatch(BOUND_IS)
    const remove = String(qb().deleteFrom('plans').where('coach_id', 'is', null).where('id', '=', 4).toSQL())
    expect(remove).toMatch(/IS NULL/)
    expect(remove).not.toMatch(BOUND_IS)
  })

  it('refuses a value other than null', () => {
    expect(() => qb().selectFrom('plans').where('coach_id', 'is', 5)).toThrow(/only accepts NULL/)
    expect(() => qb().deleteFrom('plans').where('coach_id', 'is not', 'x')).toThrow(/only accepts NULL/)
  })
})
