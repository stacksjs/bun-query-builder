/**
 * Regression coverage for stacksjs/bun-query-builder#1026.
 *
 * whereJsonContains must emit dialect-appropriate SQL (Postgres `@>` /
 * `jsonb_contains`, MySQL `JSON_CONTAINS`, SQLite `json_each` membership)
 * instead of hardcoding the Postgres `@>` operator on every dialect, and it
 * must honor `config.sql.jsonContainsMode`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'
import { resetConnection } from '../src/db'

function qb() {
  const models = { posts: { columns: { id: { type: 'integer', isPrimaryKey: true }, tags: { type: 'json' }, meta: { type: 'json' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('whereJsonContains dialect handling (#1026)', () => {
  let snapshot: { dialect: string, sql: any, database: Record<string, unknown> }

  beforeEach(() => {
    snapshot = { dialect: config.dialect, sql: { ...config.sql }, database: { ...config.database } }
  })
  afterEach(() => {
    config.dialect = snapshot.dialect as any
    config.sql = snapshot.sql
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('Postgres: operator mode emits @>, function mode emits jsonb_contains', () => {
    config.dialect = 'postgres' as any
    config.sql = { ...config.sql, jsonContainsMode: 'operator' }
    expect(String((qb() as any).selectFrom('posts').whereJsonContains('tags', ['bun']).toSQL())).toContain('tags @> $1')
    config.sql = { ...config.sql, jsonContainsMode: 'function' }
    expect(String((qb() as any).selectFrom('posts').whereJsonContains('tags', ['bun']).toSQL())).toContain('jsonb_contains(tags, $1)')
  })

  it('MySQL: emits JSON_CONTAINS', () => {
    config.dialect = 'mysql' as any
    const s = String((qb() as any).selectFrom('posts').whereJsonContains('tags', ['bun']).toSQL())
    expect(s).toContain('JSON_CONTAINS(tags, ?)')
    expect(s).not.toContain('@>')
  })

  it('SQLite: emits json_each membership (no @>)', () => {
    config.dialect = 'sqlite' as any
    const s = String((qb() as any).selectFrom('posts').whereJsonContains('tags', ['bun']).toSQL())
    expect(s).toContain('json_each(tags)')
    expect(s).not.toContain('@>')
  })

  it('SQLite: object containment throws a clear error (not invalid SQL)', () => {
    config.dialect = 'sqlite' as any
    expect(() => (qb() as any).selectFrom('posts').whereJsonContains('meta', { a: 1 }).toSQL())
      .toThrow(/object containment is not supported on SQLite/)
  })

  // Runtime execution of the SQLite json_each form was verified manually
  // (`whereJsonContains('tags', ['bun'])` against a seeded table returns the
  // matching row); an in-suite execution test is omitted because the shared
  // lazy-connection state across test files makes it flaky.

  /**
   * #1091. Postgres binds a number as int4 and a boolean as bool, neither of
   * which `@>` accepts (`operator does not exist: jsonb @> integer`), so a
   * scalar operand is lifted to a jsonb scalar. Documents are bound directly
   * and must NOT be lifted — the driver already encodes those as jsonb.
   *
   * These assert the SQL shape only. The bug this guards against lived
   * entirely in the bound parameter, which `toSQL()` does not expose, so the
   * real guard is the execution test in client.json-contains.pg.test.ts.
   */
  it('Postgres: lifts a number or boolean operand with to_jsonb (#1091)', () => {
    config.dialect = 'postgres' as any
    config.sql = { ...config.sql, jsonContainsMode: 'operator' }
    const num = String((qb() as any).selectFrom('posts').whereJsonContains('tags', 1).toSQL())
    expect(num).toContain('tags @> to_jsonb($1)')
    const bool = String((qb() as any).selectFrom('posts').whereJsonContains('tags', true).toSQL())
    expect(bool).toContain('tags @> to_jsonb($1)')

    config.sql = { ...config.sql, jsonContainsMode: 'function' }
    const fn = String((qb() as any).selectFrom('posts').whereJsonContains('tags', 1).toSQL())
    expect(fn).toContain('jsonb_contains(tags, to_jsonb($1))')
  })

  it('Postgres: binds a document operand directly, without to_jsonb (#1091)', () => {
    config.dialect = 'postgres' as any
    config.sql = { ...config.sql, jsonContainsMode: 'operator' }
    for (const operand of [['bun'], { published: true }, 'bun']) {
      const s = String((qb() as any).selectFrom('posts').whereJsonContains('tags', operand).toSQL())
      expect(s).toContain('tags @> $1')
      expect(s).not.toContain('to_jsonb')
    }
  })
})
