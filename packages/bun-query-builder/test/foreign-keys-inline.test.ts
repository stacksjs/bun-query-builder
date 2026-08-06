import type { TablePlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { generateDiffOperations, generateSql } from '../src/migrations'
import { MySQLDriver } from '../src/drivers/mysql'
import { PostgresDriver } from '../src/drivers/postgres'
import { SQLiteDriver } from '../src/drivers/sqlite'

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

  it('postgres incremental generation keeps new model schema in create migrations', () => {
    const users = makePlan('postgres').tables[0]
    const sessionPackages: TablePlan = {
      table: 'session_packages',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'user_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: 'users', column: 'id' } },
      ],
      indexes: [{ name: 'session_packages_user_id_index', columns: ['user_id'], type: 'index' }],
    }
    const appointments: TablePlan = {
      table: 'appointments',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'session_package_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: 'session_packages', column: 'id' } },
      ],
      indexes: [{ name: 'appointments_package_index', columns: ['session_package_id'], type: 'index' }],
    }
    const previous: any = { dialect: 'postgres', tables: [users] }
    // Deliberately put the dependent table first to prove the diff path sorts it.
    const next: any = { dialect: 'postgres', tables: [users, appointments, sessionPackages] }
    const sql = generateDiffOperations(previous, next, { dryRun: true }).statements.join('\n')

    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS "session_packages"')).toBeLessThan(sql.indexOf('CREATE TABLE IF NOT EXISTS "appointments"'))
    expect(sql).toContain('REFERENCES "users"("id")')
    expect(sql).toContain('REFERENCES "session_packages"("id")')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "session_packages_user_id_index"')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "appointments_package_index"')
    expect(sql).not.toContain('ALTER TABLE')
  })

  it('postgres defers only cyclic foreign keys inside the final create migration', () => {
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

    // Counted by `ADD CONSTRAINT` rather than by `ALTER TABLE`: a deferred FK
    // now arrives with a drop of whatever is already on the column, and that
    // drop is an ALTER too. Two deferred keys is the claim; how many
    // statements it takes to install one is not.
    expect(sql.match(/ADD CONSTRAINT/g)?.length).toBe(2)
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

/**
 * A foreign key is replaced, not accumulated.
 *
 * A column created inline with `REFERENCES` already carries a constraint, and
 * the server named it: Postgres calls it `posts_user_id_fkey`, not the
 * `posts_user_id_fk` this library adds. Adding without dropping left both, and
 * a server enforces every constraint it holds - so a migration that adds
 * `ON DELETE CASCADE` applied cleanly, the cascade was real, and deletes went
 * on failing against the `NO ACTION` sitting beside it. Nothing in the output
 * said so, which is what made it expensive to find.
 *
 * Found in a forge where twenty-two tables hang off one row: every delete had
 * to walk the schema at runtime and order the deletions itself, because the
 * cascade it had declared was never the only rule in force.
 */
describe('replacing a foreign key rather than adding a second one', () => {
  const drivers = [
    { name: 'postgres', make: () => new PostgresDriver() },
    { name: 'mysql', make: () => new MySQLDriver() },
  ]

  for (const { name, make } of drivers) {
    describe(name, () => {
      const addSql = make().addForeignKey('posts', 'user_id', 'users', 'id', 'cascade')
      const replaceSql = make().addForeignKey('posts', 'user_id', 'users', 'id', 'cascade', undefined, [
        'posts_user_id_fkey',
        'custom_posts_owner_fk',
      ])

      it('still adds the constraint it was asked for', () => {
        expect(replaceSql).toContain('FOREIGN KEY')
        expect(replaceSql).toContain('ON DELETE CASCADE')
        expect(replaceSql).toContain('posts_user_id_fk')
      })

      it('does not drop anything for a newly-added foreign key', () => {
        expect(addSql).not.toMatch(/DROP\s+(?:CONSTRAINT|FOREIGN KEY)/i)
      })

      it('drops every introspected single-column constraint before replacing it', () => {
        const dropsAt = replaceSql.search(/DROP\s+(?:CONSTRAINT|FOREIGN KEY)/i)
        const addsAt = replaceSql.indexOf('ADD CONSTRAINT')

        expect(dropsAt).toBeGreaterThanOrEqual(0)
        expect(addsAt).toBeGreaterThan(dropsAt)
        expect(replaceSql).toContain('posts_user_id_fkey')
        expect(replaceSql).toContain('custom_posts_owner_fk')
      })

      it('uses static DDL that works through Vitess and managed MySQL proxies', () => {
        expect(replaceSql).not.toMatch(/PREPARE|EXECUTE|information_schema|pg_constraint/i)
      })
    })
  }

  /** An identifier is not a place to let a quote through. */
  it('escapes a quote in an identifier rather than closing the string', () => {
    const sql = new PostgresDriver().addForeignKey('po"sts', 'user_id', 'users', 'id', undefined, undefined, ['odd"name'])

    expect(sql).toContain('"po""sts"')
    expect(sql).toContain('"odd""name"')
  })

  it('passes introspected names through the diff when an FK action changes', () => {
    const previous = makePlan('mysql')
    previous.tables[1].columns[1].references = {
      table: 'users',
      column: 'id',
      constraintNames: ['server_named_fk'],
    }
    const next = makePlan('mysql')
    const sql = generateDiffOperations(previous, next).statements.join('\n')

    expect(sql).toContain('DROP FOREIGN KEY `server_named_fk`')
    expect(sql).toContain('ADD CONSTRAINT `posts_user_id_fk`')
    expect(sql.indexOf('DROP FOREIGN KEY')).toBeLessThan(sql.indexOf('ADD CONSTRAINT'))
  })

  /** SQLite emits inline and skips the ALTER pass entirely, so there is nothing to replace. */
  it('does not touch the dialects that never ALTER', () => {
    expect(new SQLiteDriver().addForeignKey('posts', 'user_id', 'users', 'id')).toBe('')
  })
})
