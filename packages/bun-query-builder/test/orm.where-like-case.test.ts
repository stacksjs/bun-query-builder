/**
 * The model builder's LIKE family must match the query builder's on case —
 * stacksjs/bun-query-builder#1206.
 *
 * `db.selectFrom(...).whereLike` renders `LOWER(col) LIKE LOWER(?)` and is
 * case-insensitive by default. `Model.query().whereLike` pushed a plain
 * `like`, which PostgreSQL treats case-sensitively, so the two builders
 * disagreed. SQLite and MySQL hid it, because their `LIKE` ignores case
 * anyway, which is why this only showed up after a move to PostgreSQL.
 *
 * Measured against PostgreSQL 16 with ('Tesla','Model 3') and ('Ford','Focus'):
 *
 *   db builder    whereLike("make","%tesla%") -> 1
 *   model builder whereLike("make","%tesla%") -> 0     <- the bug
 *   model builder whereLike("make","%Tesla%") -> 1
 *
 * In Stacks the dashboard's Models search did exactly this: `donald` did not
 * find `Donald` (stacksjs/stacks#3202).
 *
 * NOTE this changes a default. A caller who relied on `whereLike` being
 * case-sensitive on PostgreSQL now matches more rows, and opts back in with
 * `whereLike(column, pattern, true)`. The generic `where(col, 'like', v)` form
 * is deliberately untouched and stays case-sensitive, exactly as it is on the
 * query builder.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createModel, setConfig } from '../src'

let seq = 0

function carModel(dialect: 'postgres' | 'sqlite' | 'mysql'): any {
  setConfig({ dialect } as any)
  // A fresh model name per call: the registry is process-wide.
  return createModel({
    name: `LikeCar${dialect}${seq++}`,
    table: 'cars',
    primaryKey: 'id',
    attributes: { make: {}, model: {} },
  } as any)
}

function sqlOf(builder: any): string {
  return String(builder.toSql().sql)
}

afterEach(() => {
  setConfig({ dialect: 'sqlite' } as any)
})

describe('the model builder lowers both sides by default', () => {
  it('on postgres, where the divergence was visible', () => {
    const Car = carModel('postgres')
    expect(sqlOf(Car.query().whereLike('make', '%tesla%'))).toContain('LOWER(make) LIKE LOWER(?)')
  })

  it('on sqlite and mysql, which hid the bug', () => {
    expect(sqlOf(carModel('sqlite').query().whereLike('make', '%tesla%'))).toContain('LOWER(make) LIKE LOWER(?)')
    // MySQL quotes reserved-word columns; the quoting must survive the LOWER().
    expect(sqlOf(carModel('mysql').query().whereLike('make', '%tesla%'))).toContain('LOWER(`make`) LIKE LOWER(?)')
  })

  it('the or- and not- spellings too', () => {
    const Car = carModel('postgres')
    expect(sqlOf(Car.query().whereLike('make', '%t%').orWhereLike('model', '%t%')))
      .toContain('LOWER(model) LIKE LOWER(?)')
    expect(sqlOf(carModel('postgres').query().whereNotLike('make', '%t%')))
      .toContain('LOWER(make) NOT LIKE LOWER(?)')
    expect(sqlOf(carModel('postgres').query().orWhereNotLike('make', '%t%')))
      .toContain('LOWER(make) NOT LIKE LOWER(?)')
  })
})

describe('caseSensitive opts back out', () => {
  it('renders the bare comparison the old default gave', () => {
    const sql = sqlOf(carModel('postgres').query().whereLike('make', '%tesla%', true))
    expect(sql).toContain('make LIKE ?')
    expect(sql).not.toContain('LOWER')
  })

  it('and for the not- spelling', () => {
    const sql = sqlOf(carModel('postgres').query().whereNotLike('make', '%t%', true))
    expect(sql).toContain('make NOT LIKE ?')
    expect(sql).not.toContain('LOWER')
  })
})

describe('whereILike matches the query builder', () => {
  it('uses native ILIKE on postgres', () => {
    expect(sqlOf(carModel('postgres').query().whereILike('make', '%t%'))).toContain('make ILIKE ?')
    expect(sqlOf(carModel('postgres').query().whereNotILike('make', '%t%'))).toContain('make NOT ILIKE ?')
  })

  it('falls back to LOWER() where there is no ILIKE', () => {
    expect(sqlOf(carModel('sqlite').query().whereILike('make', '%t%'))).toContain('LOWER(make) LIKE LOWER(?)')
    expect(sqlOf(carModel('mysql').query().whereILike('make', '%t%'))).toContain('LOWER(`make`) LIKE LOWER(?)')
  })

  it('or-spellings exist as well', () => {
    expect(sqlOf(carModel('postgres').query().orWhereILike('make', '%t%'))).toContain('ILIKE')
    expect(sqlOf(carModel('postgres').query().orWhereNotILike('make', '%t%'))).toContain('NOT ILIKE')
  })
})

describe('the generic where(col, operator, value) form is untouched', () => {
  it('stays case-sensitive, as it is on the query builder', () => {
    // Only the dedicated whereLike family carries the default; `where` with an
    // explicit operator still compares the column as stored.
    //
    // The keyword itself is now emitted as `LIKE` rather than echoing the
    // caller's lowercase `like`, because this path shares renderLikePredicate
    // with the rest of the family. SQL keywords are case-insensitive, so the
    // statement is the same one; asserted loosely here so the casing is not
    // mistaken for the behaviour that matters.
    const sql = sqlOf(carModel('postgres').query().where('make', 'like', '%tesla%'))
    expect(sql).toMatch(/\bmake (?:like|LIKE) \?/)
    expect(sql).not.toContain('LOWER')
  })
})
