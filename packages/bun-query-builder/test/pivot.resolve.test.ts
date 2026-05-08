/**
 * Pivot resolver tests — verify that `resolvePivot` produces the right pivot
 * table name, FK columns, and pivot column metadata across the legacy string
 * form and the new Option A / Option B config forms.
 */
import { describe, expect, it } from 'bun:test'
import { buildSchemaMeta, defineModel, defineModels, resolvePivot } from '../src'

const ruleStub = { validate: (v: unknown) => typeof v === 'string' } as any

describe('resolvePivot', () => {
  it('resolves the legacy string form to the sort-and-join default table', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      belongsToMany: { athletes: 'Athlete' },
    } as const)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const meta = buildSchemaMeta(defineModels({ Coach, Athlete }))
    const resolved = resolvePivot(meta, 'coaches', 'athletes')

    expect(resolved).not.toBeNull()
    // singular(athletes) = athlete, singular(coaches) = coache → sorted: athlete_coache
    expect(resolved!.pivotTable).toBe('athlete_coache')
    expect(resolved!.fkParent).toBe('coache_id')
    expect(resolved!.fkRelated).toBe('athlete_id')
    expect(resolved!.pivotColumns).toEqual([])
    expect(resolved!.timestamps).toBe(false)
    expect(resolved!.relatedModelName).toBe('Athlete')
    expect(resolved!.relatedTable).toBe('athletes')
    expect(resolved!.hasConfig).toBe(false)
  })

  it('honors explicit `table`, `foreignKey`, and `relatedKey` overrides', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      belongsToMany: {
        athletes: {
          model: 'Athlete',
          table: 'coach_athletes',
          foreignKey: 'coach_id',
          relatedKey: 'athlete_id',
        },
      },
    } as const)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const meta = buildSchemaMeta(defineModels({ Coach, Athlete }))
    const resolved = resolvePivot(meta, 'coaches', 'athletes')

    expect(resolved).not.toBeNull()
    expect(resolved!.pivotTable).toBe('coach_athletes')
    expect(resolved!.fkParent).toBe('coach_id')
    expect(resolved!.fkRelated).toBe('athlete_id')
    expect(resolved!.hasConfig).toBe(true)
  })

  it('resolves Option A inline pivot columns', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      belongsToMany: {
        athletes: {
          model: 'Athlete',
          pivot: {
            columns: {
              role: { default: 'shared', validation: { rule: ruleStub } },
              status: { default: 'active', validation: { rule: ruleStub } },
            },
            timestamps: true,
          },
        },
      },
    } as const)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const models = defineModels({ Coach, Athlete })
    const meta = buildSchemaMeta(models)
    const resolved = resolvePivot(meta, 'coaches', 'athletes', { models })

    expect(resolved).not.toBeNull()
    expect(resolved!.pivotColumns.sort()).toEqual(['role', 'status'])
    expect(resolved!.timestamps).toBe(true)
    expect(resolved!.pivotColumnDefs.role.default).toBe('shared')
  })

  it('resolves Option B `through:` to the through-model table and reads its attributes', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      belongsToMany: { athletes: { model: 'Athlete', through: 'CoachAthlete' } },
    } as const)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const CoachAthlete = defineModel({
      name: 'CoachAthlete',
      table: 'coach_athletes',
      attributes: {
        id: { validation: { rule: ruleStub } },
        coache_id: { validation: { rule: ruleStub } },
        athlete_id: { validation: { rule: ruleStub } },
        role: { default: 'shared', validation: { rule: ruleStub } },
        status: { default: 'active', validation: { rule: ruleStub } },
      },
    } as const)

    const models = defineModels({ Coach, Athlete, CoachAthlete })
    const meta = buildSchemaMeta(models)
    const resolved = resolvePivot(meta, 'coaches', 'athletes', { models })

    expect(resolved).not.toBeNull()
    expect(resolved!.pivotTable).toBe('coach_athletes')
    expect(resolved!.pivotModelName).toBe('CoachAthlete')
    // FK columns and primary key are excluded; declared extras come through.
    expect(resolved!.pivotColumns.sort()).toEqual(['role', 'status'])
  })

  it('throws when `through:` references an unregistered model', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      belongsToMany: { athletes: { model: 'Athlete', through: 'GhostPivot' } },
    } as const)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const meta = buildSchemaMeta(defineModels({ Coach, Athlete }))
    expect(() => resolvePivot(meta, 'coaches', 'athletes')).toThrow(/unknown through model 'GhostPivot'/)
  })

  it('returns null for unknown relations or non-belongsToMany keys', () => {
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      attributes: { id: { validation: { rule: ruleStub } } },
      hasMany: { sessions: 'Session' },
    } as const)

    const Session = defineModel({
      name: 'Session',
      table: 'sessions',
      attributes: { id: { validation: { rule: ruleStub } } },
    } as const)

    const meta = buildSchemaMeta(defineModels({ Coach, Session }))
    expect(resolvePivot(meta, 'coaches', 'sessions')).toBeNull()
    expect(resolvePivot(meta, 'coaches', 'unknown')).toBeNull()
  })
})
