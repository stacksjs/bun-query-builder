import { describe, expect, test } from 'bun:test'
import { splitSqlStatements } from '../src/db'

describe('splitSqlStatements (migration file executor)', () => {
  test('keeps a statement preceded by leading -- doc comments', () => {
    // Regression: a documented CREATE TABLE used to be discarded because the
    // segment started with `--`, so only the trailing index ran and failed
    // with "no such table". (stacksjs/status hand-written migrations.)
    const sql = `-- Cloud-provider credentials for platform automation.\n-- One row per (team, provider).\nCREATE TABLE IF NOT EXISTS "cloud_credentials" (\n  "id" INTEGER PRIMARY KEY,\n  "team_id" bigint not null\n);\nCREATE UNIQUE INDEX IF NOT EXISTS "cc_unique" ON "cloud_credentials" ("team_id");`
    const stmts = splitSqlStatements(sql)
    expect(stmts).toHaveLength(2)
    expect(stmts[0]!.startsWith('CREATE TABLE')).toBe(true)
    expect(stmts[1]!.startsWith('CREATE UNIQUE INDEX')).toBe(true)
  })

  test('keeps a single ALTER preceded by a comment (was a silent no-op)', () => {
    const sql = `-- Super-admin flag.\nALTER TABLE "users" ADD COLUMN "is_super_admin" boolean not null default false;`
    expect(splitSqlStatements(sql)).toEqual(['ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean not null default false'])
  })

  test('keeps multiple statements each preceded by comments', () => {
    const sql = `-- revoke legacy tokens\nDELETE FROM oauth_refresh_tokens;\n-- and access tokens\nDELETE FROM oauth_access_tokens;`
    expect(splitSqlStatements(sql)).toEqual(['DELETE FROM oauth_refresh_tokens', 'DELETE FROM oauth_access_tokens'])
  })

  test('drops comment-only segments', () => {
    expect(splitSqlStatements('-- just a comment')).toEqual([])
    expect(splitSqlStatements('-- a;\n-- b;')).toEqual([])
    expect(splitSqlStatements('/* block only */')).toEqual([])
  })

  test('strips a leading block comment but keeps the SQL', () => {
    expect(splitSqlStatements('/* note */ SELECT 1;')).toEqual(['SELECT 1'])
  })

  test('does not split on ; or -- inside string literals', () => {
    const sql = `INSERT INTO t (a) VALUES ('x; -- not a comment');`
    expect(splitSqlStatements(sql)).toEqual([`INSERT INTO t (a) VALUES ('x; -- not a comment')`])
  })

  test('a plain statement with no comments is unchanged', () => {
    expect(splitSqlStatements('CREATE TABLE a (id INTEGER);\nCREATE INDEX i ON a(id);')).toEqual([
      'CREATE TABLE a (id INTEGER)',
      'CREATE INDEX i ON a(id)',
    ])
  })
})
