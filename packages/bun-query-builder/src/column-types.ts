/**
 * The one place a declared attribute type becomes a storage type.
 *
 * Two paths build SQLite columns from a model and they disagreed:
 *
 *  - the migration path (`SQLiteDriver.getColumnType`) understands the full
 *    canonical set — integer, bigint, float, double, decimal, date, json, …
 *  - `createTableFromModel` in orm.ts understood exactly two, `number` and
 *    `boolean`, and sent everything else to the `TEXT` default.
 *
 * So `type: 'integer'` — the spelling used in this library's own docs and model
 * examples — produced a TEXT column. Integers then stored and read back as
 * strings, and under SQLite's text collation `'10' < '9'`, so `ORDER BY` and
 * range filters on an integer attribute returned the wrong rows with no error
 * anywhere. See stacksjs/bun-query-builder#1094.
 *
 * A shared mapping is the fix rather than a second copy of the switch, because
 * a second copy is what produced the divergence in the first place.
 *
 * This module is a leaf: it imports only types, so either path can use it
 * without a runtime cycle.
 */

import type { NormalizedColumnType } from './migrations'

/**
 * Whether a canonical type stores a number.
 *
 * Used to decide when the `*_id` naming heuristic may coerce a column to
 * INTEGER. Declared text types must never be coerced by a name heuristic —
 * external ids are frequently strings (tickers, wallet addresses, hashes).
 */
export function isNumericPlanType(type: string | undefined): boolean {
  return type === 'integer' || type === 'bigint' || type === 'float' || type === 'double' || type === 'decimal'
}

/**
 * Map a declared attribute type onto the canonical set.
 *
 * Accepts the spellings the model layer and the validation-rule reader already
 * accept, so `type: 'int'`, `'bool'` and `'timestamp'` land where their long
 * forms do. Returns `undefined` for anything unrecognised, which callers treat
 * as "no opinion" rather than guessing.
 */
export function normalizeAttributeType(raw: unknown): NormalizedColumnType | undefined {
  if (typeof raw !== 'string')
    return undefined

  switch (raw.toLowerCase()) {
    case 'string': return 'string'
    case 'text': return 'text'
    case 'integer':
    case 'int': return 'integer'
    // `number` is an integer here, deliberately, and for the reason spelled out
    // at the rule-based normalizer in migrations.ts: it is what nearly every
    // count, coordinate, port and foreign key is declared as. Reading it as
    // `decimal` was tried and reverted (cdd35a3, 3ba6dd2) because it reshaped
    // every such column. Both paths have to agree on this or a model migrates
    // into one column type and is created as another.
    case 'number': return 'integer'
    case 'bigint': return 'bigint'
    case 'float': return 'float'
    case 'double': return 'double'
    case 'decimal': return 'decimal'
    case 'boolean':
    case 'bool': return 'boolean'
    case 'date': return 'date'
    case 'datetime':
    case 'timestamp': return 'datetime'
    case 'timestamptz':
    case 'timestamp_tz': return 'timestamptz'
    case 'json': return 'json'
    case 'enum': return 'enum'
    default: return undefined
  }
}

/**
 * The SQLite storage class for a canonical type.
 *
 * `enum` is TEXT here; the migration driver additionally emits a CHECK
 * constraint, which needs the column name and a quoter and so stays with the
 * driver.
 */
export function sqliteAffinityFor(type: NormalizedColumnType | undefined): 'TEXT' | 'INTEGER' | 'REAL' {
  switch (type) {
    case 'boolean': // SQLite stores booleans as 0/1
    case 'integer':
    case 'bigint':
      return 'INTEGER'
    case 'float':
    case 'double':
    case 'decimal':
      return 'REAL'
    default:
      return 'TEXT'
  }
}
