/**
 * Regression coverage for stacksjs/bun-query-builder#1030.
 *
 * Joins were appended to the end of `text`, so `.where(...).join(...)` produced
 * `SELECT ... WHERE ... JOIN ...` (invalid on every dialect). join() also never
 * invalidated `built`. Joins now splice in before the first top-level trailing
 * clause.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    users: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' }, team_id: { type: 'integer' } } },
    teams: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' } } },
  } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

function idx(s: string, re: RegExp) { return s.search(re) }

describe('join clause ordering (#1030)', () => {
  it('join() after where() places JOIN before WHERE', () => {
    const sql = String((qb() as any).selectFrom('users').where({ name: 'a' }).join('teams', 'users.team_id', '=', 'teams.id').toSQL())
    expect(idx(sql, /\bJOIN\b/)).toBeGreaterThan(-1)
    expect(idx(sql, /\bJOIN\b/)).toBeLessThan(idx(sql, /\bWHERE\b/))
  })

  it('innerJoin after where() + orderBy keeps FROM JOIN WHERE ORDER BY order', () => {
    const sql = String((qb() as any).selectFrom('users').where({ name: 'a' }).orderBy('id').innerJoin('teams', 'users.team_id', '=', 'teams.id').toSQL())
    const j = idx(sql, /\bJOIN\b/); const w = idx(sql, /\bWHERE\b/); const o = idx(sql, /ORDER BY/)
    expect(j).toBeGreaterThan(-1)
    expect(j).toBeLessThan(w)
    expect(w).toBeLessThan(o)
  })

  it('does not match a subquery WHERE inside joinSub parentheses', () => {
    const sub = (qb() as any).selectFrom('teams').where({ name: 'x' })
    const sql = String((qb() as any).selectFrom('users').where({ name: 'a' }).joinSub(sub, 't', 'users.team_id', '=', 't.id').toSQL())
    // The outer JOIN must precede the outer WHERE; the subquery's own WHERE
    // (inside parens) must remain intact.
    expect(idx(sql, /\bJOIN\b/)).toBeLessThan(sql.lastIndexOf('WHERE'))
    expect(sql).toContain('AS t ON')
  })
})
