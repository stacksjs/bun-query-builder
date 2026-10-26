import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { MigrationPlan } from '../src/migrations'
import { generateDiffOperations, generateSqlFiles } from '../src/migrations'

const plan = (values: string[]): MigrationPlan => ({ dialect: 'sqlite', tables: [{ table: 'preferences', indexes: [], columns: [
  { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
  { name: 'key', type: 'enum', enumValues: values, isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
] }] })

test('SQLite rebuilds compose with an outer transaction and roll back together with caller metadata', () => {
  const previous = plan(['appearance', 'history'])
  const next = plan(['appearance', 'history', 'usage'])
  const db = new Database(':memory:')
  try {
    for (const sql of generateSqlFiles(previous).statements) db.exec(sql)
    db.exec("INSERT INTO preferences (key) VALUES ('appearance'); CREATE TABLE snapshot (version INTEGER); INSERT INTO snapshot VALUES (1);")
    const diff = generateDiffOperations(previous, next, { externalTransaction: true })
    expect(diff.operations.some(operation => operation.kind === 'rebuild_table')).toBe(true)
    expect(diff.statements.join('\n')).not.toMatch(/\b(?:BEGIN|COMMIT|PRAGMA)\b/)
    db.exec('PRAGMA foreign_keys=OFF')
    expect(() => db.transaction(() => {
      for (const sql of diff.statements) db.exec(sql)
      db.exec('UPDATE snapshot SET version = 2')
      throw new Error('abort the complete migration')
    }).immediate()).toThrow('abort the complete migration')
    expect(db.query('SELECT version FROM snapshot').get()).toEqual({ version: 1 })
    expect(db.query('SELECT key FROM preferences').get()).toEqual({ key: 'appearance' })
    expect(() => db.exec("INSERT INTO preferences (key) VALUES ('usage')")).toThrow()
    db.transaction(() => {
      for (const sql of diff.statements) db.exec(sql)
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
      db.exec('UPDATE snapshot SET version = 2')
    }).immediate()
    db.exec('PRAGMA foreign_keys=ON')
    db.exec("INSERT INTO preferences (key) VALUES ('usage')")
    expect(db.query('SELECT count(*) AS count FROM preferences').get()).toEqual({ count: 2 })
    expect(db.query('SELECT version FROM snapshot').get()).toEqual({ version: 2 })
  }
  finally { db.close() }
})

test('standalone SQLite rebuilds retain their own transaction by default', () => {
  const sql = generateDiffOperations(plan(['a']), plan(['a', 'b'])).statements.join('\n')
  expect(sql).toContain('PRAGMA foreign_keys=OFF;')
  expect(sql).toContain('BEGIN;')
  expect(sql).toContain('COMMIT;')
})
