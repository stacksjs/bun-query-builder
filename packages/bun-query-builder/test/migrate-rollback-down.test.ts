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

  it('drops a comment that trails a statement instead of keeping it as one', () => {
    // Whole-line comments were filtered up front, so a trailing one survived
    // as its own "statement" and got reported as un-reversible DDL.
    expect(splitSqlStatements('ALTER TABLE a ADD COLUMN b TEXT; -- note about b'))
      .toEqual(['ALTER TABLE a ADD COLUMN b TEXT'])
    expect(splitSqlStatements('SELECT 1; /* block\ncomment; here */ SELECT 2;'))
      .toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a statement whole when a quote contains the semicolon', () => {
    // Only single quotes were tracked, so a `;` inside a double-quoted
    // identifier or a backtick-quoted default split one statement into two.
    expect(splitSqlStatements('INSERT INTO a VALUES ("x;y")'))
      .toEqual(['INSERT INTO a VALUES ("x;y")'])
    expect(splitSqlStatements('ALTER TABLE `t` ADD COLUMN `c` TEXT DEFAULT `a;b`'))
      .toEqual(['ALTER TABLE `t` ADD COLUMN `c` TEXT DEFAULT `a;b`'])
  })

  it('reads a doubled quote as an escape, not as the end of the string', () => {
    expect(splitSqlStatements(`INSERT INTO a VALUES ('it''s; fine'); SELECT 1;`))
      .toEqual([`INSERT INTO a VALUES ('it''s; fine')`, 'SELECT 1'])
  })

  it('does not mistake a hyphen inside a string for a comment', () => {
    expect(splitSqlStatements(`INSERT INTO a VALUES ('a--b'); SELECT 1;`))
      .toEqual([`INSERT INTO a VALUES ('a--b')`, 'SELECT 1'])
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

  it('inverts ADD CONSTRAINT as a constraint, not as a column called "CONSTRAINT"', () => {
    // `ADD\s+(?:COLUMN\s+)?(\w+)` reads the keyword after ADD as a column name,
    // so a foreign key rolled back as `DROP COLUMN "CONSTRAINT"` — reported as
    // a successful reversal.
    expect(deriveDownStatements('ALTER TABLE "posts" ADD CONSTRAINT "posts_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");', 'postgres').down)
      .toEqual(['ALTER TABLE "posts" DROP CONSTRAINT "posts_user_fk"'])

    // MySQL drops a foreign key by its own verb.
    expect(deriveDownStatements('ALTER TABLE `posts` ADD CONSTRAINT `posts_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);', 'mysql').down)
      .toEqual(['ALTER TABLE `posts` DROP FOREIGN KEY `posts_user_fk`'])

    // A non-FK constraint on MySQL uses DROP CONSTRAINT (8.0.19+).
    expect(deriveDownStatements('ALTER TABLE `posts` ADD CONSTRAINT `posts_views_chk` CHECK (`views` >= 0);', 'mysql').down)
      .toEqual(['ALTER TABLE `posts` DROP CONSTRAINT `posts_views_chk`'])
  })

  it('refuses to invert table-level ADDs that name no column', () => {
    // Each of these used to become `DROP COLUMN "PRIMARY"` / `"UNIQUE"` /
    // `"INDEX"`. Reporting them as un-reversible is the honest answer.
    for (const sql of [
      'ALTER TABLE "posts" ADD PRIMARY KEY ("id");',
      'ALTER TABLE `posts` ADD UNIQUE `posts_slug` (`slug`);',
      'ALTER TABLE `posts` ADD INDEX `posts_title` (`title`);',
      'ALTER TABLE `posts` ADD KEY `posts_title` (`title`);',
      'ALTER TABLE "posts" ADD CHECK ("views" >= 0);',
    ]) {
      const { down, skipped } = deriveDownStatements(sql, 'mysql')
      expect(down).toEqual([])
      expect(skipped).toHaveLength(1)
    }
  })

  it('cannot drop a constraint on SQLite, and says so', () => {
    // SQLite has no ALTER TABLE ... DROP CONSTRAINT at all.
    const { down, skipped } = deriveDownStatements('ALTER TABLE "posts" ADD CONSTRAINT "posts_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");', 'sqlite')
    expect(down).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  it('still inverts a column whose name happens to start with a keyword', () => {
    // `constraint_notes` is a column, not a constraint.
    expect(deriveDownStatements('ALTER TABLE "posts" ADD COLUMN "constraint_notes" TEXT;', 'postgres').down)
      .toEqual(['ALTER TABLE "posts" DROP COLUMN "constraint_notes"'])
    expect(deriveDownStatements('ALTER TABLE "posts" ADD "keyword" TEXT;', 'postgres').down)
      .toEqual(['ALTER TABLE "posts" DROP COLUMN "keyword"'])
  })

  it('reverses statement order and reports non-invertible statements', () => {
    const sql = `CREATE TABLE a (id int);\nCREATE TABLE b (id int);\nINSERT INTO a VALUES (1);`
    const { down, skipped } = deriveDownStatements(sql, 'sqlite')
    // reverse order: b dropped before a
    expect(down).toEqual(['DROP TABLE IF EXISTS "b"', 'DROP TABLE IF EXISTS "a"'])
    expect(skipped).toEqual(['INSERT INTO a VALUES (1)'])
  })
})
