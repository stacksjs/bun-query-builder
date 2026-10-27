/**
 * Identifier injection on the belongsToMany relation filters.
 *
 * `orderBy` on this builder has validated its column since
 * stacksjs/stacks#1858, which called out that these names are interpolated
 * RAW into SQL. The `where` / `wherePivot*` family beside it was left out, so
 * a column name from request input escaped the relation's own parent scope.
 *
 * Measured before the fix, against the same two-coach fixture used below:
 *
 *   legit    : [ "MyAthlete" ]
 *   injected : [ "MyAthlete", "TheirAthlete" ]
 *
 * The payload is `role = 'primary' OR 1=1 OR role`, which keeps the trailing
 * `?` intact — the naive `--` form truncates the placeholder and bun:sqlite
 * rejects the statement with "expected 1 values, received 2", so the obvious
 * payload fails noisily and this one does not fail at all.
 *
 * The operator slot of the three-argument form was interpolated raw too. No
 * working bypass through it was produced here, so it is validated on the same
 * grounds as the column rather than on a measured exploit.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, configureOrm, defineModel, getDatabase } from '../src'

const ruleStub = { validate: (v: unknown) => v != null } as any

beforeEach(() => {
  clearModelRegistry()
  configureOrm({ database: new Database(':memory:', { create: true }) })
})

function makeModels() {
  const Athlete = defineModel({
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
    belongsToMany: {
      athletes: {
        model: 'Athlete',
        table: 'coach_athletes',
        foreignKey: 'coach_id',
        relatedKey: 'athlete_id',
        pivot: { columns: { role: { default: 'shared' } } },
      },
    },
  } as const)
  const db = getDatabase()
  db.run('CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  db.run('CREATE TABLE athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  db.run(`CREATE TABLE coach_athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, coach_id INTEGER, athlete_id INTEGER, role TEXT DEFAULT 'shared')`)
  return { Coach, Athlete }
}

/** Two coaches with one athlete each, so a scope escape is visible as a name. */
async function twoCoaches() {
  const { Coach, Athlete } = makeModels()
  const mine = await Coach.create({ name: 'Mine' })
  const theirs = await Coach.create({ name: 'Theirs' })
  const a1 = await Athlete.create({ name: 'MyAthlete' })
  const a2 = await Athlete.create({ name: 'TheirAthlete' })
  await (mine as any).athletes().attach(a1.id, { role: 'primary' })
  await (theirs as any).athletes().attach(a2.id, { role: 'primary' })
  return { mine, theirs }
}

const REFUSED = /refusing to interpolate into SQL|refusing to use/
const BYPASS = `role = 'primary' OR 1=1 OR role`

describe('pivot filter injection is refused', () => {
  it('wherePivot, the column slot that escaped the parent scope', async () => {
    const { mine } = await twoCoaches()
    expect(() => (mine as any).athletes().wherePivot(BYPASS, 'primary')).toThrow(REFUSED)
  })

  it('where, the same slot against the related table', async () => {
    const { mine } = await twoCoaches()
    expect(() => (mine as any).athletes().where(BYPASS, 'primary')).toThrow(REFUSED)
  })

  it('the wherePivotIn / NotIn / Null / NotNull spellings', async () => {
    const { mine } = await twoCoaches()
    expect(() => (mine as any).athletes().wherePivotIn(BYPASS, ['primary'])).toThrow(REFUSED)
    expect(() => (mine as any).athletes().wherePivotNotIn(BYPASS, ['primary'])).toThrow(REFUSED)
    expect(() => (mine as any).athletes().wherePivotNull(BYPASS)).toThrow(REFUSED)
    expect(() => (mine as any).athletes().wherePivotNotNull(BYPASS)).toThrow(REFUSED)
  })

  it('wherePivotIn refuses before the empty-list short circuit', async () => {
    // `if (!values.length) return this` sat above the interpolation, so an
    // empty list must not be a way to skip the check and keep the builder.
    const { mine } = await twoCoaches()
    expect(() => (mine as any).athletes().wherePivotIn(BYPASS, [])).toThrow(REFUSED)
  })

  it('the operator slot of the three-argument form', async () => {
    const { mine } = await twoCoaches()
    expect(() => (mine as any).athletes().wherePivot('role', `= 'primary' OR 1=1 OR role =`, 'x')).toThrow(REFUSED)
    expect(() => (mine as any).athletes().where('name', `= 'x' OR 1=1 OR name =`, 'x')).toThrow(REFUSED)
  })
})

describe('legitimate pivot filters still work', () => {
  it('wherePivot keeps the parent scope and filters', async () => {
    const { mine } = await twoCoaches()
    const rows = await (mine as any).athletes().wherePivot('role', 'primary').get()
    expect(rows.map((a: any) => a.get('name'))).toEqual(['MyAthlete'])
  })

  it('the three-argument form with a real operator', async () => {
    const { mine } = await twoCoaches()
    const rows = await (mine as any).athletes().wherePivot('role', '=', 'primary').get()
    expect(rows.map((a: any) => a.get('name'))).toEqual(['MyAthlete'])
  })

  it('wherePivotIn, wherePivotNotNull and where still scope to the parent', async () => {
    const { mine } = await twoCoaches()
    expect((await (mine as any).athletes().wherePivotIn('role', ['primary', 'shared']).get()).length).toBe(1)
    expect((await (mine as any).athletes().wherePivotNotNull('role').get()).length).toBe(1)
    expect((await (mine as any).athletes().where('name', 'MyAthlete').get()).length).toBe(1)
  })
})
