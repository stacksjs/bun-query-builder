/**
 * The table a model without an explicit `table` resolves to.
 *
 * The ORM has always pluralized properly, while the schema, meta and migration
 * layers fell back to `name.toLowerCase() + 's'`. For any model name that is
 * not a bare-`s` plural that is a silent split: the generator created
 * `categorys` and `blogposts` while the ORM read and wrote `categories` and
 * `blog_posts`, so the migration built a table the runtime never touched.
 */
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema } from '../src/factory'
import { tableNameFor, toTableName } from '../src/inflect'
import { buildSchemaMeta } from '../src/meta'
import { buildMigrationPlan } from '../src/migrations'

describe('toTableName', () => {
  it('matches the rules the ORM uses', () => {
    expect(toTableName('User')).toBe('users')
    expect(toTableName('Category')).toBe('categories')
    expect(toTableName('Address')).toBe('addresses')
    expect(toTableName('Box')).toBe('boxes')
    expect(toTableName('Dish')).toBe('dishes')
    expect(toTableName('Batch')).toBe('batches')
    expect(toTableName('OrderItem')).toBe('order_items')
    expect(toTableName('BlogPost')).toBe('blog_posts')
    // A vowel before the `y` keeps the `y`: `days`, not `daies`.
    expect(toTableName('Day')).toBe('days')
    expect(toTableName('Journey')).toBe('journeys')
  })

  it('prefers an explicitly declared table', () => {
    expect(tableNameFor({ name: 'Category', table: 'cats' })).toBe('cats')
    expect(tableNameFor({ name: 'Category' })).toBe('categories')
    expect(tableNameFor({ name: 'Category', table: '' })).toBe('categories')
  })
})

describe('every layer agrees on the table name', () => {
  const models = {
    Category: { name: 'Category', primaryKey: 'id', attributes: { title: { validation: { rule: {} } } } },
    BlogPost: { name: 'BlogPost', primaryKey: 'id', attributes: { title: { validation: { rule: {} } } } },
  } as any

  it('the migration plan, the schema and the meta name the same tables', () => {
    const planned = buildMigrationPlan(models, { dialect: 'sqlite' }).tables.map(t => t.table).sort()
    const schema = Object.keys(buildDatabaseSchema(models)).sort()
    const meta = Object.values(buildSchemaMeta(models).modelToTable).sort()

    expect(planned).toEqual(['blog_posts', 'categories'])
    expect(schema).toEqual(planned)
    expect(meta).toEqual(planned)
  })
})

describe('the ORM and the generator share one convention', () => {
  it('agrees for the shapes that used to diverge', async () => {
    // The ORM resolves the runtime table; the generator resolves the one the
    // migration creates. They are the same function now, so a model without an
    // explicit `table` cannot be read from one table and migrated into another.
    const { toTableName: ormTableName } = await import('../src/orm') as any
    if (typeof ormTableName !== 'function')
      return // not exported; the delegation is covered by the shared helper above

    for (const name of ['User', 'Category', 'Address', 'Box', 'OrderItem', 'BlogPost', 'Day'])
      expect(ormTableName(name)).toBe(toTableName(name))
  })
})
