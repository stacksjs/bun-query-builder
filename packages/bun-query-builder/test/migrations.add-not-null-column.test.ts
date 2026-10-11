/**
 * A NOT NULL column without a default, added to a table that already exists.
 *
 * Rows already in the table have no value for it. Postgres refuses the
 * `ADD COLUMN ... NOT NULL` once the table has rows, SQLite refuses it on any
 * table ("Cannot add a NOT NULL column with default value NULL"), and MySQL
 * quietly fills in `''` / `0`. The generated migration either failed in
 * production after passing on an empty development table, or invented data.
 *
 * Chosen behaviour, the least surprising one that applies everywhere: the
 * column is ADDED AS NULLABLE, the migration says so in a `-- qb:` comment, and
 * the operation carries a `warning`. The model still says NOT NULL, so tightening
 * stays model-driven: backfill, then add a default to the attribute, or
 * regenerate from the live database (`fromDb`), which emits the SET NOT NULL.
 *
 * A column WITH a default, a nullable column, and every column of a brand-new
 * table are untouched.
 */
import type { ColumnPlan, MigrationPlan } from '../src/migrations'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlanFromDatabase } from '../src/actions/introspect-db'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { generateDiffOperations, generateSqlFiles } from '../src/migrations'

const id: ColumnPlan = { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false }
const title: ColumnPlan = { name: 'title', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false }

function plan(dialect: 'postgres' | 'sqlite' | 'mysql', extra: ColumnPlan[] = []): MigrationPlan {
  return { dialect, tables: [{ table: 'orders', columns: [id, title, ...extra], indexes: [] }] }
}

const coachId: ColumnPlan = { name: 'coach_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false }

describe('adding a NOT NULL column with no default to an existing table', () => {
  it('postgres: added as nullable, with a comment and a warning', () => {
    const { operations, statements } = generateDiffOperations(plan('postgres'), plan('postgres', [coachId]))
    const add = operations.find(op => op.kind === 'add_column')!
    expect(add.warning).toMatch(/orders\.coach_id is NOT NULL in the model but has no default/)
    expect(add.sql).toContain('-- qb: orders.coach_id is NOT NULL')
    expect(add.sql).toContain('ALTER TABLE "orders" ADD COLUMN "coach_id" bigint;')
    expect(statements.join('\n')).not.toMatch(/"coach_id" bigint not null/i)
  })

  it('mysql: same rule, rather than letting MySQL invent a 0 for every row', () => {
    const add = generateDiffOperations(plan('mysql'), plan('mysql', [coachId])).operations.find(op => op.kind === 'add_column')!
    expect(add.warning).toBeDefined()
    expect(add.sql).toContain('ALTER TABLE `orders` ADD COLUMN `coach_id` bigint;')
  })

  it('leaves a column with a default alone', () => {
    const withDefault = { ...coachId, hasDefault: true, defaultValue: 0 }
    const add = generateDiffOperations(plan('postgres'), plan('postgres', [withDefault])).operations.find(op => op.kind === 'add_column')!
    expect(add.warning).toBeUndefined()
    expect(add.sql).toBe('ALTER TABLE "orders" ADD COLUMN "coach_id" bigint not null default 0;')
  })

  it('leaves a nullable column alone', () => {
    const add = generateDiffOperations(plan('postgres'), plan('postgres', [{ ...coachId, isNullable: true }])).operations.find(op => op.kind === 'add_column')!
    expect(add.warning).toBeUndefined()
  })

  it('leaves a brand-new table alone: it has no rows to backfill', () => {
    const { statements } = generateDiffOperations({ dialect: 'postgres', tables: [] }, plan('postgres', [coachId]))
    expect(statements.join('\n')).toContain('"coach_id" bigint not null')
  })
})

describe('on a real SQLite table with rows', () => {
  let dir: string
  let file: string
  let prevDatabase: any
  let prevDialect: any

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qb-add-not-null-'))
    file = join(dir, 'app.sqlite')
    const db = new Database(file)
    for (const f of generateSqlFiles(plan('sqlite')).files)
      db.run(f.sql)
    db.run('INSERT INTO orders (id, title) VALUES (1, \'existing\')')
    db.close()
    prevDatabase = config.database
    prevDialect = config.dialect
    setConfig({ dialect: 'sqlite', database: { ...prevDatabase, database: file } })
    resetConnection()
  })

  afterAll(() => {
    setConfig({ dialect: prevDialect, database: prevDatabase })
    resetConnection()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the generated migration applies, where NOT NULL would have been refused', () => {
    const { files } = generateDiffOperations(plan('sqlite'), plan('sqlite', [coachId]))
    const db = new Database(file)
    expect(() => db.run('ALTER TABLE "orders" ADD COLUMN "probe" INTEGER NOT NULL')).toThrow(/NOT NULL/)
    for (const f of files)
      db.run(f.sql)
    expect(db.query('SELECT coach_id FROM orders').all()).toEqual([{ coach_id: null }])
    db.close()
  })

  it('after a backfill, a live diff tightens it to NOT NULL', async () => {
    const db = new Database(file)
    db.run('UPDATE orders SET coach_id = 7')
    db.close()

    const live = await buildPlanFromDatabase('sqlite', { tables: ['orders'] })
    const { operations } = generateDiffOperations(live, plan('sqlite', [coachId]), { preserveUnknownColumns: true })
    const rebuild = operations.find(op => op.kind === 'rebuild_table')!
    expect(rebuild).toBeDefined()
    expect(rebuild.sql).toMatch(/"coach_id" INTEGER NOT NULL/i)
  })
})
