/**
 * Tests for the "smart" migration capabilities: rename detection, the SQLite
 * table-rebuild path (data-preserving type changes), structured operations
 * with destructive classification, and live-DB introspection round-tripping
 * back to a zero-churn diff.
 */
import type { MigrationPlan } from '../src/migrations'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { generateMigration } from '../src/actions/migrate'
import { buildPlanFromDatabase, sqlTypeToNormalized } from '../src/actions/introspect-db'
import { config } from '../src/config'
import { generateDiffOperations, generateSql } from '../src/migrations'

function col(name: string, type: any, extra: Record<string, any> = {}): any {
  return {
    name,
    type,
    isPrimaryKey: false,
    isUnique: false,
    isNullable: true,
    hasDefault: false,
    ...extra,
  }
}

function plan(table: string, columns: any[], indexes: any[] = []): MigrationPlan {
  return { dialect: 'sqlite', tables: [{ table, columns, indexes }] }
}

const idCol = col('id', 'bigint', { isPrimaryKey: true, isNullable: false })

// Generating migrations writes files to <cwd>/database/migrations as a side
// effect; isolate that in a temp dir so the repo stays clean.
let tmpCwd: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  tmpCwd = mkdtempSync(join(tmpdir(), 'qb-smart-diff-'))
  process.chdir(tmpCwd)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tmpCwd, { recursive: true, force: true })
})

describe('rename detection', () => {
  it('emits a data-preserving RENAME for an unambiguous rename (applyRenames default)', () => {
    const before = plan('users', [idCol, col('email', 'string')])
    const after = plan('users', [idCol, col('email_address', 'string')])

    const { statements, operations } = generateDiffOperations(before, after)
    const sql = statements.join('\n')

    expect(sql).toContain('RENAME COLUMN')
    expect(sql).not.toContain('DROP COLUMN')
    const rename = operations.find(o => o.kind === 'rename_column')
    expect(rename).toBeDefined()
    expect(rename!.from).toBe('email')
    expect(rename!.to).toBe('email_address')
    expect(rename!.destructive).toBe(false)
  })

  it('falls back to DROP + ADD when applyRenames is false', () => {
    const before = plan('users', [idCol, col('email', 'string')])
    const after = plan('users', [idCol, col('email_address', 'string')])

    const { statements, operations } = generateDiffOperations(before, after, { applyRenames: false })
    const sql = statements.join('\n')

    expect(sql).not.toContain('RENAME COLUMN')
    const drop = operations.find(o => o.kind === 'drop_column')
    expect(drop).toBeDefined()
    expect(drop!.destructive).toBe(true)
    expect(operations.some(o => o.kind === 'add_column')).toBe(true)
  })

  it('does NOT guess a rename when ambiguous (two removed + two added of same type)', () => {
    const before = plan('users', [idCol, col('a', 'string'), col('b', 'string')])
    const after = plan('users', [idCol, col('c', 'string'), col('d', 'string')])

    const { statements, operations } = generateDiffOperations(before, after)
    expect(statements.join('\n')).not.toContain('RENAME COLUMN')
    expect(operations.filter(o => o.kind === 'drop_column')).toHaveLength(2)
    expect(operations.filter(o => o.kind === 'add_column')).toHaveLength(2)
  })
})

describe('sqlite rebuild path', () => {
  it('emits a table rebuild (not a no-op comment) for a column type change', () => {
    const before = plan('widgets', [idCol, col('qty', 'string')])
    const after = plan('widgets', [idCol, col('qty', 'integer')])

    const { statements, operations } = generateDiffOperations(before, after)
    const sql = statements.join('\n')

    expect(sql).not.toContain('does not support ALTER COLUMN')
    expect(sql).toContain('CREATE TABLE')
    expect(sql).toContain('INSERT INTO')
    expect(sql).toContain('PRAGMA foreign_keys=OFF')
    const rebuild = operations.find(o => o.kind === 'rebuild_table')
    expect(rebuild).toBeDefined()
    expect(rebuild!.destructive).toBe(true) // type change is potentially lossy
  })

  it('preserves row data across a rebuild (real SQLite)', () => {
    const before = plan('gadgets', [idCol, col('label', 'string'), col('qty', 'string')])
    const after = plan('gadgets', [idCol, col('label', 'string'), col('qty', 'integer')])

    const db = new Database(':memory:')
    // Build the initial table from the "before" plan.
    for (const stmt of generateSql(before)) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }
    db.exec(`INSERT INTO "gadgets" ("label", "qty") VALUES ('gizmo', '42')`)

    // Apply the rebuild diff.
    const { statements } = generateDiffOperations(before, after)
    db.exec(statements.join('\n'))

    const rows = db.query(`SELECT label, qty FROM "gadgets"`).all() as Array<{ label: string, qty: any }>
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('gizmo')
    expect(Number(rows[0].qty)).toBe(42)

    // The rebuilt column has INTEGER affinity now.
    const info = db.query(`PRAGMA table_info("gadgets")`).all() as Array<{ name: string, type: string }>
    expect(info.find(c => c.name === 'qty')!.type).toBe('INTEGER')
    db.close()
  })

  it('rebuilds (preserving other data) when dropping a unique/indexed column', () => {
    const before = plan(
      'parts',
      [idCol, col('sku', 'string', { isUnique: true }), col('name', 'string')],
      [{ name: 'parts_sku_unique', columns: ['sku'], type: 'unique' }],
    )
    const after = plan('parts', [idCol, col('name', 'string')])

    const { statements, operations } = generateDiffOperations(before, after)
    const sql = statements.join('\n')
    // A bare ALTER ... DROP COLUMN of a unique column would fail on SQLite.
    expect(operations.some(o => o.kind === 'rebuild_table')).toBe(true)

    const db = new Database(':memory:')
    for (const stmt of generateSql(before)) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }
    db.exec(`INSERT INTO "parts" ("sku", "name") VALUES ('A1', 'bolt')`)
    db.exec(sql)
    const rows = db.query(`SELECT name FROM "parts"`).all() as Array<{ name: string }>
    expect(rows[0].name).toBe('bolt')
    const info = db.query(`PRAGMA table_info("parts")`).all() as Array<{ name: string }>
    expect(info.some(c => c.name === 'sku')).toBe(false)
    db.close()
  })
})

describe('sqlTypeToNormalized', () => {
  it('maps raw dialect types back to normalized types', () => {
    expect(sqlTypeToNormalized('varchar(255)', 'postgres')).toBe('string')
    expect(sqlTypeToNormalized('varchar(1000)', 'mysql')).toBe('text')
    expect(sqlTypeToNormalized('text', 'sqlite')).toBe('text')
    expect(sqlTypeToNormalized('tinyint(1)', 'mysql')).toBe('boolean')
    expect(sqlTypeToNormalized('bigint', 'postgres')).toBe('bigint')
    expect(sqlTypeToNormalized('integer', 'sqlite')).toBe('integer')
    expect(sqlTypeToNormalized('timestamp', 'postgres')).toBe('datetime')
    expect(sqlTypeToNormalized('jsonb', 'postgres')).toBe('json')
    expect(sqlTypeToNormalized('numeric(10,2)', 'postgres')).toBe('decimal')
    expect(sqlTypeToNormalized('double precision', 'postgres')).toBe('double')
    expect(sqlTypeToNormalized('anything', 'sqlite', { enumValues: ['a', 'b'] })).toBe('enum')
  })
})

describe('live-DB introspection round-trip', () => {
  const prevDialect = config.dialect
  const prevDatabase = config.database

  afterEach(() => {
    config.dialect = prevDialect
    config.database = prevDatabase
  })

  it('introspects a freshly-created schema back to a zero-churn diff', async () => {
    const dbFile = join(tmpCwd, `introspect-${Math.floor(process.uptime() * 1000)}.sqlite`)
    const modelPlan = plan(
      'books',
      [
        idCol,
        col('title', 'string', { isNullable: false }),
        col('isbn', 'string', { isUnique: true, isNullable: false }),
        col('pages', 'integer', { isNullable: false, hasDefault: true, defaultValue: 0 }),
        col('author_id', 'bigint', { isNullable: false, references: { table: 'authors', column: 'id' } }),
      ],
      [{ name: 'books_isbn_unique', columns: ['isbn'], type: 'unique' }],
    )

    // Materialize the schema in a real SQLite file.
    const db = new Database(dbFile, { create: true })
    db.exec('PRAGMA foreign_keys=OFF')
    for (const stmt of generateSql(modelPlan)) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }
    db.close()

    // Point the query builder at that file and introspect.
    config.dialect = 'sqlite'
    config.database = { ...prevDatabase, database: dbFile }
    const livePlan = await buildPlanFromDatabase('sqlite')

    // Diffing the models against the introspected live schema should be a no-op.
    const { statements } = generateDiffOperations(livePlan, modelPlan)
    const sql = statements.join('\n')
    expect(sql.toLowerCase()).toContain('no changes')
  })

  it('self-heal does NOT drop live tables absent from the models (scoping)', async () => {
    // A real app's models directory is a SUBSET of the database (framework
    // tables, other apps). Self-heal must not read "table in DB, not in models"
    // as "drop it".
    const dbFile = join(tmpCwd, `scope-${Math.floor(process.uptime() * 1000)}.sqlite`)
    const db = new Database(dbFile, { create: true })
    db.exec('PRAGMA foreign_keys=OFF')
    // Two tables in the DB; the models will only describe `keepers`.
    for (const stmt of generateSql({ dialect: 'sqlite', tables: [
      { table: 'keepers', columns: [idCol, col('name', 'string')], indexes: [] },
      { table: 'extras', columns: [idCol, col('note', 'string')], indexes: [] },
    ] })) {
      if (stmt.trim() && !stmt.trim().startsWith('--'))
        db.exec(stmt)
    }
    db.close()

    // A models dir that only knows about `keepers`.
    const modelsDir = mkdtempSync(join(tmpdir(), 'qb-scope-models-'))
    writeFileSync(join(modelsDir, 'Keeper.ts'), `export default {
  name: 'Keeper',
  table: 'keepers',
  primaryKey: 'id',
  attributes: { name: { validation: { rule: {} } } },
}
`)

    config.dialect = 'sqlite'
    config.database = { ...prevDatabase, database: dbFile }

    const res = await generateMigration(modelsDir, { dialect: 'sqlite', fromDb: true, dryRun: true })
    const ops = res.operations ?? []
    rmSync(modelsDir, { recursive: true, force: true })

    expect(ops.some(o => o.kind === 'drop_table' && o.table === 'extras')).toBe(false)
    expect(res.sqlStatements.join('\n')).not.toMatch(/DROP TABLE[^;]*extras/i)
  })
})
