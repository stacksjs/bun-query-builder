import type { TablePlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { isMysqlLike } from '../src/config'
import { config, setConfig } from '../src/config'
import { getDialectDriver, MySQLDriver, VitessDriver } from '../src/drivers'

describe('vitess dialect', () => {
  it('isMysqlLike treats vitess as the MySQL family', () => {
    // Vitess is reached through vtgate, which parses MySQL, so every runtime
    // DML branch (placeholders, backtick quoting, ON DUPLICATE KEY UPDATE,
    // LAST_INSERT_ID) must take the MySQL path.
    expect(isMysqlLike('vitess')).toBe(true)
    expect(isMysqlLike('mysql')).toBe(true)
    expect(isMysqlLike('singlestore')).toBe(true)
    expect(isMysqlLike('postgres')).toBe(false)
    expect(isMysqlLike('sqlite')).toBe(false)
  })

  it('dispatches vitess to the VitessDriver', () => {
    const driver = getDialectDriver('vitess')
    expect(driver).toBeInstanceOf(VitessDriver)
    // It is a MySQL-family driver — it inherits the wire behavior and
    // overrides only the DDL a sharded keyspace rejects.
    expect(driver).toBeInstanceOf(MySQLDriver)
  })

  it('selects the unsharded DDL profile from config', () => {
    const previous = config.vitess?.sharded ?? true
    try {
      setConfig({ vitess: { sharded: false } })
      const sql = getDialectDriver('vitess').createTable(plan([pk]))
      expect(sql.toLowerCase()).toContain('auto_increment')
    }
    finally {
      setConfig({ vitess: { sharded: previous } })
    }
  })

  function plan(columns: TablePlan['columns']): TablePlan {
    return { table: 'posts', columns, indexes: [] }
  }

  const pk: TablePlan['columns'][number] = {
    name: 'id',
    type: 'bigint',
    isPrimaryKey: true,
    isUnique: false,
    isNullable: false,
    hasDefault: false,
  }

  describe('no AUTO_INCREMENT', () => {
    it('omits the clause on an integer primary key', () => {
      // Not a parse error on Vitess, which makes it worse than one: the DDL
      // would succeed and every shard would then hand out the same values,
      // surfacing later as duplicate-key failures under load.
      const sql = new VitessDriver().createTable(plan([pk]))
      expect(sql.toLowerCase()).not.toContain('auto_increment')
      expect(sql).toContain('PRIMARY KEY')
      expect(sql).toContain('`posts`')
    })

    it('is exactly where MySQL differs', () => {
      // Pins the divergence: same plan, same driver family, one clause apart.
      const mysql = new MySQLDriver().createTable(plan([pk]))
      expect(mysql.toLowerCase()).toContain('auto_increment')
    })

    it('omits it from addColumn too', () => {
      // addColumn asks the same helper, so overriding getAutoIncrementClause
      // rather than renderColumn covers both paths.
      const sql = new VitessDriver().addColumn('posts', pk)
      expect(sql.toLowerCase()).not.toContain('auto_increment')
    })
  })

  describe('no foreign keys', () => {
    it('suppresses the ALTER TABLE ADD CONSTRAINT form', () => {
      expect(new VitessDriver().addForeignKey()).toBe('')
    })

    it('suppresses the inline REFERENCES clause in a column definition', () => {
      // The subtler of the two: the plan carries the reference on the column,
      // so CREATE TABLE would emit an inline foreign key and fail on its own
      // without any addForeignKey statement being generated.
      const withRef: TablePlan['columns'][number] = {
        name: 'user_id',
        type: 'bigint',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        hasDefault: false,
        references: { table: 'users', column: 'id', onDelete: 'cascade' },
      } as any

      const sql = new VitessDriver().createTable(plan([pk, withRef]))
      expect(sql).not.toContain('REFERENCES')
      expect(sql).not.toContain('ON DELETE')
      // The column itself survives — only the constraint is dropped.
      expect(sql).toContain('`user_id`')
    })

    it('is exactly where MySQL differs', () => {
      const withRef: any = {
        name: 'user_id',
        type: 'bigint',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        hasDefault: false,
        references: { table: 'users', column: 'id' },
      }
      expect(new MySQLDriver().createTable(plan([pk, withRef]))).toContain('REFERENCES')
    })

    it('leaves columns without a reference untouched', () => {
      const plainCol: any = {
        name: 'title',
        type: 'string',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        hasDefault: false,
      }
      const sql = new VitessDriver().createTable(plan([pk, plainCol]))
      expect(sql).toContain('`title`')
      expect(sql).toContain('not null')
    })
  })

  describe('unsharded keyspace', () => {
    it('keeps MySQL AUTO_INCREMENT and inline foreign keys', () => {
      const withRef: any = {
        name: 'user_id',
        type: 'bigint',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        hasDefault: false,
        references: { table: 'users', column: 'id' },
      }
      const sql = new VitessDriver(false).createTable(plan([pk, withRef]))
      expect(sql.toLowerCase()).toContain('auto_increment')
      expect(sql).toContain('REFERENCES')
    })

    it('uses the ordinary MySQL migrations ledger', () => {
      const sql = new VitessDriver(false).createMigrationsTable()
      expect(sql.toLowerCase()).toContain('auto_increment')
    })
  })

  describe('sharding lives in the VSchema, not the DDL', () => {
    it('emits no SHARD KEY, unlike SingleStore', () => {
      // The key architectural difference between the two distributed
      // dialects: SingleStore puts the shard key in CREATE TABLE, Vitess
      // keeps the topology in a separate VSchema document.
      const sql = new VitessDriver().createTable(plan([pk]))
      expect(sql).not.toContain('SHARD KEY')
      expect(sql).not.toContain('SORT KEY')
    })
  })

  describe('migrations ledger', () => {
    it('uses the migration name as the key rather than a sequence', () => {
      const sql = new VitessDriver().createMigrationsTable()
      expect(sql.toLowerCase()).not.toContain('auto_increment')
      expect(sql).toContain('migration VARCHAR(255) NOT NULL PRIMARY KEY')
    })

    it('keeps the ledger queries the base driver already issues working', () => {
      const driver = new VitessDriver()
      // Neither query touches `id`, which is what makes dropping the
      // surrogate key safe.
      expect(driver.getExecutedMigrationsQuery()).not.toContain('id')
      expect(driver.recordMigrationQuery()).not.toContain('id')
    })
  })

  describe('inherited MySQL behavior', () => {
    it('quotes identifiers with backticks', () => {
      expect(new VitessDriver().createTable(plan([pk]))).toContain('`posts`')
    })

    it('still rejects partial indexes, as MySQL does', () => {
      expect(() =>
        new VitessDriver().createIndex('posts', {
          name: 'idx',
          columns: ['title'],
          where: 'title IS NOT NULL',
        } as any),
      ).toThrow(/Partial indexes/)
    })
  })
})
