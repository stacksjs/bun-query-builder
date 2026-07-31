import { describe, expect, it } from 'bun:test'
import { MySQLDriver } from '../src/drivers/mysql'
import { PostgresDriver } from '../src/drivers/postgres'
import { SQLiteDriver } from '../src/drivers/sqlite'

describe('migration index names', () => {
  const drivers = [
    ['sqlite', new SQLiteDriver()],
    ['mysql', new MySQLDriver()],
    ['postgres', new PostgresDriver()],
  ] as const

  for (const [dialect, driver] of drivers) {
    it(`${dialect} prefixes short names exactly once`, () => {
      const sql = driver.createIndex('users', {
        name: 'email_unique',
        columns: ['email'],
        type: 'unique',
      })
      expect(sql).toContain('users_email_unique')
      expect(sql).not.toContain('users_users_email_unique')
    })

    it(`${dialect} preserves already-qualified names`, () => {
      const sql = driver.createIndex('users', {
        name: 'users_email_unique',
        columns: ['email'],
        type: 'unique',
      })
      expect(sql).toContain('users_email_unique')
      expect(sql).not.toContain('users_users_email_unique')
      expect(driver.dropIndex('users', 'users_email_unique')).toContain('users_email_unique')
      expect(driver.dropIndex('users', 'users_email_unique')).not.toContain('users_users_email_unique')
    })
  }
})
