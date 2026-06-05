/**
 * Coverage for reverse DB introspection / codegen (stacksjs/bun-query-builder#1047).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'
import { generateModelSource, introspectDatabase, modelNameForTable, sqlTypeToAttr } from '../src/actions/introspect-db'
import { config, defaultConfig } from '../src/config'
import { resetConnection } from '../src/db'

describe('introspect codegen helpers (#1047)', () => {
  it('maps SQL types to attribute types', () => {
    expect(sqlTypeToAttr('integer')).toBe('number')
    expect(sqlTypeToAttr('bigserial')).toBe('number')
    expect(sqlTypeToAttr('numeric(10,2)')).toBe('number')
    expect(sqlTypeToAttr('tinyint(1)')).toBe('boolean')
    expect(sqlTypeToAttr('boolean')).toBe('boolean')
    expect(sqlTypeToAttr('timestamp')).toBe('datetime')
    expect(sqlTypeToAttr('jsonb')).toBe('json')
    expect(sqlTypeToAttr('varchar(255)')).toBe('string')
  })

  it('derives a PascalCase singular model name', () => {
    expect(modelNameForTable('users')).toBe('User')
    expect(modelNameForTable('blog_posts')).toBe('BlogPost')
    expect(modelNameForTable('categories')).toBe('Category')
  })

  it('generates defineModel source with pk + attributes', () => {
    const src = generateModelSource('users', [
      { name: 'id', sqlType: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'email', sqlType: 'varchar(255)', nullable: false, isPrimaryKey: false },
      { name: 'bio', sqlType: 'text', nullable: true, isPrimaryKey: false },
    ])
    expect(src).toContain('export const User = defineModel({')
    expect(src).toContain(`table: 'users'`)
    expect(src).toContain(`primaryKey: 'id'`)
    expect(src).toContain(`email: { type: 'string', required: true }`)
    expect(src).toContain(`bio: { type: 'string' }`) // nullable => no required
  })
})

describe('introspectDatabase against live sqlite (#1047)', () => {
  let dir: string
  let saved: Record<string, any>
  beforeEach(async () => {
    saved = { ...config }
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    dir = mkdtempSync(join(tmpdir(), 'qb-intro-'))
    config.dialect = 'sqlite' as any
    config.database.database = join(dir, 't.db')
    resetConnection()
    const db = createQueryBuilder() as any
    await db.unsafe('CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER, active BOOLEAN)')
  })
  afterEach(() => {
    for (const k of Object.keys(config)) delete (config as any)[k]
    Object.assign(config, saved)
    resetConnection()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a real table and generates a model', async () => {
    const models = await introspectDatabase({ tables: ['widgets'] })
    expect(models.length).toBe(1)
    const m = models[0]
    expect(m.modelName).toBe('Widget')
    expect(m.primaryKey).toBe('id')
    expect(m.columns.map(c => c.name)).toEqual(['id', 'label', 'qty', 'active'])
    expect(m.source).toContain('export const Widget = defineModel({')
    expect(m.source).toContain(`label: { type: 'string', required: true }`)
    expect(m.source).toContain(`qty: { type: 'number' }`)
    expect(m.source).toContain(`active: { type: 'boolean' }`)
  })
})
