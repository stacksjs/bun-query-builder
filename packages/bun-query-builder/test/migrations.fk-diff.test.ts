/**
 * Regression coverage for stacksjs/bun-query-builder#1037.
 *
 * columnsAreDifferent compared type/nullable/default/unique/enum but never
 * `references`, so adding/changing a foreign key (or its onDelete) on an
 * existing column produced no migration diff.
 */

import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan, generateDiffSql } from '../src/migrations'
import { defineModels } from '../src/schema'

function plan(postBelongsTo: any) {
  const models = defineModels({
    User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Post: {
      name: 'Post',
      table: 'posts',
      primaryKey: 'id',
      attributes: { id: { validation: { rule: {} } } },
      belongsTo: postBelongsTo,
    },
  } as any)
  return buildMigrationPlan(models as any, { dialect: 'postgres' })
}

describe('migration diff detects FK reference changes (#1037)', () => {
  it('adding onDelete to a belongsTo FK emits an FK statement (was: no diff)', () => {
    const prev = plan(['User']) // user_id references users(id), no onDelete
    const next = plan([{ model: 'User', onDelete: 'cascade' }]) // + ON DELETE CASCADE
    const sql = generateDiffSql(prev, next).join('\n')
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.toLowerCase()).toContain('foreign key')
    expect(sql.toLowerCase()).toContain('cascade')
  })

  it('no FK change → no FK statement', () => {
    const sql = generateDiffSql(plan(['User']), plan(['User'])).join('\n')
    expect(sql.toLowerCase()).not.toContain('add constraint')
  })
})
