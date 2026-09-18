/**
 * A foreign key added to an EXISTING table on SQLite — stacksjs/bun-query-builder#1154.
 *
 * `#1019` made `CREATE TABLE` inline `REFERENCES`, which is the only form
 * SQLite accepts (it has no `ALTER TABLE … ADD CONSTRAINT`). The diff path that
 * adds a column later did not: `addColumn` rendered the type and constraints
 * only, and `addForeignKey` returns '' on SQLite so nothing else carried the
 * reference. A `belongsTo` added to a table that already existed produced
 *
 *     ALTER TABLE "monitors" ADD COLUMN "server_id" INTEGER;
 *
 * and no foreign key at all — on a migration that reported success. A StatusHQ
 * schema lost five FKs that way.
 *
 * SQLite does accept `ADD COLUMN … REFERENCES …`, provided the new column's
 * default is NULL. With a non-NULL default it refuses once foreign keys are on
 * and the table has rows (`Cannot add a REFERENCES column with non-NULL default
 * value`), so that combination goes through a table rebuild instead. Both are
 * asserted here, and executed, because the SQL text looked plausible either way.
 */

import type { MigrationPlan, TablePlan } from '../src/migrations'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { generateDiffSql } from '../src/migrations'

const servers: TablePlan = {
  table: 'servers',
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
    { name: 'name', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
  ],
  indexes: [],
}

function monitors(serverId?: Partial<TablePlan['columns'][number]>): TablePlan {
  return {
    table: 'monitors',
    primaryKey: 'id',
    columns: [
      { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
      { name: 'name', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
      ...(serverId
        ? [{
            name: 'server_id',
            type: 'bigint',
            isPrimaryKey: false,
            isUnique: false,
            isNullable: true,
            hasDefault: false,
            references: { table: 'servers', column: 'id' },
            ...serverId,
          } as TablePlan['columns'][number]]
        : []),
    ],
    indexes: [],
  }
}

const plan = (table: TablePlan): MigrationPlan => ({ dialect: 'sqlite', tables: [servers, table] } as MigrationPlan)

/** The live schema before the diff: both tables, no `server_id`, one row. */
function liveDatabase(): Database {
  const db = new Database(':memory:', { create: true })
  db.run('PRAGMA foreign_keys = ON')
  db.run('CREATE TABLE "servers" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)')
  db.run('CREATE TABLE "monitors" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)')
  db.run(`INSERT INTO "servers" ("id", "name") VALUES (1, 'web-1')`)
  db.run(`INSERT INTO "monitors" ("id", "name") VALUES (1, 'uptime')`)
  return db
}

function apply(db: Database, sql: string): void {
  // The rebuild path emits one chunk of several statements, transaction included.
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean))
    db.run(`${statement};`)
}

const foreignKeys = (db: Database): any[] => db.query('PRAGMA foreign_key_list("monitors")').all() as any[]

describe('SQLite ADD COLUMN carries its foreign key (#1154)', () => {
  it('emits the reference inline', () => {
    const sql = generateDiffSql(plan(monitors()), plan(monitors({}))).join('\n')

    // Was `ADD COLUMN "server_id" INTEGER;` — the reference was dropped.
    expect(sql).toContain('ALTER TABLE "monitors" ADD COLUMN "server_id" INTEGER REFERENCES "servers"("id")')
    // SQLite cannot run either spelling of a constraint-adding ALTER.
    expect(sql).not.toContain('ADD CONSTRAINT')
    expect(sql).not.toContain('ADD FOREIGN KEY')
  })

  it('carries ON DELETE / ON UPDATE actions', () => {
    const next = monitors({ references: { table: 'servers', column: 'id', onDelete: 'cascade', onUpdate: 'restrict' } })
    const sql = generateDiffSql(plan(monitors()), plan(next)).join('\n')

    expect(sql).toContain('REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE RESTRICT')
  })

  it('the emitted SQL runs and the foreign key is enforced', () => {
    const db = liveDatabase()
    apply(db, generateDiffSql(plan(monitors()), plan(monitors({}))).join('\n'))

    const fks = foreignKeys(db)
    expect(fks.length).toBe(1)
    expect(fks[0]).toMatchObject({ table: 'servers', from: 'server_id', to: 'id' })

    // The existing row survives, and the constraint actually bites.
    expect(db.query('SELECT name FROM monitors WHERE id = 1').get()).toEqual({ name: 'uptime' })
    db.run('UPDATE "monitors" SET "server_id" = 1 WHERE "id" = 1')
    expect(() => db.run('UPDATE "monitors" SET "server_id" = 999 WHERE "id" = 1')).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('a non-NULL default goes through a table rebuild, which SQLite accepts', () => {
    const next = monitors({ hasDefault: true, defaultValue: 1, isNullable: false })
    const sql = generateDiffSql(plan(monitors()), plan(next)).join('\n')

    // `ADD COLUMN … REFERENCES` with a non-NULL default is refused outright.
    expect(sql).not.toContain('ADD COLUMN')
    expect(sql).toContain('CREATE TABLE "_qb_tmp_monitors"')
    expect(sql).toContain('REFERENCES "servers"("id")')

    const db = liveDatabase()
    apply(db, sql)
    const fks = foreignKeys(db)
    expect(fks.length).toBe(1)
    expect(db.query('SELECT name, server_id FROM monitors WHERE id = 1').get()).toEqual({ name: 'uptime', server_id: 1 })
    db.close()
  })

  it('a NULL default still uses ADD COLUMN', () => {
    const next = monitors({ hasDefault: true, defaultValue: null })
    const sql = generateDiffSql(plan(monitors()), plan(next)).join('\n')

    expect(sql).toContain('ADD COLUMN "server_id" INTEGER')
    expect(sql).toContain('REFERENCES "servers"("id")')
    expect(sql).not.toContain('_qb_tmp_monitors')
  })

  it('a column with no reference is unchanged', () => {
    const next = monitors({ references: undefined })
    const sql = generateDiffSql(plan(monitors()), plan(next)).join('\n')

    expect(sql).toContain('ALTER TABLE "monitors" ADD COLUMN "server_id" INTEGER;')
    expect(sql).not.toContain('REFERENCES')
  })
})
