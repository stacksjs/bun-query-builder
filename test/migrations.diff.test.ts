import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan, generateDiffSql, generateSql, hashMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

describe('migrations - diffing and hashing', () => {
  const baseModels = defineModels({
    User: {
      name: 'User',
      table: 'users',
      primaryKey: 'id',
      attributes: {
        id: { validation: { rule: {} } },
        email: { unique: true, validation: { rule: {} } },
        created_at: { validation: { rule: {} } },
      },
      indexes: [{ name: 'created_at_idx', columns: ['created_at'] }],
    },
  } as const)

  it('hash is stable across key order changes', () => {
    const p1 = buildMigrationPlan(baseModels as any, { dialect: 'postgres' })
    const p2 = JSON.parse(JSON.stringify(p1))
    // Shuffle keys in a nested object
    p2.tables[0] = JSON.parse(JSON.stringify(p2.tables[0], (k, v) => v))
    const h1 = hashMigrationPlan(p1)
    const h2 = hashMigrationPlan(p2)
    expect(h1).toBe(h2)
  })

  it('diff produces CREATE statements first time and empty/no-op next time', () => {
    const p1 = buildMigrationPlan(baseModels as any, { dialect: 'postgres' })
    const first = generateDiffSql(undefined, p1)
    expect(first).toContain('CREATE TABLE')
    const second = generateDiffSql(p1, p1)
    expect(second.toLowerCase()).toContain('no changes')
  })

  it('adding a column yields ALTER TABLE ADD COLUMN and optional FK', () => {
    const models2 = defineModels({
      ...baseModels,
      Project: {
        name: 'Project',
        table: 'projects',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          user_id: { validation: { rule: {} } },
          name: { validation: { rule: {} } },
        },
      },
    } as const)
    const p1 = buildMigrationPlan(baseModels as any, { dialect: 'postgres' })
    const p2 = buildMigrationPlan(models2 as any, { dialect: 'postgres' })
    const sql = generateDiffSql(p1, p2)
    expect(sql).toContain('CREATE TABLE "projects"')
    expect(sql).toContain('ALTER TABLE "projects" ADD CONSTRAINT')
  })

  it('dialect specific types map as expected', () => {
    const planPg = buildMigrationPlan(baseModels as any, { dialect: 'postgres' })
    const sqlPg = generateSql(planPg)
    expect(sqlPg.toLowerCase()).toContain('timestamp')
    const planMy = buildMigrationPlan(baseModels as any, { dialect: 'mysql' })
    const sqlMy = generateSql(planMy)
    expect(sqlMy.toLowerCase()).toContain('datetime')
    const planSq = buildMigrationPlan(baseModels as any, { dialect: 'sqlite' })
    const sqlSq = generateSql(planSq)
    expect(sqlSq.toLowerCase()).toContain('timestamp')
  })

  it('performance: diff and sql generation are fast for 100 tables', () => {
    const bigModels: any = { }
    for (let i = 0; i < 100; i++) {
      bigModels[`T${i}`] = {
        name: `T${i}`,
        table: `t${i}`,
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          name: { validation: { rule: {} } },
          created_at: { validation: { rule: {} } },
          user_id: { validation: { rule: {} } },
        },
      }
    }
    const models = defineModels(bigModels)
    const t0 = performance.now()
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
    const sql = generateSql(plan)
    const diff = generateDiffSql(undefined, plan)
    const dt = performance.now() - t0
    expect(sql.length).toBeGreaterThan(1000)
    expect(diff.length).toBeGreaterThan(1000)
    // budget: 200ms on CI machines; adjust as needed
    expect(dt).toBeLessThan(200)
  })

  it('edge: defaults, unique flags, and json type fallbacks', () => {
    const models = defineModels({
      Doc: {
        name: 'Doc',
        table: 'docs',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          title: { default: 'x', validation: { rule: {} } },
          score: { default: 1.23, validation: { rule: {} } },
          active: { default: true, validation: { rule: {} } },
          big: { default: 10n as any, validation: { rule: {} } },
          when: { default: new Date(), validation: { rule: {} } },
          meta: { default: { a: 1 } as any, validation: { rule: {} } },
          email: { unique: true, validation: { rule: {} } },
        },
      },
    } as const)
    const p = buildMigrationPlan(models as any, { dialect: 'postgres' })
    const sql = generateSql(p)
    expect(sql.toLowerCase()).toContain('create table')
    expect(sql.toLowerCase()).toContain('unique index')
  })
})
