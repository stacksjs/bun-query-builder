/**
 * A declared `belongsTo` decides what a foreign key points at.
 *
 * Foreign keys on declared attributes were resolved purely from the column
 * name: `author_id` was taken to mean an `Author` model. A model that says
 * `belongsTo: [{ model: 'User', foreignKey: 'author_id' }]` means users, and
 * when a table named `authors` happened to exist the constraint was generated
 * against it — every insert of a real user id was then rejected by the
 * database, with a message naming a table the model never mentions.
 */

import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

function columnOf(plan: any, table: string, column: string) {
  return plan.tables.find((entry: any) => entry.table === table)?.columns.find((entry: any) => entry.name === column)
}

function build(issueBelongsTo: any, extra: Record<string, any> = {}) {
  const models = defineModels({
    User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Author: { name: 'Author', table: 'authors', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Issue: {
      name: 'Issue',
      table: 'issues',
      primaryKey: 'id',
      attributes: {
        id: { validation: { rule: {} } },
        author_id: { validation: { rule: {} } },
      },
      belongsTo: issueBelongsTo,
    },
    ...extra,
  } as any)

  return buildMigrationPlan(models as any, { dialect: 'postgres' })
}

describe('foreign keys on declared attributes', () => {
  it('points a declared foreign key at the model belongsTo names', () => {
    const plan = build([{ model: 'User', foreignKey: 'author_id' }])

    expect(columnOf(plan, 'issues', 'author_id').references).toEqual({ table: 'users', column: 'id' })
  })

  it('prefers the declaration even when a same-named model exists', () => {
    // `authors` exists here, which is exactly the case that produced a
    // constraint against the wrong table.
    const plan = build([{ model: 'User', foreignKey: 'author_id' }])

    expect(columnOf(plan, 'issues', 'author_id').references.table).not.toBe('authors')
  })

  it('still falls back to the column name when nothing is declared', () => {
    const plan = build([])

    expect(columnOf(plan, 'issues', 'author_id').references).toEqual({ table: 'authors', column: 'id' })
  })

  it('leaves the conventional case alone', () => {
    const models = defineModels({
      User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
      Star: {
        name: 'Star',
        table: 'stars',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } }, user_id: { validation: { rule: {} } } },
        belongsTo: ['User'],
      },
    } as any)
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

    expect(columnOf(plan, 'stars', 'user_id').references).toEqual({ table: 'users', column: 'id' })
  })

  it('handles two declared keys pointing at the same model', () => {
    // A review has a reviewer and a requester, and neither column is user_id.
    const models = defineModels({
      User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
      Review: {
        name: 'Review',
        table: 'reviews',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          reviewer_id: { validation: { rule: {} } },
          requested_by_id: { validation: { rule: {} } },
        },
        belongsTo: [
          { model: 'User', foreignKey: 'reviewer_id' },
          { model: 'User', foreignKey: 'requested_by_id' },
        ],
      },
    } as any)
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

    expect(columnOf(plan, 'reviews', 'reviewer_id').references.table).toBe('users')
    expect(columnOf(plan, 'reviews', 'requested_by_id').references.table).toBe('users')
  })

  it('respects an explicit foreignKey config over both', () => {
    const models = defineModels({
      User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
      Issue: {
        name: 'Issue',
        table: 'issues',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          author_id: { validation: { rule: {} }, foreignKey: { table: 'accounts', column: 'id' } },
        },
        belongsTo: [{ model: 'User', foreignKey: 'author_id' }],
      },
    } as any)
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

    expect(columnOf(plan, 'issues', 'author_id').references.table).toBe('accounts')
  })

  it('generates no constraint when the declared model is not in the set', () => {
    const models = defineModels({
      Issue: {
        name: 'Issue',
        table: 'issues',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} } },
          author_id: { validation: { rule: {} } },
        },
        belongsTo: [{ model: 'User', foreignKey: 'author_id' }],
      },
    } as any)
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

    // Better no constraint than one against a table that is not there.
    expect(columnOf(plan, 'issues', 'author_id').references).toBeUndefined()
  })
})
