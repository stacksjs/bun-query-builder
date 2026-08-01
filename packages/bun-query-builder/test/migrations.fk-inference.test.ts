import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan } from '../src/migrations'

/**
 * Foreign keys follow what a model says, not what a column is called.
 *
 * The regression: a model declaring `belongsTo: [{ model: 'User', foreignKey:
 * 'author_id' }]` still had `author_id` resolved by convention to a table named
 * `authors`. In an app that also ships a CMS that is a real table from an
 * entirely different domain, so the generated migration constrained a forge's
 * issue author against CMS authors - or against a table that did not exist, in
 * which case the migration simply failed. Either way it was produced silently.
 */
function referencesFor(plan: any, table: string, column: string) {
  return plan.tables.find((t: any) => t.table === table)
    ?.columns.find((c: any) => c.name === column)
    ?.references
}

const attr = { validation: { rule: {} } }

describe('foreign key inference', () => {
  it('points a declared column at the declared table, not the same-named one', () => {
    const plan = buildMigrationPlan({
      Issue: {
        name: 'Issue',
        table: 'issues',
        belongsTo: ['Repository', { model: 'User', foreignKey: 'author_id' }],
        attributes: { repository_id: attr, author_id: attr },
      },
      Repository: { name: 'Repository', table: 'repositories', attributes: {} },
      User: { name: 'User', table: 'users', attributes: {} },
      // The trap: an unrelated model whose name matches the column.
      Author: { name: 'Author', table: 'authors', attributes: {} },
    } as any, { dialect: 'postgres' })

    expect(referencesFor(plan, 'issues', 'author_id')?.table).not.toBe('authors')
    expect(referencesFor(plan, 'issues', 'repository_id')?.table).toBe('repositories')
  })

  it('does not invent a foreign key for a column the model never declared', () => {
    // Ends in _id, is not declared, and a matching model exists. Still not a
    // foreign key: the model documented its relationships and this is not one.
    const plan = buildMigrationPlan({
      Post: {
        name: 'Post',
        table: 'posts',
        belongsTo: ['Repository'],
        attributes: { repository_id: attr, user_id: attr },
      },
      Repository: { name: 'Repository', table: 'repositories', attributes: {} },
      User: { name: 'User', table: 'users', attributes: {} },
    } as any, { dialect: 'postgres' })

    expect(referencesFor(plan, 'posts', 'repository_id')?.table).toBe('repositories')
    expect(referencesFor(plan, 'posts', 'user_id')).toBeUndefined()
  })

  it('still uses convention for a model that declares nothing', () => {
    // The case the inference was written for, unchanged.
    const plan = buildMigrationPlan({
      Comment: { name: 'Comment', table: 'comments', attributes: { user_id: attr } },
      User: { name: 'User', table: 'users', attributes: {} },
    } as any, { dialect: 'postgres' })

    expect(referencesFor(plan, 'comments', 'user_id')?.table).toBe('users')
  })
})
