import type { TablePlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { generateSql } from '../src/migrations'

// stacksjs/bun-query-builder#1019 — Foreign keys must reach the
// generated DDL via *some* path on every supported dialect. Prior
// to this fix:
//
//   - All three drivers' `renderColumn` silently ignored
//     `column.references`, so inline FKs never emitted at all.
//   - SQLite's `addForeignKey` produced `ALTER TABLE … ADD
//     CONSTRAINT FOREIGN KEY …`, which SQLite cannot execute.
//     The generated file landed on disk and either failed at
//     migrate time or had to be stripped by the consumer.
//
// After this fix:
//
//   - SQLite emits FKs inline on `CREATE TABLE` via `renderColumn`
//     (the only path SQLite supports). Its `addForeignKey` returns
//     an empty string so the orchestrator skips the unrunnable
//     ALTER pass entirely.
//   - MySQL / PostgreSQL keep the deferred-ALTER strategy — inline
//     FKs would fail when `plan.tables` is iterated in an order
//     that references a forward-defined table (e.g. alphabetical:
//     `comments` before `users`).

function makePlan(dialect: 'sqlite' | 'mysql' | 'postgres'): any {
  return {
    dialect,
    tables: [
      {
        table: 'users',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        ] satisfies TablePlan['columns'],
        indexes: [],
      },
      {
        table: 'posts',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          {
            name: 'user_id',
            type: 'bigint',
            isPrimaryKey: false,
            isUnique: false,
            isNullable: false,
            hasDefault: false,
            references: { table: 'users', column: 'id', onDelete: 'cascade' },
          },
        ] satisfies TablePlan['columns'],
        indexes: [],
      },
    ],
  }
}

describe('CREATE TABLE foreign-key emission (stacksjs/bun-query-builder#1019)', () => {
  it('sqlite emits inline REFERENCES — the only path that works', () => {
    const sql = generateSql(makePlan('sqlite')).join('\n')

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "posts"[\s\S]*"user_id"\s+INTEGER\b[\s\S]*?REFERENCES\s+"users"\("id"\)\s+ON DELETE CASCADE/)
    // No separate ALTER pass — SQLite can't execute ADD CONSTRAINT.
    expect(sql).not.toContain('ALTER TABLE')
    expect(sql).not.toContain('ADD CONSTRAINT')
  })

  it('mysql defers FKs to ALTER TABLE ADD CONSTRAINT after all CREATE TABLEs', () => {
    const sql = generateSql(makePlan('mysql')).join('\n')

    // The CREATE TABLE block for posts must NOT carry inline
    // REFERENCES — emitting inline would fail when iteration order
    // lands `posts` before `users`. Match only the create-table
    // statement body (between `CREATE TABLE … (` and the matching
    // closing `);`) and assert REFERENCES is absent inside it.
    const createPosts = sql.match(/CREATE TABLE[^;]*posts[^;]*;/)
    expect(createPosts).toBeTruthy()
    expect(createPosts?.[0]).not.toContain('REFERENCES')
    // The deferred ALTER pass still emits the FK.
    expect(sql).toContain('ALTER TABLE')
    expect(sql).toContain('FOREIGN KEY')
    expect(sql).toContain('REFERENCES `users`(`id`)')
    expect(sql).toContain('ON DELETE CASCADE')
  })

  it('postgres defers FKs to ALTER TABLE ADD CONSTRAINT after all CREATE TABLEs', () => {
    const sql = generateSql(makePlan('postgres')).join('\n')

    const createPosts = sql.match(/CREATE TABLE[^;]*posts[^;]*;/)
    expect(createPosts).toBeTruthy()
    expect(createPosts?.[0]).not.toContain('REFERENCES')
    expect(sql).toContain('ALTER TABLE')
    expect(sql).toContain('FOREIGN KEY')
    expect(sql).toContain('REFERENCES "users"("id")')
    expect(sql).toContain('ON DELETE CASCADE')
  })

  it('sqlite inline FK honours onUpdate when supplied', () => {
    const plan: any = {
      dialect: 'sqlite',
      tables: [{
        table: 'orders',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          {
            name: 'customer_id',
            type: 'bigint',
            isPrimaryKey: false,
            isUnique: false,
            isNullable: false,
            hasDefault: false,
            references: { table: 'customers', column: 'id', onDelete: 'restrict', onUpdate: 'cascade' },
          },
        ],
        indexes: [],
      }],
    }
    const sql = generateSql(plan).join('\n')

    expect(sql).toContain('REFERENCES "customers"("id")')
    expect(sql).toContain('ON DELETE RESTRICT')
    expect(sql).toContain('ON UPDATE CASCADE')
  })

  it('columns without references do not get a stray REFERENCES clause', () => {
    const basePlan: any = {
      tables: [{
        table: 'logs',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'message', type: 'text', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [],
      }],
    }
    for (const dialect of ['sqlite', 'mysql', 'postgres'] as const) {
      const sql = generateSql({ ...basePlan, dialect }).join('\n')
      expect(sql).not.toContain('REFERENCES')
    }
  })
})
