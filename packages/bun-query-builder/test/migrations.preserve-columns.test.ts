/**
 * Hand-written schema and model-driven schema, living together.
 *
 * Two rules have to hold at once:
 *
 *   1. A column a model declares — including the foreign key it gets from
 *      `belongsTo` — is created, altered and dropped by the model diff.
 *   2. A column the models have never mentioned, put there by a hand-written
 *      migration or by another app on the same database, survives every
 *      migrate. Not because the differ is timid, but because when `previous`
 *      is read off the live database it carries no evidence that the column
 *      was ever model-owned. A snapshot does carry that evidence, and there
 *      the drop still happens.
 */
import type { MigrationPlan } from '../src/migrations'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { buildMigrationPlan, generateDiffOperations, generateSql } from '../src/migrations'

function col(name: string, type: any, extra: Record<string, any> = {}): any {
  return { name, type, isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false, ...extra }
}

function plan(table: string, columns: any[], indexes: any[] = []): MigrationPlan {
  return { dialect: 'sqlite', tables: [{ table, columns, indexes }] }
}

const idCol = col('id', 'bigint', { isPrimaryKey: true, isNullable: false })

// Generating migrations writes files under <cwd>/database/migrations; keep
// that out of the repo.
let tmpCwd: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  tmpCwd = mkdtempSync(join(tmpdir(), 'qb-preserve-'))
  process.chdir(tmpCwd)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tmpCwd, { recursive: true, force: true })
})

describe('belongsTo foreign keys are part of the expected schema', () => {
  const farmWithUser = {
    Farm: { name: 'Farm', table: 'farms', primaryKey: 'id', belongsTo: ['User'], attributes: { name: { validation: { rule: {} } } } },
    User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { email: { validation: { rule: {} } } } },
  }

  it('adds the foreign key column, with a reference, when the target model is loaded', () => {
    const built = buildMigrationPlan(farmWithUser as any, { dialect: 'sqlite' })
    const farms = built.tables.find(t => t.table === 'farms')!
    const userId = farms.columns.find(c => c.name === 'user_id')

    expect(userId).toBeDefined()
    expect(userId!.references).toEqual({ table: 'users', column: 'id', onDelete: undefined })
  })

  it('still adds the column when the target model is NOT loaded, just without the constraint', () => {
    // A models directory is routinely a subset of the schema: framework
    // models, another app's tables, a relation pointing outside this set. The
    // ORM writes `user_id` either way, so the column has to exist either way.
    const built = buildMigrationPlan({ Farm: farmWithUser.Farm } as any, { dialect: 'sqlite' })
    const farms = built.tables.find(t => t.table === 'farms')!
    const userId = farms.columns.find(c => c.name === 'user_id')

    expect(userId).toBeDefined()
    expect(userId!.references).toBeUndefined()
  })

  it('does not propose dropping the column it forgot to expect (the regression)', () => {
    // Live database has farms.user_id; models declare `belongsTo: ['User']`
    // but User is not in the loaded set. Before the fix the plan omitted the
    // column and every migrate proposed dropping it.
    const live = plan('farms', [idCol, col('name', 'string'), col('user_id', 'bigint')])
    const fromModels = buildMigrationPlan({ Farm: farmWithUser.Farm } as any, { dialect: 'sqlite' })

    const { operations } = generateDiffOperations(live, fromModels)

    expect(operations.filter(o => o.kind === 'drop_column')).toHaveLength(0)
    expect(operations.filter(o => o.destructive)).toHaveLength(0)
  })

  it('honours an explicit foreignKey name on the object form', () => {
    const built = buildMigrationPlan({
      Post: { name: 'Post', table: 'posts', primaryKey: 'id', belongsTo: [{ model: 'Author', foreignKey: 'writer_id' }], attributes: { title: { validation: { rule: {} } } } },
    } as any, { dialect: 'sqlite' })

    const names = built.tables[0].columns.map(c => c.name)
    expect(names).toContain('writer_id')
    expect(names).not.toContain('author_id')
  })

  it('leaves a foreign key already declared in attributes exactly as declared', () => {
    const built = buildMigrationPlan({
      Mission: { name: 'Mission', table: 'missions', primaryKey: 'id', belongsTo: ['Farm'], attributes: { farm_id: { validation: { rule: {} } } } },
      Farm: farmWithUser.Farm,
    } as any, { dialect: 'sqlite' })

    const farmIds = built.tables.find(t => t.table === 'missions')!.columns.filter(c => c.name === 'farm_id')
    expect(farmIds).toHaveLength(1)
  })

  it('aligns a declared foreign key with the referenced primary-key type', () => {
    const built = buildMigrationPlan({
      Board: { name: 'Board', table: 'boards', primaryKey: 'id', attributes: { name: { validation: { rule: {} } } } },
      BoardColumn: {
        name: 'BoardColumn',
        table: 'board_columns',
        primaryKey: 'id',
        belongsTo: ['Board'],
        attributes: { boardId: { validation: { rule: { name: 'number' } } } },
      },
    } as any, { dialect: 'mysql' })

    const boardId = built.tables.find(table => table.table === 'board_columns')!.columns.find(column => column.name === 'board_id')!
    expect(boardId.type).toBe('bigint')
    expect(boardId.references).toEqual({ table: 'boards', column: 'id' })
  })
})

describe('columns no model declares, reconciled from the database', () => {
  const live = plan('farms', [idCol, col('name', 'string'), col('legacy_note', 'string')])
  const fromModels = plan('farms', [idCol, col('name', 'string')])

  it('drops an undeclared column when previous came from a snapshot', () => {
    // The default. A snapshot records what the models said last time, so a
    // column missing from `next` really was removed from a model.
    const { operations } = generateDiffOperations(live, fromModels)
    const drop = operations.find(o => o.kind === 'drop_column')

    expect(drop).toBeDefined()
    expect(drop!.column).toBe('legacy_note')
    expect(drop!.destructive).toBe(true)
  })

  it('keeps it when previous was introspected', () => {
    const { statements, operations } = generateDiffOperations(live, fromModels, { preserveUnknownColumns: true })

    expect(operations.filter(o => o.kind === 'drop_column')).toHaveLength(0)
    expect(operations.filter(o => o.destructive)).toHaveLength(0)
    expect(statements.join('\n')).not.toContain('DROP COLUMN')
  })

  it('carries it through a rebuild triggered by an unrelated change', () => {
    // The dangerous case: SQLite recreates the table from the target plan, so
    // a preserved column left out of that plan is dropped with no
    // `drop_column` operation for the destructive gate to catch.
    const before = plan('farms', [idCol, col('qty', 'string'), col('legacy_note', 'string')])
    const after = plan('farms', [idCol, col('qty', 'integer')])

    const { statements } = generateDiffOperations(before, after, { preserveUnknownColumns: true })
    const sql = statements.join('\n')

    expect(sql).toContain('CREATE TABLE')
    expect(sql).toContain('legacy_note')
  })

  it('keeps its data through that rebuild, against real SQLite', () => {
    const before = plan('farms', [idCol, col('qty', 'string'), col('legacy_note', 'string')])
    const after = plan('farms', [idCol, col('qty', 'integer')])

    const db = new Database(':memory:')
    for (const stmt of generateSql(before)) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }
    db.exec(`INSERT INTO farms (id, qty, legacy_note) VALUES (1, '7', 'added by hand')`)

    for (const stmt of generateDiffOperations(before, after, { preserveUnknownColumns: true }).statements) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }

    const row = db.query('SELECT id, qty, legacy_note FROM farms WHERE id = 1').get() as any
    expect(row.legacy_note).toBe('added by hand')
    expect(String(row.qty)).toBe('7')
    db.close()
  })

  it('keeps an index that belongs to a preserved column', () => {
    const before = plan(
      'farms',
      [idCol, col('qty', 'string'), col('legacy_note', 'string')],
      [{ name: 'farms_legacy_note_idx', type: 'index', columns: ['legacy_note'] }],
    )
    const after = plan('farms', [idCol, col('qty', 'integer')])

    const { statements, operations } = generateDiffOperations(before, after, { preserveUnknownColumns: true })

    expect(operations.filter(o => o.kind === 'drop_index')).toHaveLength(0)
    expect(statements.join('\n')).toContain('farms_legacy_note_idx')
  })

  it('keeps a live-only index on a model-owned column', () => {
    const before = plan(
      'farms',
      [idCol, col('name', 'string')],
      [{ name: 'idx_farms_name_helper', type: 'index', columns: ['name'] }],
    )
    const after = plan('farms', [idCol, col('name', 'string')])

    const { statements, operations } = generateDiffOperations(before, after, { preserveUnknownColumns: true })

    expect(operations.filter(o => o.kind === 'drop_index')).toHaveLength(0)
    expect(statements.join('\n')).not.toContain('DROP INDEX')
  })

  it('does not guess a rename from introspected state', () => {
    // A hand-written `legacy_note` and a newly declared `region` are two
    // different columns that happen to share a type. Against a snapshot the
    // rename heuristic is sound; against a live schema it is a guess that
    // moves data into a column meaning something else. Both survive instead.
    const before = plan('farms', [idCol, col('legacy_note', 'string')])
    const after = plan('farms', [idCol, col('region', 'string')], [{ name: 'farms_region_idx', type: 'index', columns: ['region'] }])

    const { statements, operations } = generateDiffOperations(before, after, { preserveUnknownColumns: true })
    const sql = statements.join('\n')

    expect(operations.some(o => o.kind === 'rename_column')).toBe(false)
    expect(operations.some(o => o.kind === 'add_column' && o.column === 'region')).toBe(true)
    expect(sql).toContain('farms_region_idx')
    expect(sql).not.toContain('DROP COLUMN')
  })

  it('still detects that rename when previous is a snapshot', () => {
    // The heuristic is untouched on the path where it is justified.
    const before = plan('users', [idCol, col('email', 'string')])
    const after = plan('users', [idCol, col('email_address', 'string')])

    const { statements, operations } = generateDiffOperations(before, after)

    expect(operations.some(o => o.kind === 'rename_column')).toBe(true)
    expect(statements.join('\n')).not.toContain('DROP COLUMN')
  })

  it('is a no-op when the models account for everything', () => {
    const same = plan('farms', [idCol, col('name', 'string')])
    const { operations } = generateDiffOperations(same, same, { preserveUnknownColumns: true })

    expect(operations.filter(o => o.kind !== 'create_table')).toHaveLength(0)
  })

  it('creates a brand-new table normally under preservation', () => {
    const before = plan('farms', [idCol])
    const after: MigrationPlan = {
      dialect: 'sqlite',
      tables: [
        { table: 'farms', columns: [idCol], indexes: [] },
        { table: 'fields', columns: [idCol, col('name', 'string')], indexes: [] },
      ],
    }

    const { operations } = generateDiffOperations(before, after, { preserveUnknownColumns: true })
    expect(operations.some(o => o.kind === 'create_table' && o.table === 'fields')).toBe(true)
  })
})
