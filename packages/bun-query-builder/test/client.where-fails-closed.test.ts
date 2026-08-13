/**
 * A `where` the builder does not understand must not be ignored.
 *
 * It used to be. `where()` recognised the string, array, object and raw forms
 * and ended with a bare `return this`, so anything else - most commonly the
 * `where(eb => ...)` callback people write coming from Kysely or Knex - came
 * back as an unchanged builder. The query then ran without the filter and
 * matched every row the filter existed to exclude, with nothing anywhere saying
 * so. In an application where the filter is the access check, that is a data
 * leak; in one where it is a cursor, it is a page that repeats forever.
 *
 * Failing closed is the whole point of these tests: an exception is recoverable
 * and a silently missing predicate is not.
 *
 * The callback form is no longer among the rejected shapes — as of #1083 it
 * builds a real parenthesised group. The guarantee these tests exist to protect
 * survives that change unaltered: a callback that adds NO conditions still
 * throws, because a group contributing nothing is the same silent widening by
 * another route.
 */

import { describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'

function query() {
  return (createQueryBuilder() as any).selectFrom('users')
}

describe('where() refuses what it cannot apply', () => {
  it('rejects a callback that adds no conditions rather than dropping it', () => {
    // The failure mode this replaced: the callback ran, contributed nothing,
    // and the builder came back unfiltered.
    expect(() => query().where((b: any) => { void b })).toThrow(/added no conditions/)
    expect(() => query().where(() => true)).toThrow(/added no conditions/)
  })

  it('names what to do about it, because there is a working form', () => {
    expect(() => query().where(() => true)).toThrow(/where\(\)\/orWhere\(\)/)
  })

  it('applies a callback that does add conditions', () => {
    const sql = String(query().where('id', '=', 1).where((b: any) => b.where('a', '=', 1).orWhere('b', '=', 2)).toSQL())

    expect(sql).toContain('(a = ')
    expect(sql).toContain(' OR b = ')
  })

  it('rejects a missing condition', () => {
    expect(() => query().where(undefined)).toThrow(/no condition/)
    expect(() => query().where(null)).toThrow(/no condition/)
  })

  it('rejects a bare column with no operator or value', () => {
    expect(() => query().where('active')).toThrow(/missing an operator/)
  })

  it('rejects a condition of a type it has no meaning for', () => {
    expect(() => query().where(42)).toThrow(/does not understand/)
  })
})

describe('the forms it does understand still work', () => {
  it('takes a column, an operator and a value', () => {
    const sql = String(query().where('id', '=', 1).toSQL())

    expect(sql).toContain('WHERE')
    expect(sql).toContain('id =')
  })

  it('takes the array form', () => {
    expect(String(query().where(['id', '>', 1]).toSQL())).toContain('id >')
  })

  it('takes the object form', () => {
    const sql = String(query().where({ name: 'Alice' }).toSQL())

    expect(sql).toContain('name =')
  })
})
