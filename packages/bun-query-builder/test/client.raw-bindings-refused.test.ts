/**
 * The select builder's `*Raw` methods take one fragment and no bindings —
 * stacksjs/bun-query-builder#1146.
 *
 * docs/guide/where.md and docs/api/reference.md showed
 * `db.selectFrom('users').whereRaw('LOWER(email) = ?', ['john@example.com'])`.
 * The TS signature rejects the second argument, but the runtime accepted it and
 * dropped it, so a JS or `as any` caller got `WHERE LOWER(email) = ?` with
 * nothing bound:
 *
 *  - SQLite bound the `?` as NULL and returned `[]`, with no error;
 *  - with another `where()` in front it threw `expected 2 values, received 1`;
 *  - Postgres sent the bare `?` and raised `syntax error at end of input`.
 *
 * Now the call itself throws. `undefined` and an empty array drop nothing, so
 * those still pass, which keeps a wrapper that forwards optional bindings working.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, raw } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        team_id: { type: 'integer' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
  })
}

const REFUSED = /takes a single fragment and no bindings/
const text = (q: any): string => String(q.toSQL())

describe('select builder *Raw methods refuse bindings (#1146)', () => {
  it('whereRaw with the documented array form', () => {
    // The exact call the docs showed.
    expect(() => qb().selectFrom('users').whereRaw('LOWER(name) = ?', ['john'])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereRaw(raw('LOWER(name) = ?'), ['john'])).toThrow(TypeError)
  })

  it('whereRaw with separate arguments', () => {
    expect(() => qb().selectFrom('users').whereRaw(raw('LOWER(name) = ?'), 'john')).toThrow(REFUSED)
  })

  it('every other single-fragment *Raw method', () => {
    const users = () => qb().selectFrom('users')
    expect(() => users().orWhereRaw(raw('id = ?'), [1])).toThrow(/orWhereRaw\(fragment\)/)
    expect(() => users().selectRaw(raw('? as one'), [1])).toThrow(/selectRaw\(fragment\)/)
    expect(() => users().groupByRaw(raw('team_id + ?'), [1])).toThrow(/groupByRaw\(fragment\)/)
    expect(() => users().havingRaw(raw('count(*) > ?'), [1])).toThrow(/havingRaw\(fragment\)/)
    expect(() => users().orderByRaw(raw('id + ?'), [1])).toThrow(/orderByRaw\(fragment\)/)

    const sub = qb().selectFrom('users')
    expect(() => qb().selectFromSub(sub, 'u').selectRaw(raw('? as one'), 1)).toThrow(/selectFromSub\.selectRaw\(fragment\)/)
  })

  it('points each clause at the alternatives that fit it', () => {
    const messageOf = (call: () => unknown): string => {
      try {
        call()
      }
      catch (e) {
        return (e as Error).message
      }
      return ''
    }
    const where = messageOf(() => qb().selectFrom('users').whereRaw(raw('id = ?'), [1]))
    expect(where).toContain('`raw`')
    expect(where).toContain('where()')
    expect(where).toContain('Model.query().whereRaw')

    // An OR fragment must not be steered to the AND-joining where().
    const orWhere = messageOf(() => qb().selectFrom('users').orWhereRaw(raw('id = ?'), [1]))
    expect(orWhere).toContain('orWhere()')
    expect(orWhere).toContain('Model.query().orWhereRaw')
    expect(orWhere).not.toContain(' where()')

    // Nothing typed stands in for HAVING or ORDER BY fragments — having()'s type
    // takes selected columns, not aggregates — so only `raw` is offered.
    for (const call of [
      () => qb().selectFrom('users').havingRaw(raw('count(*) > ?'), [1]),
      () => qb().selectFrom('users').orderByRaw(raw('id + ?'), [1]),
    ]) {
      const message = messageOf(call)
      expect(message).toContain('`raw`')
      expect(message).not.toContain('where()')
      expect(message).not.toContain('having()')
      expect(message).not.toContain('Model.query()')
    }
  })

  it('accepts trailing arguments that drop nothing', () => {
    expect(text(qb().selectFrom('users').whereRaw(raw('id = 1'), undefined))).toContain('WHERE id = 1')
    expect(text(qb().selectFrom('users').whereRaw(raw('id = 1'), []))).toContain('WHERE id = 1')
    expect(text(qb().selectFrom('users').orderByRaw(raw('id desc'), undefined, []))).toContain('ORDER BY id desc')
  })

  it('still refuses a value that follows an allowed undefined or []', () => {
    expect(() => qb().selectFrom('users').whereRaw(raw('id = ?'), undefined, [1])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orderByRaw(raw('id'), [], 'desc')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereRaw(raw('id = ?'), 0)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereRaw(raw('id = ?'), null)).toThrow(REFUSED)
  })

  it('does not mistake values that merely resemble an iteration callback', () => {
    const frag = raw('id = ?')
    expect(() => qb().selectFrom('users').whereRaw(frag, 0, ['x'])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereRaw(frag, 'x', new Set())).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').orderByRaw(raw('id'), 'desc', new Map([['desc', 1]]))).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').whereRaw(frag, 'x', 0, [frag])).toThrow(REFUSED)
    // A bare index is refused on the builder: it cannot be told from a binding.
    expect(() => Array.from([frag], qb().selectFrom('users').whereRaw)).toThrow(REFUSED)
  })

  it('keeps point-free iteration callbacks working', () => {
    // The chain methods close over builder state, so forEach can pass one
    // unbound — and the iteration's (index, array) are not bindings.
    const q = qb().selectFrom('users')
    ;[raw('id > 1'), raw('team_id = 2')].forEach(q.whereRaw)
    expect(text(q)).toContain('WHERE id > 1 AND team_id = 2')

    const ordered = qb().selectFrom('users')
    new Set([raw('id desc')]).forEach(ordered.orderByRaw)
    expect(text(ordered)).toContain('ORDER BY id desc')

    const grouped = qb().selectFrom('users')
    new Map([['k', raw('team_id')]]).forEach(grouped.groupByRaw)
    expect(text(grouped)).toContain('GROUP BY team_id')
  })

  it('a single fragment is unchanged', () => {
    expect(text(qb().selectFrom('users').whereRaw(raw`name = ${'Ada'}`))).toContain(`WHERE name = 'Ada'`)
  })
})

describe('raw(string) refuses values (#1146)', () => {
  // The quickest edit away from `whereRaw('x = ?', [v])` is
  // `whereRaw(raw('x = ?', v))`. That type-checked, returned `{ raw: 'x = ?' }`
  // and dropped the value, so the `?` still went out unbound.
  it('throws when a string is given values', () => {
    expect(() => (raw as any)('LOWER(name) = ?', 'john')).toThrow(/raw\(string\) takes no values/)
    expect(() => (raw as any)('LOWER(name) = ?', ['john'])).toThrow(TypeError)
    expect(() => (raw as any)('LOWER(name) = ?', null)).toThrow(TypeError)
    // An integer is a binding when the string has a placeholder for it.
    expect(() => (raw as any)('id = ?', 0)).toThrow(TypeError)
  })

  it('the string and tagged forms are unchanged', () => {
    expect(raw('id = 1')).toEqual({ raw: 'id = 1' })
    expect((raw as any)('id = 1', undefined)).toEqual({ raw: 'id = 1' })
    expect(raw`name = ${"O'Brien"}`).toEqual({ raw: "name = 'O''Brien'" })
  })

  it('maps over strings point-free', () => {
    const want = [{ raw: 'id desc' }, { raw: 'name asc' }]
    expect(['id desc', 'name asc'].map(raw)).toEqual(want)
    // Array.from's mapper gets (value, index), with no collection to match.
    expect(Array.from(new Set(['id desc', 'name asc']), raw)).toEqual(want)
  })
})
