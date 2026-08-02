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
 */

import { describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'

function query() {
  return (createQueryBuilder() as any).selectFrom('users')
}

describe('where() refuses what it cannot apply', () => {
  it('rejects the expression-callback form rather than dropping it', () => {
    expect(() => query().where((eb: any) => eb.or([]))).toThrow(/where\(callback\) is not supported/)
  })

  it('names the alternatives, because there are working ones', () => {
    expect(() => query().where(() => true)).toThrow(/whereNested|whereAny|orWhere/)
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
