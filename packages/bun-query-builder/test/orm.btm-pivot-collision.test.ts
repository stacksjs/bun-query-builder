/**
 * Regression coverage for stacksjs/bun-query-builder#1036.
 *
 * belongsToMany buildSelect used `related.*, pivot.*`, so a pivot column that
 * shares a name with a related column (`status` here, also `id`/`created_at`)
 * overwrote the related value in the flat row. Pivot columns are now aliased.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, configureOrm, defineModel, getDatabase } from '../src'

beforeEach(() => {
  clearModelRegistry()
  configureOrm({ database: new Database(':memory:', { create: true }) })
})
afterEach(() => clearModelRegistry())

describe('belongsToMany pivot/related column collision (#1036)', () => {
  it('keeps the related column distinct from a same-named pivot column', async () => {
    const db = getDatabase()
    db.run('CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE athletes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT)')
    db.run(`CREATE TABLE coach_athletes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, coach_id INTEGER, athlete_id INTEGER, status TEXT
    )`)

    const Athlete = defineModel({
      name: 'Athlete',
      table: 'athletes',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true }, status: { type: 'string', fillable: true } },
    } as const)

    const Coach = defineModel({
      name: 'Coach',
      table: 'coaches',
      primaryKey: 'id',
      attributes: { name: { type: 'string', fillable: true } },
      belongsToMany: {
        athletes: {
          model: 'Athlete',
          table: 'coach_athletes',
          foreignKey: 'coach_id',
          relatedKey: 'athlete_id',
          pivot: { columns: { status: { default: 'active' } } },
        },
      },
    } as const)
    void Athlete

    const coach = await (Coach as any).create({ name: 'Smith' })
    // Related athlete.status = 'retired'; pivot.status = 'active' — must not collide.
    const a = await (Athlete as any).create({ name: 'Anna', status: 'retired' })
    await (coach as any).athletes().attach(a.id, { status: 'active' })

    const [athlete] = await (coach as any).athletes().get()
    expect(athlete.get('status')).toBe('retired') // related column intact
    expect(athlete.get('id')).toBe(a.id) // related PK not overwritten by pivot.id
    expect((athlete as any).pivot.status).toBe('active') // pivot column under .pivot
  })
})
