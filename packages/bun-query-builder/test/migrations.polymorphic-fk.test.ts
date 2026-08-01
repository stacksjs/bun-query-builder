/**
 * A polymorphic column never gets a foreign key.
 *
 * `commentable_id` beside `commentable_type` means the row points at one of
 * several tables, chosen per row. No foreign key can express that: the
 * constraint names a single table and rejects every row pointing at any other
 * one. A comments table modelled this way took a constraint against `issues`,
 * and the first comment attached to a pull request failed to insert.
 *
 * This holds whether the relationship was declared or merely inferred from the
 * column name, because there is no spelling of it that would make the
 * constraint correct.
 */

import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

function columnOf(plan: any, table: string, column: string) {
  return plan.tables.find((entry: any) => entry.table === table)?.columns.find((entry: any) => entry.name === column)
}

function build(commentBelongsTo?: any, attributes?: Record<string, any>) {
  const models = defineModels({
    Issue: { name: 'Issue', table: 'issues', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Comment: {
      name: 'Comment',
      table: 'comments',
      primaryKey: 'id',
      attributes: attributes ?? {
        id: { validation: { rule: {} } },
        commentable_type: { validation: { rule: {} } },
        commentable_id: { validation: { rule: {} } },
        author_id: { validation: { rule: {} } },
      },
      belongsTo: commentBelongsTo,
    },
  } as any)

  return buildMigrationPlan(models as any, { dialect: 'postgres' })
}

describe('foreign keys on polymorphic columns', () => {
  it('emits no foreign key for a declared polymorphic relation', () => {
    const plan = build([{ model: 'Issue', foreignKey: 'commentable_id' }, { model: 'User', foreignKey: 'author_id' }])

    expect(columnOf(plan, 'comments', 'commentable_id').references).toBeUndefined()
  })

  it('still constrains the ordinary relation on the same model', () => {
    // The guard has to be narrow: `author_id` is a real foreign key and losing
    // it would trade one bug for another.
    const plan = build([{ model: 'Issue', foreignKey: 'commentable_id' }, { model: 'User', foreignKey: 'author_id' }])

    expect(columnOf(plan, 'comments', 'author_id').references).toEqual({ table: 'users', column: 'id' })
  })

  it('emits no foreign key when the pair is only inferred from naming', () => {
    // A model that declares nothing falls back to convention, and convention
    // must not invent a constraint here either.
    const plan = build(undefined, {
      id: { validation: { rule: {} } },
      user_type: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
    })

    expect(columnOf(plan, 'comments', 'user_id').references).toBeUndefined()
  })

  it('keeps the column itself, since the ORM writes to it', () => {
    const plan = build([{ model: 'Issue', foreignKey: 'commentable_id' }])

    expect(columnOf(plan, 'comments', 'commentable_id')).toBeDefined()
    expect(columnOf(plan, 'comments', 'commentable_type')).toBeDefined()
  })

  it('leaves a lone _id column alone when no _type sits beside it', () => {
    const plan = build(undefined, {
      id: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
    })

    expect(columnOf(plan, 'comments', 'user_id').references).toEqual({ table: 'users', column: 'id' })
  })
})
