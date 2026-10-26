/**
 * A join's table can carry an alias (stacksjs/bun-query-builder#1195).
 *
 * `selectFrom('categories as c')` was accepted, but every join validated its
 * table as a bare identifier, so `leftJoin('categories as parent', ...)` threw
 * and a self-join could not be written without raw SQL. Stacks' commerce
 * category stats (top parent categories) failed on exactly that.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    categories: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' }, parent_category_id: { type: 'integer' } } },
  } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  }) as any
}

describe('aliased join tables (#1195)', () => {
  it('renders `table AS alias` for every join that takes a table', () => {
    const on = ['c.parent_category_id', '=', 'parent.id'] as const
    expect(String(qb().selectFrom('categories as c').join('categories as parent', ...on).toSQL())).toContain('JOIN categories AS parent ON c.parent_category_id = parent.id')
    expect(String(qb().selectFrom('categories as c').innerJoin('categories as parent', ...on).toSQL())).toContain('INNER JOIN categories AS parent ON')
    expect(String(qb().selectFrom('categories as c').leftJoin('categories AS parent', ...on).toSQL())).toContain('LEFT JOIN categories AS parent ON')
    expect(String(qb().selectFrom('categories as c').rightJoin('categories as parent', ...on).toSQL())).toContain('RIGHT JOIN categories AS parent ON')
    expect(String(qb().selectFrom('categories as c').crossJoin('categories as parent').toSQL())).toContain('CROSS JOIN categories AS parent')
  })

  it('still rejects anything that is not a table and an alias', () => {
    for (const table of ['categories as parent; DROP TABLE categories', 'categories as', 'categories as parent extra', 'categories as par-ent', 'categories parent'])
      expect(() => qb().selectFrom('categories').leftJoin(table, 'categories.id', '=', 'parent.id')).toThrow('Invalid identifier')
  })

  it('produces a self-join that runs', () => {
    const sql = String(qb()
      .selectFrom('categories as c')
      .select(['c.name', 'parent.name as parent_name'])
      .leftJoin('categories as parent', 'c.parent_category_id', '=', 'parent.id')
      .toSQL())

    const db = new Database(':memory:')
    db.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, parent_category_id INTEGER)`)
    db.exec(`INSERT INTO categories VALUES (1, 'Clothing', NULL), (2, 'Shirts', 1)`)
    expect(db.query(`${sql} ORDER BY c.id`).all()).toEqual([
      { name: 'Clothing', parent_name: null },
      { name: 'Shirts', parent_name: 'Clothing' },
    ])
  })
})
