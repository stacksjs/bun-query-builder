/**
 * Coverage for relation aggregate selects (stacksjs/bun-query-builder#1046):
 * withSum / withAvg / withMax / withMin as correlated subqueries, mirroring
 * the existing withCount.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    User: { name: 'User', table: 'users', primaryKey: 'id', hasMany: ['Post'], attributes: { id: {}, name: {} } },
    Post: { name: 'Post', table: 'posts', primaryKey: 'id', attributes: { id: {}, views: {}, user_id: {} } },
  } as any
  const schema = buildDatabaseSchema({ users: { columns: { id: {}, name: {} } }, posts: { columns: { id: {}, views: {}, user_id: {} } } } as any)
  const meta = buildSchemaMeta(models)
  return createQueryBuilder<typeof schema>({ schema, meta, autoMigration: { enabled: false } as any })
}

describe('withSum/withAvg/withMax/withMin (#1046)', () => {
  it('withSum emits a correlated SUM subquery aliased <rel>_sum_<col>', () => {
    const sql = String((qb() as any).selectFrom('users').withSum('Post', 'views').toSQL())
    expect(sql).toContain('SUM(posts.views)')
    expect(sql).toContain('FROM posts WHERE posts.user_id = users.id')
    expect(sql).toContain('AS Post_sum_views')
  })

  it('withAvg/withMax/withMin emit their aggregate', () => {
    expect(String((qb() as any).selectFrom('users').withAvg('Post', 'views').toSQL())).toContain('AVG(posts.views)')
    expect(String((qb() as any).selectFrom('users').withMax('Post', 'views').toSQL())).toContain('MAX(posts.views)')
    expect(String((qb() as any).selectFrom('users').withMin('Post', 'views').toSQL())).toContain('MIN(posts.views)')
  })

  it('rejects an unsafe column identifier', () => {
    expect(() => (qb() as any).selectFrom('users').withSum('Post', 'views); DROP TABLE users--').toSQL())
      .toThrow()
  })
})
