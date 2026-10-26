/**
 * Regression coverage for stacksjs/bun-query-builder#1037.
 *
 * columnsAreDifferent compared type/nullable/default/unique/enum but never
 * `references`, so adding/changing a foreign key (or its onDelete) on an
 * existing column produced no migration diff.
 */

import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan, generateDiffSql } from '../src/migrations'
import type { SupportedDialect } from '../src/types'
import { defineModels } from '../src/schema'

function plan(postBelongsTo: any, dialect: SupportedDialect = 'postgres') {
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
  return buildMigrationPlan(models as any, { dialect })
}

describe('migration diff detects FK reference changes (#1037)', () => {
  it.each(['mysql', 'postgres'] as const)('replaces a snapshot relationship before changing its delete action on %s', (dialect) => {
    const previous = plan([{ model: 'User', onDelete: 'cascade' }], dialect)
    const next = plan([{ model: 'User', onDelete: 'set null' }], dialect)
    const sql = generateDiffSql(previous, next).join('\n')
    expect(sql).toContain(dialect === 'mysql' ? 'DROP FOREIGN KEY `posts_user_id_fk`' : 'DROP CONSTRAINT "posts_user_id_fk"')
    expect(sql).toContain('ON DELETE SET NULL')
    expect(sql.indexOf('DROP')).toBeLessThan(sql.indexOf('ADD CONSTRAINT'))
  })
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
