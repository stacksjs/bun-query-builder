/**
 * Coverage for the compose-aware ORDER BY / GROUP BY / LIMIT / OFFSET
 * clauses on the `selectFrom` builder. Before this fix, calling these
 * methods twice on the same chain emitted invalid SQL —
 *   `ORDER BY a ASC ORDER BY b ASC`
 *   `LIMIT 5 LIMIT 10`
 * which SQLite/MySQL/Postgres all reject.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        email: { type: 'text' },
        rating: { type: 'integer' },
        created_at: { type: 'timestamp' },
      },
    },
  } as any
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  return createQueryBuilder<typeof schema>({
    schema,
    meta,
    autoMigration: { enabled: false } as any,
  })
}

describe('selectFrom compose-aware clauses', () => {
  describe('orderBy', () => {
    it('chains two columns into a single ORDER BY clause', () => {
      const sql = String((qb() as any).selectFrom('users').orderBy('rating', 'desc').orderBy('name').toSQL())
      // Single ORDER BY with two comma-separated columns — not two clauses.
      const matches = sql.match(/ORDER BY/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/ORDER BY rating DESC, name ASC/i)
    })

    it('chains three columns including a desc shortcut', () => {
      const sql = String((qb() as any).selectFrom('users').orderBy('id').orderByDesc('rating').orderBy('name', 'asc').toSQL())
      const matches = sql.match(/ORDER BY/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/ORDER BY id ASC, rating DESC, name ASC/i)
    })

    it('orderByRaw appends with comma when ORDER BY is already present', () => {
      const sql = String((qb() as any).selectFrom('users').orderBy('id').orderByRaw('LENGTH(name) DESC').toSQL())
      const matches = sql.match(/ORDER BY/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/ORDER BY id ASC, LENGTH\(name\) DESC/i)
    })

    it('reorder still wipes any prior ORDER BY (legacy behavior preserved)', () => {
      const sql = String((qb() as any).selectFrom('users').orderBy('id').reorder('name', 'desc').toSQL())
      expect(sql).toMatch(/ORDER BY name DESC$/i)
      expect(sql).not.toMatch(/id ASC/i)
    })
  })

  describe('limit / offset', () => {
    it('repeated limit() replaces the previous value (Laravel semantics)', () => {
      const sql = String((qb() as any).selectFrom('users').limit(5).limit(10).toSQL())
      const matches = sql.match(/LIMIT/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/LIMIT 10/)
    })

    it('repeated offset() replaces the previous value', () => {
      const sql = String((qb() as any).selectFrom('users').offset(20).offset(40).toSQL())
      const matches = sql.match(/OFFSET/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/OFFSET 40/)
    })

    it('limit + offset on a chain produces both clauses', () => {
      const sql = String((qb() as any).selectFrom('users').limit(10).offset(5).toSQL())
      expect(sql).toMatch(/LIMIT 10/)
      expect(sql).toMatch(/OFFSET 5/)
    })
  })

  describe('groupBy', () => {
    it('chains two groupBy calls into a single comma-separated clause', () => {
      const sql = String((qb() as any).selectFrom('users').groupBy('rating').groupBy('email').toSQL())
      const matches = sql.match(/GROUP BY/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/GROUP BY rating, email/i)
    })

    it('groupByRaw composes alongside groupBy', () => {
      const sql = String((qb() as any).selectFrom('users').groupBy('rating').groupByRaw('LENGTH(name)').toSQL())
      const matches = sql.match(/GROUP BY/gi) || []
      expect(matches.length).toBe(1)
      expect(sql).toMatch(/GROUP BY rating, LENGTH\(name\)/i)
    })
  })
})
