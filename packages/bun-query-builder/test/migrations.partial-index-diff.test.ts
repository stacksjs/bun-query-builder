/**
 * A partial index's predicate is part of its identity in the diff.
 *
 * `indexKey` ignored `where`, so changing an index's predicate in a model
 * emitted nothing: the snapshot moved on and the database kept the old index.
 * The predicate is now part of the key — normalized, because a predicate read
 * back from Postgres is not spelled the way the model wrote it.
 */
import type { IndexPlan, MigrationPlan } from '../src/migrations'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlanFromDatabase, parseIndexPredicate } from '../src/actions/introspect-db'
import { config, setConfig } from '../src/config'
import { resetConnection } from '../src/db'
import { generateDiffOperations, normalizeIndexPredicate } from '../src/migrations'

function plan(dialect: 'postgres' | 'sqlite', index: Partial<IndexPlan>): MigrationPlan {
  return {
    dialect,
    tables: [{
      table: 'memberships',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'athlete_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'status', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
      ],
      indexes: [{ name: 'memberships_active_athlete_unique', columns: ['athlete_id'], type: 'unique', ...index }],
    }],
  }
}

describe('normalizeIndexPredicate', () => {
  it('treats Postgres\'s rendering of a predicate as the predicate the model wrote', () => {
    expect(normalizeIndexPredicate('(deleted_at IS NULL)')).toBe(normalizeIndexPredicate('deleted_at is null'))
    expect(normalizeIndexPredicate('((status)::text = \'active\'::text)')).toBe(normalizeIndexPredicate('status = \'active\''))
    expect(normalizeIndexPredicate('("role" = \'primary\'::character varying)')).toBe(normalizeIndexPredicate('role = \'primary\''))
    expect(normalizeIndexPredicate('((status)::text = ANY ((ARRAY[\'a\'::character varying, \'b\'::character varying])::text[]))'))
      .toBe(normalizeIndexPredicate('status IN (\'a\', \'b\')'))
    expect(normalizeIndexPredicate('(status <> ALL (ARRAY[\'x\'::text]))')).toBe(normalizeIndexPredicate('status NOT IN (\'x\')'))
    expect(normalizeIndexPredicate('a != 1')).toBe(normalizeIndexPredicate('a <> 1'))
    expect(normalizeIndexPredicate('((n >= 1) AND (n <= 5))')).toBe(normalizeIndexPredicate('n BETWEEN 1 AND 5'))
  })

  it('keeps string literals verbatim, so a changed value is a changed predicate', () => {
    expect(normalizeIndexPredicate('status = \'Active\'')).not.toBe(normalizeIndexPredicate('status = \'active\''))
    expect(normalizeIndexPredicate('status = \'a b\'')).not.toBe(normalizeIndexPredicate('status = \'ab\''))
  })

  it('treats no predicate and an empty one alike', () => {
    expect(normalizeIndexPredicate(undefined)).toBe('')
    expect(normalizeIndexPredicate('  ')).toBe('')
  })
})

describe('diffing a partial index', () => {
  it('a changed predicate drops and recreates the index', () => {
    const { operations } = generateDiffOperations(
      plan('postgres', { where: 'status = \'active\'' }),
      plan('postgres', { where: 'status <> \'archived\'' }),
    )
    const drop = operations.find(op => op.kind === 'drop_index')
    const create = operations.find(op => op.kind === 'create_index')
    expect(drop?.sql).toContain('DROP INDEX IF EXISTS "memberships_active_athlete_unique"')
    expect(create?.sql).toContain('WHERE status <> \'archived\'')
  })

  it('adding a predicate to a plain index is a change too', () => {
    const { operations } = generateDiffOperations(plan('postgres', {}), plan('postgres', { where: 'status = \'active\'' }))
    expect(operations.map(op => op.kind)).toEqual(['drop_index', 'create_index'])
  })

  it('an unchanged predicate produces nothing, however the previous side spelled it', () => {
    const { operations } = generateDiffOperations(
      plan('postgres', { where: '((status)::text = \'active\'::text)' }),
      plan('postgres', { where: 'status = \'active\'' }),
    )
    expect(operations).toEqual([])
  })

  it('a live reconcile replaces a stale definition of a model-declared index instead of keeping it', () => {
    const { operations } = generateDiffOperations(
      plan('postgres', { where: '((status)::text = \'active\'::text)' }),
      plan('postgres', { where: 'status <> \'archived\'' }),
      { preserveUnknownColumns: true },
    )
    expect(operations.map(op => op.kind)).toEqual(['drop_index', 'create_index'])
  })

  it('a live reconcile still keeps an index no model declares', () => {
    const live = plan('postgres', {})
    live.tables[0].indexes.push({ name: 'memberships_hand_made_index', columns: ['status'], type: 'index' })
    const { operations } = generateDiffOperations(live, plan('postgres', {}), { preserveUnknownColumns: true })
    expect(operations).toEqual([])
  })
})

describe('reading a partial index back out of SQLite', () => {
  let dir: string
  let prevDatabase: any
  let prevDialect: any

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qb-partial-idx-'))
    const file = join(dir, 'app.sqlite')
    const db = new Database(file)
    db.run('CREATE TABLE memberships (id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL, status TEXT NOT NULL)')
    db.run('CREATE UNIQUE INDEX "memberships_active_athlete_unique" ON "memberships" ("athlete_id") WHERE status = \'active\'')
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

  it('parses the predicate from index DDL', () => {
    expect(parseIndexPredicate('CREATE INDEX "i" ON "t" ("a", lower("b")) WHERE x = \'where\';')).toBe('x = \'where\'')
    expect(parseIndexPredicate('CREATE INDEX "i" ON "t" ("somewhere")')).toBeUndefined()
  })

  it('introspects the predicate, and the live plan diffs clean against the model', async () => {
    const live = await buildPlanFromDatabase('sqlite', { tables: ['memberships'] })
    const index = live.tables[0].indexes.find(i => i.name === 'memberships_active_athlete_unique')
    expect(index?.where).toBe('status = \'active\'')
    // A unique PARTIAL index does not make the column unique.
    expect(live.tables[0].columns.find(c => c.name === 'athlete_id')?.isUnique).toBe(false)

    const { operations } = generateDiffOperations(live, plan('sqlite', { where: 'status = \'active\'' }), { preserveUnknownColumns: true })
    expect(operations).toEqual([])
  })
})
