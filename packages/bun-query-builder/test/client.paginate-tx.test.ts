/**
 * Coverage for snapshot-consistent pagination (stacksjs/bun-query-builder#1051):
 * paginate(perPage, page, { tx }) routes BOTH the count and the page-data
 * through the caller's transaction handle.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config, defaultConfig } from '../src/config'
import { resetConnection } from '../src/db'

function qb() {
  const models = { users: { columns: { id: { type: 'integer', isPrimaryKey: true }, active: { type: 'integer' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('paginate({ tx }) snapshot consistency (#1051)', () => {
  it('routes count + page-data through the provided tx handle', async () => {
    const calls: string[] = []
    const tx = {
      unsafe: (sql: string) => {
        calls.push(sql)
        return sql.includes('COUNT(*)') ? [{ c: 42 }] : [{ id: 11 }, { id: 12 }]
      },
    }
    const res = await (qb() as any).selectFrom('users').where({ active: 1 }).paginate(10, 2, { tx })
    expect(calls.length).toBe(2)
    expect(calls[0]).toContain('SELECT COUNT(*)')
    expect(calls[1]).toContain('LIMIT 10 OFFSET 10') // page 2
    expect(res.meta).toEqual({ perPage: 10, page: 2, total: 42, lastPage: 5 })
    expect(res.data.length).toBe(2)
  })

  describe('against real sqlite', () => {
    let dir: string
    let saved: Record<string, any>
    beforeEach(async () => {
      saved = { ...config }
      Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
      dir = mkdtempSync(join(tmpdir(), 'qb-pgtx-'))
      config.dialect = 'sqlite' as any
      config.database.database = join(dir, 't.db')
      resetConnection()
      const db = createQueryBuilder() as any
      await db.unsafe('CREATE TABLE users (id INTEGER PRIMARY KEY, active INTEGER)')
      await db.unsafe('INSERT INTO users (id, active) VALUES (1,1),(2,1),(3,1),(4,0),(5,1)')
    })
    afterEach(() => {
      for (const k of Object.keys(config)) delete (config as any)[k]
      Object.assign(config, saved)
      resetConnection()
      rmSync(dir, { recursive: true, force: true })
    })

    it('computes total + page correctly through a real connection handle', async () => {
      const db = createQueryBuilder() as any
      const tx = { unsafe: (s: string, p?: any[]) => db.unsafe(s, p) }
      const res = await db.selectFrom('users').where({ active: 1 }).paginate(2, 1, { tx })
      expect(res.meta.total).toBe(4) // 4 active users
      expect(res.meta.lastPage).toBe(2)
      expect(res.data.length).toBe(2)
    })
  })
})
