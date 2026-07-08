import type { TablePlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { isMysqlLike } from '../src/config'
import { getDialectDriver, MySQLDriver, SingleStoreDriver } from '../src/drivers'
import { buildMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

describe('singlestore dialect', () => {
  it('isMysqlLike treats mysql + singlestore as the MySQL family', () => {
    expect(isMysqlLike('mysql')).toBe(true)
    expect(isMysqlLike('singlestore')).toBe(true)
    expect(isMysqlLike('postgres')).toBe(false)
    expect(isMysqlLike('sqlite')).toBe(false)
  })

  it('dispatches singlestore to the SingleStoreDriver', () => {
    const driver = getDialectDriver('singlestore')
    expect(driver).toBeInstanceOf(SingleStoreDriver)
    // It is a MySQL-family driver (shares wire behavior).
    expect(driver).toBeInstanceOf(MySQLDriver)
  })

  const models = defineModels({
    PageView: {
      name: 'PageView',
      table: 'pageviews',
      primaryKey: 'id',
      shardKey: ['site_id'],
      sortKey: ['timestamp'],
      tableKind: 'columnstore',
      attributes: {
        id: { validation: { rule: {} } },
        site_id: { validation: { rule: {} } },
        path: { validation: { rule: {} } },
        timestamp: { validation: { rule: {} } },
      },
    },
  })

  function pageviewPlan(): TablePlan {
    const plan = buildMigrationPlan(models, { dialect: 'singlestore' } as any)
    return plan.tables.find(t => t.table === 'pageviews')!
  }

  it('carries shard/sort/kind metadata from the model into the TablePlan', () => {
    const table = pageviewPlan()
    expect(table.shardKey).toEqual(['site_id'])
    expect(table.sortKey).toEqual(['timestamp'])
    expect(table.tableKind).toBe('columnstore')
  })

  it('emits SHARD KEY and SORT KEY in CREATE TABLE', () => {
    const sql = new SingleStoreDriver().createTable(pageviewPlan())
    expect(sql).toContain('SHARD KEY (`site_id`)')
    expect(sql).toContain('SORT KEY (`timestamp`)')
    expect(sql).toContain('`pageviews`')
  })

  it('defaults the shard key to the primary key when none is declared', () => {
    const table: TablePlan = {
      table: 'sessions',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'visitor_id', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
      ],
      indexes: [],
    }
    const sql = new SingleStoreDriver().createTable(table)
    expect(sql).toContain('SHARD KEY (`id`)')
  })

  it('emits a REFERENCE table with no shard/sort key', () => {
    const table: TablePlan = {
      table: 'sites',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'domain', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
      ],
      indexes: [],
      tableKind: 'reference',
    }
    const sql = new SingleStoreDriver().createTable(table)
    expect(sql).toContain('REFERENCE TABLE')
    expect(sql).not.toContain('SHARD KEY')
    expect(sql).not.toContain('SORT KEY')
  })

  it('emits ROWSTORE without a SORT KEY', () => {
    const table: TablePlan = {
      table: 'realtime',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
      ],
      indexes: [],
      tableKind: 'rowstore',
    }
    const sql = new SingleStoreDriver().createTable(table)
    expect(sql).toContain('ROWSTORE TABLE')
    expect(sql).toContain('SHARD KEY (`id`)')
    expect(sql).not.toContain('SORT KEY')
  })

  it('drops foreign keys (SingleStore does not support them)', () => {
    expect(new SingleStoreDriver().addForeignKey()).toBe('')
  })

  it('rejects partial indexes like MySQL', () => {
    expect(() =>
      new SingleStoreDriver().createIndex('pageviews', {
        name: 'partial',
        columns: ['site_id'],
        type: 'index',
        where: 'site_id IS NOT NULL',
      }),
    ).toThrow(/not supported on SingleStore/)
  })
})
