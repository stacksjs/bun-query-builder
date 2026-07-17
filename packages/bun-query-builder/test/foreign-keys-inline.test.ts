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
//   - MySQL / PostgreSQL dependency-order tables and emit acyclic FKs inline,
//     keeping a new model's schema in one create-table migration. Only true
//     cycles require a deferred ALTER fallback.

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

  it('mysql dependency-orders tables and emits acyclic FKs inline', () => {
    const sql = generateSql(makePlan('mysql')).join('\n')

    const createPosts = sql.match(/CREATE TABLE[^;]*posts[^;]*;/)
    expect(createPosts).toBeTruthy()
    expect(createPosts?.[0]).toContain('REFERENCES `users`(`id`) ON DELETE CASCADE')
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS `users`')).toBeLessThan(sql.indexOf('CREATE TABLE IF NOT EXISTS `posts`'))
    expect(sql).not.toContain('ALTER TABLE')
  })

  it('postgres dependency-orders tables and emits acyclic FKs inline', () => {
    const sql = generateSql(makePlan('postgres')).join('\n')

    const createPosts = sql.match(/CREATE TABLE[^;]*posts[^;]*;/)
    expect(createPosts).toBeTruthy()
    expect(createPosts?.[0]).toContain('REFERENCES "users"("id") ON DELETE CASCADE')
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS "users"')).toBeLessThan(sql.indexOf('CREATE TABLE IF NOT EXISTS "posts"'))
    expect(sql).not.toContain('ALTER TABLE')
  })

  it('postgres defers only cyclic foreign keys', () => {
    const columns = (reference: string): TablePlan['columns'] => [
      { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
      { name: `${reference}_id`, type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: `${reference}s`, column: 'id' } },
    ]
    const sql = generateSql({
      dialect: 'postgres',
      tables: [
        { table: 'authors', columns: columns('book'), indexes: [] },
        { table: 'books', columns: columns('author'), indexes: [] },
      ],
    }).join('\n')

    expect(sql.match(/ALTER TABLE/g)?.length).toBe(2)
    expect(sql).toContain('REFERENCES "books"("id")')
    expect(sql).toContain('REFERENCES "authors"("id")')
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
