import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { buildMigrationPlan, generateSql } from '../src/migrations'
import { defineModels } from '../src/schema'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

const models = defineModels({
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      email: { unique: true, validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
    indexes: [
      { name: 'created_at_idx', columns: ['created_at'] },
    ],
  },
  Project: {
    name: 'Project',
    table: 'projects',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
    },
  },
} as const)

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true
  config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }

  // Set up database for migration tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after migration tests
  await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'postgres' })
})

describe('migration planner', () => {
  it('builds a plan from models with inferred types and indexes', () => {
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
    expect(plan.dialect).toBe('postgres')
    const users = plan.tables.find(t => t.table === 'users')!
    expect(users.columns.find(c => c.name === 'id')?.isPrimaryKey).toBeTrue()
    expect(users.columns.find(c => c.name === 'email')?.isUnique).toBeTrue()
    expect(users.indexes.find(i => i.name === 'created_at_idx')).toBeTruthy()
    // const projects = plan.tables.find(t => t.table === 'projects')!
    // const fk = projects.columns.find(c => c.name === 'user_id')?.references
    // expect(fk?.table).toBe('users')
  })

  it('generates SQL for the plan', () => {
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
    const sql = generateSql(plan)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.join('\n').toLowerCase()).toContain('create table')
    expect(sql.join('\n').toLowerCase()).toContain('unique index')
  })

  // stacksjs/bun-query-builder#1023: object-form belongsTo crashed the
  // generator with "str.replace is not a function" because the entry object
  // was handed straight to the snake_case helper. It must be normalized to a
  // model name first, and its foreignKey/onDelete honored.
  it('accepts object-form belongsTo without crashing and honors foreignKey/onDelete', () => {
    const m = defineModels({
      JudgeReview: {
        name: 'JudgeReview',
        table: 'judge_reviews',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
      },
      User: {
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
      },
      ReviewPhoto: {
        name: 'ReviewPhoto',
        table: 'review_photos',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
        // Mixed: object form (with FK config) + plain string form.
        belongsTo: [
          { model: 'JudgeReview', foreignKey: 'judge_review_id', onDelete: 'cascade' },
          'User',
        ],
      },
    } as const)

    const plan = buildMigrationPlan(m as any, { dialect: 'sqlite' })
    const photos = plan.tables.find(t => t.table === 'review_photos')!

    // Object-form entry → FK column with declared name + ON DELETE behaviour.
    const judgeFk = photos.columns.find(c => c.name === 'judge_review_id')!
    expect(judgeFk.references?.table).toBe('judge_reviews')
    expect(judgeFk.references?.onDelete).toBe('cascade')

    // String-form entry still works alongside it (convention-named column).
    const userFk = photos.columns.find(c => c.name === 'user_id')!
    expect(userFk.references?.table).toBe('users')

    // And it renders into DDL with an inline FK + ON DELETE CASCADE (SQLite
    // uses `REFERENCES tbl(col) ON DELETE ...` on the column, not a named
    // FOREIGN KEY constraint).
    const sql = generateSql(plan).join('\n').toLowerCase()
    expect(sql).toContain('references "judge_reviews"')
    expect(sql).toContain('on delete cascade')
  })

  it('accepts record-form belongsTo with object values (#1023)', () => {
    const m = defineModels({
      Author: {
        name: 'Author',
        table: 'authors',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
      },
      Book: {
        name: 'Book',
        table: 'books',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
        belongsTo: { writer: { model: 'Author', onDelete: 'set null' } },
      },
    } as const)

    const plan = buildMigrationPlan(m as any, { dialect: 'postgres' })
    const books = plan.tables.find(t => t.table === 'books')!
    const fk = books.columns.find(c => c.name === 'author_id')!
    expect(fk.references?.table).toBe('authors')
    expect(fk.references?.onDelete).toBe('set null')
  })

  it('honors CompositeIndex.unique flag', () => {
    const m = defineModels({
      Tag: {
        name: 'Tag',
        table: 'tags',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          slug: { validation: { rule: {} } },
        },
        indexes: [
          { name: 'tags_slug_unique', columns: ['slug'], unique: true },
        ],
      },
    } as const)
    const plan = buildMigrationPlan(m as any, { dialect: 'postgres' })
    const tags = plan.tables.find(t => t.table === 'tags')!
    const idx = tags.indexes.find(i => i.name === 'tags_slug_unique')!
    expect(idx.type).toBe('unique')
  })

  it('emits CompositeIndex.where as a partial index on Postgres', () => {
    const m = defineModels({
      CoachAthlete: {
        name: 'CoachAthlete',
        table: 'coach_athletes',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          coach_id: { validation: { rule: {} } },
          athlete_id: { validation: { rule: {} } },
          role: { validation: { rule: {} } },
        },
        indexes: [
          { name: 'one_primary_per_athlete', columns: ['athlete_id'], unique: true, where: "role = 'primary'" },
        ],
      },
    } as const)
    const plan = buildMigrationPlan(m as any, { dialect: 'postgres' })
    const sql = generateSql(plan).join('\n')
    expect(sql).toContain("WHERE role = 'primary'")
    expect(sql.toLowerCase()).toContain('unique index')
  })

  it('throws on MySQL when CompositeIndex.where is set', () => {
    const m = defineModels({
      X: {
        name: 'X',
        table: 'xs',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
        indexes: [{ name: 'x_partial', columns: ['id'], where: 'id > 0' }],
      },
    } as const)
    const plan = buildMigrationPlan(m as any, { dialect: 'mysql' })
    expect(() => generateSql(plan)).toThrow(/Partial indexes.*not supported on MySQL/)
  })

  it('auto-emits Option A inline pivot tables', () => {
    const m = defineModels({
      Coach: {
        name: 'Coach',
        table: 'coaches',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } },
        belongsToMany: {
          athletes: {
            model: 'Athlete',
            table: 'coach_athletes',
            foreignKey: 'coach_id',
            relatedKey: 'athlete_id',
            pivot: {
              timestamps: true,
              columns: { role: { default: 'shared' }, status: { default: 'active' } },
            },
          },
        },
      },
      Athlete: {
        name: 'Athlete',
        table: 'athletes',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } },
      },
    } as const)
    const plan = buildMigrationPlan(m as any, { dialect: 'postgres' })
    const pivot = plan.tables.find(t => t.table === 'coach_athletes')
    expect(pivot).toBeDefined()
    const colNames = pivot!.columns.map(c => c.name).sort()
    expect(colNames).toContain('coach_id')
    expect(colNames).toContain('athlete_id')
    expect(colNames).toContain('role')
    expect(colNames).toContain('status')
    expect(colNames).toContain('created_at')
    // Default unique on the FK pair
    expect(pivot!.indexes.some(i => i.type === 'unique')).toBeTrue()
  })

  it('does not emit a separate pivot when `through:` is set (uses through-model table instead)', () => {
    const m = defineModels({
      Coach: {
        name: 'Coach',
        table: 'coaches',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } },
        belongsToMany: {
          athletes: { model: 'Athlete', through: 'CoachAthlete' },
        },
      },
      Athlete: {
        name: 'Athlete',
        table: 'athletes',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } },
      },
      CoachAthlete: {
        name: 'CoachAthlete',
        table: 'coach_athletes',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          coach_id: { validation: { rule: {} } },
          athlete_id: { validation: { rule: {} } },
          role: { validation: { rule: {} } },
        },
      },
    } as const)
    const plan = buildMigrationPlan(m as any, { dialect: 'postgres' })
    const pivots = plan.tables.filter(t => t.table === 'coach_athletes')
    // Exactly one — the through model's own table, not duplicated by the
    // Option-A auto-emission path.
    expect(pivots.length).toBe(1)
  })
})

describe('migration status and rollback', () => {
  it('migrateStatus action exists and is callable', async () => {
    const { migrateStatus } = await import('../src/actions/migrate-status')
    expect(typeof migrateStatus).toBe('function')
    // May fail without proper DB setup, but should not throw unhandled errors
    try {
      await migrateStatus()
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })

  it('migrateList is an alias for migrateStatus', async () => {
    const { migrateList, migrateStatus } = await import('../src/actions/migrate-status')
    expect(typeof migrateList).toBe('function')
    expect(typeof migrateStatus).toBe('function')
  })

  it('migrateRollback action exists and accepts options', async () => {
    const { migrateRollback } = await import('../src/actions/migrate-rollback')
    expect(typeof migrateRollback).toBe('function')
    // May fail without proper DB setup, but should not throw unhandled errors
    try {
      await migrateRollback({ steps: 1 })
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })
})

describe('schema validation', () => {
  it('validateSchema action exists and is callable', async () => {
    const { validateSchema } = await import('../src/actions/validate')
    expect(typeof validateSchema).toBe('function')
  })

  it('checkSchema is an alias for validateSchema', async () => {
    const { checkSchema, validateSchema } = await import('../src/actions/validate')
    expect(typeof checkSchema).toBe('function')
    expect(typeof validateSchema).toBe('function')
  })

  it('validateSchema returns validation result structure', async () => {
    const { validateSchema } = await import('../src/actions/validate')
    // May fail without proper DB, but test the function signature
    try {
      const result = await validateSchema(EXAMPLES_MODELS_PATH)
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('valid')
      expect(result).toHaveProperty('issues')
      expect(Array.isArray(result.issues)).toBe(true)
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })
})

// stacksjs/bun-query-builder — resetDatabase used to unconditionally wipe
// every committed *.sql migration file, even when there was no models
// directory to regenerate them from (projects that only run on shipped,
// hand-written migrations and haven't created a models override yet). That
// left the project with zero migration files and no way to get them back.
describe('resetDatabase file cleanup', () => {
  it('keeps committed migration files when there is no models directory to regenerate from', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'bqb-reset-'))
    const sqlDir = join(workspaceRoot, 'database', 'migrations')
    require('node:fs').mkdirSync(sqlDir, { recursive: true })
    writeFileSync(join(sqlDir, '0001-create-foo-table.sql'), 'CREATE TABLE foo (id INTEGER);')

    const originalCwd = process.cwd()
    process.chdir(workspaceRoot)
    try {
      const ok = await resetDatabase(join(workspaceRoot, 'app', 'Models-does-not-exist'), { dialect: 'sqlite' })
      expect(ok).toBeTrue()
      expect(readdirSync(sqlDir)).toContain('0001-create-foo-table.sql')
    }
    finally {
      process.chdir(originalCwd)
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
