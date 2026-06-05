/**
 * Coverage for reversible-rollback down-DDL derivation
 * (stacksjs/bun-query-builder#1048).
 */

import { describe, expect, it } from 'bun:test'
import { deriveDownStatements, splitSqlStatements } from '../src/actions/migrate-rollback'

describe('splitSqlStatements (#1048)', () => {
  it('splits on `;` but ignores semicolons in strings and comments', () => {
    const sql = `-- a comment;\nCREATE TABLE t (id int);\nINSERT INTO t VALUES ('a;b');`
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE t (id int)',
      `INSERT INTO t VALUES ('a;b')`,
    ])
  })
})

describe('deriveDownStatements (#1048)', () => {
  it('inverts CREATE TABLE -> DROP TABLE', () => {
    const { down } = deriveDownStatements('CREATE TABLE users (id integer primary key, name text);', 'postgres')
    expect(down).toEqual(['DROP TABLE IF EXISTS "users"'])
  })

  it('inverts ALTER TABLE ADD COLUMN -> DROP COLUMN', () => {
    const { down } = deriveDownStatements('ALTER TABLE users ADD COLUMN age integer;', 'postgres')
    expect(down).toEqual(['ALTER TABLE "users" DROP COLUMN "age"'])
  })

  it('inverts CREATE INDEX (dialect-aware)', () => {
    expect(deriveDownStatements('CREATE INDEX idx_email ON users (email);', 'postgres').down)
      .toEqual(['DROP INDEX IF EXISTS "idx_email"'])
    expect(deriveDownStatements('CREATE UNIQUE INDEX idx_email ON users (email);', 'mysql').down)
      .toEqual(['DROP INDEX `idx_email` ON `users`'])
  })

  it('reverses statement order and reports non-invertible statements', () => {
    const sql = `CREATE TABLE a (id int);\nCREATE TABLE b (id int);\nINSERT INTO a VALUES (1);`
    const { down, skipped } = deriveDownStatements(sql, 'sqlite')
    // reverse order: b dropped before a
    expect(down).toEqual(['DROP TABLE IF EXISTS "b"', 'DROP TABLE IF EXISTS "a"'])
    expect(skipped).toEqual(['INSERT INTO a VALUES (1)'])
  })
})
