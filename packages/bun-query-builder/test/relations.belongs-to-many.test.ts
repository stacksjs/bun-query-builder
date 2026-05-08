/**
 * BelongsToMany RelationBuilder tests — exercises the new `coach.athletes()`
 * callable accessor on ModelInstance plus the attach/detach/sync/
 * updateExistingPivot/toggle mutation surface and `wherePivot*` filtering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, configureOrm, defineModel, getDatabase } from '../src'

const ruleStub = { validate: (v: unknown) => v != null } as any

beforeEach(() => {
  // Fresh in-memory DB per test. bun:sqlite caches prepared statements per
  // database, and DROPing+recreating tables with different column shapes
  // keeps returning the stale column list on `db.query(...).all()`.
  clearModelRegistry()
  configureOrm({ database: new Database(':memory:', { create: true }) })
})

afterEach(() => {
  clearModelRegistry()
})

function makeCoachAthleteModels(opts: { withPivotModel?: boolean, timestamps?: boolean } = {}) {
  const Athlete = defineModel({
    name: 'Athlete',
    table: 'athletes',
    primaryKey: 'id',
    attributes: {
      name: { type: 'string', fillable: true, validation: { rule: ruleStub } },
    },
  } as const)

  // Pivot model (Option B). Defined regardless of variant — the variant flag
  // controls whether Coach references it via `through`.
  const CoachAthlete = defineModel({
    name: 'CoachAthlete',
    table: 'coach_athletes',
    primaryKey: 'id',
    attributes: {
      coach_id: { type: 'number', validation: { rule: ruleStub } },
      athlete_id: { type: 'number', validation: { rule: ruleStub } },
      role: { type: 'string', validation: { rule: ruleStub } },
      status: { type: 'string', validation: { rule: ruleStub } },
    },
  } as const)

  const Coach = defineModel({
    name: 'Coach',
    table: 'coaches',
    primaryKey: 'id',
    attributes: {
      name: { type: 'string', fillable: true, validation: { rule: ruleStub } },
    },
    belongsToMany: {
      athletes: opts.withPivotModel
        ? { model: 'Athlete', through: 'CoachAthlete', table: 'coach_athletes', foreignKey: 'coach_id', relatedKey: 'athlete_id', pivot: { timestamps: opts.timestamps } }
        : {
            model: 'Athlete',
            table: 'coach_athletes',
            foreignKey: 'coach_id',
            relatedKey: 'athlete_id',
            pivot: {
              timestamps: opts.timestamps,
              columns: {
                role: { default: 'shared' },
                status: { default: 'active' },
              },
            },
          },
    },
  } as const)

  // Create tables
  const db = getDatabase()
  db.run('CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  db.run('CREATE TABLE athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  const tsCols = opts.timestamps ? ', created_at TEXT, updated_at TEXT' : ''
  db.run(`CREATE TABLE coach_athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, coach_id INTEGER, athlete_id INTEGER, role TEXT DEFAULT 'shared', status TEXT DEFAULT 'active'${tsCols})`)

  return { Coach, Athlete, CoachAthlete }
}

describe('BelongsToManyRelationBuilder (Option A)', () => {
  it('attaches a single related id with extras', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const athlete = Athlete.create({ name: 'Anna' })
    const inserted = (coach as any).athletes().attach(athlete.id, { role: 'primary', status: 'active' })
    expect(inserted).toBe(1)

    const rows = getDatabase().query('SELECT * FROM coach_athletes').all() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].coach_id).toBe(coach.id)
    expect(rows[0].athlete_id).toBe(athlete.id)
    expect(rows[0].role).toBe('primary')
  })

  it('attaches an array of related ids', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    const a3 = Athlete.create({ name: 'Cara' })
    const n = (coach as any).athletes().attach([a1.id, a2.id, a3.id])
    expect(n).toBe(3)
    const rows = getDatabase().query('SELECT * FROM coach_athletes').all() as any[]
    expect(rows.length).toBe(3)
  })

  it('detaches a specific id and detaches all when no id given', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    ;(coach as any).athletes().attach([a1.id, a2.id])
    const removed = (coach as any).athletes().detach(a1.id)
    expect(removed).toBe(1)
    const remaining = getDatabase().query('SELECT * FROM coach_athletes').all() as any[]
    expect(remaining.length).toBe(1)
    expect(remaining[0].athlete_id).toBe(a2.id)

    const removedAll = (coach as any).athletes().detach()
    expect(removedAll).toBe(1)
    expect(getDatabase().query('SELECT * FROM coach_athletes').all().length).toBe(0)
  })

  it('updateExistingPivot updates extras for a specific (parent, related) pair', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const athlete = Athlete.create({ name: 'Anna' })
    ;(coach as any).athletes().attach(athlete.id, { role: 'shared' })
    const updated = (coach as any).athletes().updateExistingPivot(athlete.id, { role: 'primary' })
    expect(updated).toBe(1)
    const row = getDatabase().query('SELECT * FROM coach_athletes WHERE coach_id = ? AND athlete_id = ?').get(coach.id, athlete.id) as any
    expect(row.role).toBe('primary')
  })

  it('sync attaches new, detaches missing, updates existing', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    const a3 = Athlete.create({ name: 'Cara' })
    ;(coach as any).athletes().attach([a1.id, a2.id], { role: 'shared' })

    const result = (coach as any).athletes().sync([
      { id: a2.id, role: 'primary' },
      { id: a3.id, role: 'shared' },
    ])
    expect(result.attached).toEqual([a3.id])
    expect(result.detached).toEqual([a1.id])
    expect(result.updated).toEqual([a2.id])

    const rows = getDatabase().query('SELECT athlete_id, role FROM coach_athletes ORDER BY athlete_id').all() as any[]
    expect(rows).toEqual([
      { athlete_id: a2.id, role: 'primary' },
      { athlete_id: a3.id, role: 'shared' },
    ])
  })

  it('toggle flips attached/detached state', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    ;(coach as any).athletes().attach(a1.id)

    const r = (coach as any).athletes().toggle([a1.id, a2.id])
    expect(r.attached).toEqual([a2.id])
    expect(r.detached).toEqual([a1.id])
    const remaining = getDatabase().query('SELECT athlete_id FROM coach_athletes').all() as any[]
    expect(remaining.map(r => r.athlete_id)).toEqual([a2.id])
  })

  it('get() returns related model instances with .pivot extras', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    ;(coach as any).athletes().attach(a1.id, { role: 'primary' })
    ;(coach as any).athletes().attach(a2.id, { role: 'shared' })
    const all = (coach as any).athletes().get()
    expect(all.length).toBe(2)
    const roles = all.map((a: any) => a.pivot.role).sort()
    expect(roles).toEqual(['primary', 'shared'])
    expect(all[0].get('name')).toBeDefined()
  })

  it('wherePivot filters by a pivot column', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    ;(coach as any).athletes().attach(a1.id, { role: 'primary' })
    ;(coach as any).athletes().attach(a2.id, { role: 'shared' })
    const onlyPrimary = (coach as any).athletes().wherePivot('role', 'primary').get()
    expect(onlyPrimary.length).toBe(1)
    expect(onlyPrimary[0].get('name')).toBe('Anna')
  })

  it('wherePivotIn filters by a list', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    const a3 = Athlete.create({ name: 'Cara' })
    ;(coach as any).athletes().attach(a1.id, { status: 'active' })
    ;(coach as any).athletes().attach(a2.id, { status: 'pending' })
    ;(coach as any).athletes().attach(a3.id, { status: 'archived' })
    const filtered = (coach as any).athletes().wherePivotIn('status', ['active', 'pending']).get()
    expect(filtered.length).toBe(2)
  })

  it('count and exists work via the pivot', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    expect((coach as any).athletes().exists()).toBe(false)
    ;(coach as any).athletes().attach(a1.id)
    expect((coach as any).athletes().count()).toBe(1)
    expect((coach as any).athletes().exists()).toBe(true)
  })

  it('pivot timestamps are filled when enabled', () => {
    const { Coach, Athlete } = makeCoachAthleteModels({ timestamps: true })
    const coach = Coach.create({ name: 'Smith' })
    const a1 = Athlete.create({ name: 'Anna' })
    ;(coach as any).athletes().attach(a1.id, { role: 'shared' })
    const row = getDatabase().query('SELECT * FROM coach_athletes').get() as any
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
  })
})

describe('belongsToMany eager loading via Model.query().with(...)', () => {
  it('loads pivot extras as `.pivot` on each related instance', () => {
    const { Coach, Athlete } = makeCoachAthleteModels()
    const c1 = Coach.create({ name: 'Smith' })
    const c2 = Coach.create({ name: 'Jones' })
    const a1 = Athlete.create({ name: 'Anna' })
    const a2 = Athlete.create({ name: 'Bob' })
    ;(c1 as any).athletes().attach(a1.id, { role: 'primary' })
    ;(c1 as any).athletes().attach(a2.id, { role: 'shared' })
    ;(c2 as any).athletes().attach(a2.id, { role: 'primary' })

    const coaches = (Coach as any).query().with('athletes').get() as any[]
    const sm = coaches.find((c: any) => c.get('name') === 'Smith')
    const js = coaches.find((c: any) => c.get('name') === 'Jones')
    const smAthletes = sm.getRelation('athletes') as any[]
    const jsAthletes = js.getRelation('athletes') as any[]
    expect(smAthletes.length).toBe(2)
    expect(jsAthletes.length).toBe(1)
    const smRoles = smAthletes.map((a: any) => a.pivot.role).sort()
    expect(smRoles).toEqual(['primary', 'shared'])
    expect(jsAthletes[0].pivot.role).toBe('primary')
  })
})

describe('BelongsToManyRelationBuilder (Option B `through:`)', () => {
  it('reads pivot columns from the through-model attributes', () => {
    const { Coach, Athlete } = makeCoachAthleteModels({ withPivotModel: true })
    const coach = Coach.create({ name: 'Smith' })
    const athlete = Athlete.create({ name: 'Anna' })
    ;(coach as any).athletes().attach(athlete.id, { role: 'primary', status: 'active' })
    const all = (coach as any).athletes().get()
    expect(all.length).toBe(1)
    expect(all[0].pivot.role).toBe('primary')
    expect(all[0].pivot.status).toBe('active')
  })

  it('throws when through-model is not registered', () => {
    defineModel({
      name: 'Athlete',
      table: 'athletes',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true, validation: { rule: ruleStub } } },
    } as const)
    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true, validation: { rule: ruleStub } } },
      belongsToMany: { athletes: { model: 'Athlete', through: 'GhostPivot', foreignKey: 'coach_id', relatedKey: 'athlete_id' } },
    } as const)
    const db = getDatabase()
    db.run('CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    const coach = Coach.create({ name: 'Smith' })
    expect(() => (coach as any).athletes()).toThrow(/unknown through model 'GhostPivot'/)
  })
})
