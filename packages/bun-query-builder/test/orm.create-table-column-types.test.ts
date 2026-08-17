/**
 * `createTableFromModel` must give a declared attribute type the same storage
 * type the migration path would. stacksjs/bun-query-builder#1094.
 *
 * It understood exactly two spellings — `number` and `boolean` — and sent
 * everything else to the `TEXT` default. So `type: 'integer'`, the spelling
 * used in this library's own docs and model examples, produced a TEXT column.
 *
 * Nothing errors when that happens. Integers store and read back as strings,
 * and under SQLite's text collation `'10' < '9'`, so `ORDER BY` and range
 * filters on an integer attribute return the wrong rows quietly. `WHERE n > 9`
 * returned zero rows where one was correct.
 *
 * The cross-path test below is the one that keeps this fixed: the bug was not
 * a wrong entry in a table, it was two tables that disagreed, so asserting the
 * ORM's output alone would let them drift apart again.
 */

import type { ColumnPlan } from '../src/migrations'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel } from '../src'
import { normalizeAttributeType, sqliteAffinityFor } from '../src/column-types'
import { SQLiteDriver } from '../src/drivers/sqlite'

let db: Database

beforeEach(() => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
})

afterEach(() => {
  clearModelRegistry()
})

/** Column name -> declared SQLite type, from the table the ORM actually built. */
async function columnTypesFor(attributes: Record<string, any>): Promise<Record<string, string>> {
  const M = createModel({
    name: 'Ctrow',
    table: 'ct_rows',
    primaryKey: 'id',
    autoIncrement: true,
    attributes,
  } as any)

  await createTableFromModel((M as any).getDefinition())

  const out: Record<string, string> = {}
  for (const c of db.query('PRAGMA table_info(ct_rows)').all() as any[]) {
    if (c.name !== 'id')
      out[c.name] = String(c.type)
  }
  return out
}

describe('createTableFromModel column types (#1094)', () => {
  it('maps every declared type to its storage type', async () => {
    const types = await columnTypesFor({
      a_string: { type: 'string', fillable: true },
      a_text: { type: 'text', fillable: true },
      a_integer: { type: 'integer', fillable: true },
      a_int: { type: 'int', fillable: true },
      a_number: { type: 'number', fillable: true },
      a_bigint: { type: 'bigint', fillable: true },
      a_float: { type: 'float', fillable: true },
      a_double: { type: 'double', fillable: true },
      a_decimal: { type: 'decimal', fillable: true },
      a_boolean: { type: 'boolean', fillable: true },
      a_bool: { type: 'bool', fillable: true },
      a_date: { type: 'date', fillable: true },
      a_datetime: { type: 'datetime', fillable: true },
      a_json: { type: 'json', fillable: true },
    })

    expect(types).toEqual({
      a_string: 'TEXT',
      a_text: 'TEXT',
      a_integer: 'INTEGER',
      a_int: 'INTEGER',
      // `number` is an integer by long-standing decision — see column-types.ts.
      a_number: 'INTEGER',
      a_bigint: 'INTEGER',
      a_float: 'REAL',
      a_double: 'REAL',
      a_decimal: 'REAL',
      a_boolean: 'INTEGER',
      a_bool: 'INTEGER',
      a_date: 'TEXT',
      a_datetime: 'TEXT',
      a_json: 'TEXT',
    })
  })

  it('agrees with the migration driver for every canonical type', () => {
    // The anti-drift check. #1094 was two mappings disagreeing, so pinning only
    // one of them would let the next divergence through.
    const driver = new SQLiteDriver()
    const canonical = [
      'string',
      'text',
      'boolean',
      'integer',
      'bigint',
      'float',
      'double',
      'decimal',
      'date',
      'datetime',
      'timestamptz',
      'json',
    ] as const

    for (const type of canonical) {
      const plan: ColumnPlan = {
        name: 'c',
        type,
        isPrimaryKey: false,
        isUnique: false,
        isNullable: true,
        hasDefault: false,
      }
      // `addColumn` renders `"c" <TYPE> ...`; take the type it chose.
      const rendered = driver.addColumn('t', plan)
      const driverType = rendered.match(/"c"\s+(TEXT|INTEGER|REAL)/)?.[1]

      expect(driverType, `driver type for ${type}`).toBeDefined()
      expect(sqliteAffinityFor(type), `shared mapping disagrees with driver for '${type}'`).toBe(driverType as any)
    }
  })

  it('stores an integer attribute as a number, so comparisons are numeric', async () => {
    const M = createModel({
      name: 'Ctnum',
      table: 'ct_nums',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true }, n: { type: 'integer', fillable: true } },
    } as any)
    await createTableFromModel((M as any).getDefinition())

    await (M as any).create({ name: 'nine', n: 9 })
    await (M as any).create({ name: 'ten', n: 10 })

    // Under TEXT affinity this returned [] — '10' sorts before '9'.
    const gt = db.query('SELECT name FROM ct_nums WHERE n > 9').all() as any[]
    expect(gt.map(r => r.name)).toEqual(['ten'])

    const [{ t }] = db.query('SELECT typeof(n) t FROM ct_nums LIMIT 1').all() as any[]
    expect(t).toBe('integer')
  })

  describe('the *_id naming heuristic', () => {
    it('keeps a numeric id as INTEGER', async () => {
      const types = await columnTypesFor({ owner_id: { type: 'integer', fillable: true } })
      expect(types.owner_id).toBe('INTEGER')
    })

    it('does not coerce an id that is declared text', async () => {
      // External ids are frequently strings — tickers, wallet addresses,
      // hashes. A declared type has to beat a name heuristic, and the
      // migration path already worked this way.
      const types = await columnTypesFor({ ticker_id: { type: 'string', fillable: true } })
      expect(types.ticker_id).toBe('TEXT')
    })

    it('still defaults an id with no declared type to INTEGER', async () => {
      const types = await columnTypesFor({ legacy_id: { fillable: true } })
      expect(types.legacy_id).toBe('INTEGER')
    })
  })
})

describe('normalizeAttributeType (#1094)', () => {
  it('accepts the short spellings alongside the long ones', () => {
    expect(normalizeAttributeType('int')).toBe('integer')
    expect(normalizeAttributeType('bool')).toBe('boolean')
    expect(normalizeAttributeType('timestamp')).toBe('datetime')
    expect(normalizeAttributeType('INTEGER')).toBe('integer')
  })

  it('returns undefined for anything it does not recognise', () => {
    // Callers treat this as "no opinion" and fall back, rather than guessing.
    expect(normalizeAttributeType('wat')).toBeUndefined()
    expect(normalizeAttributeType(undefined)).toBeUndefined()
    expect(normalizeAttributeType(42)).toBeUndefined()
  })
})
