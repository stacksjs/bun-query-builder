import type { ColumnPlan, IndexPlan, RebuildTableSpec, TablePlan } from '../migrations'
import type { DateBucketGrain } from './postgres'
import { isNumericPlanType, sqliteAffinityFor } from '../column-types'
import { qualifiedIndexName } from './index-name'

/**
 * Whether a plan type belongs to the numeric family. Used by the `_id`
 * safety net (numeric ids must store as INTEGER on SQLite) — non-numeric
 * declared types must never be coerced by the name heuristic.
 *
 * Defined in column-types.ts now, so the ORM's create-table path applies the
 * same rule from the same source. Re-exported because this is where callers
 * already import it from.
 */
export { isNumericPlanType }

export interface DialectDriver {
  createEnumType: (enumTypeName: string, values: string[]) => string
  createTable: (table: TablePlan) => string
  createIndex: (tableName: string, index: IndexPlan) => string
  addForeignKey: (tableName: string, columnName: string, refTable: string, refColumn: string, onDelete?: string, onUpdate?: string) => string
  addColumn: (tableName: string, column: ColumnPlan) => string
  modifyColumn: (tableName: string, column: ColumnPlan) => string
  /** Rename a column in place (SQLite 3.25+, MySQL 8.0+, Postgres). */
  renameColumn: (tableName: string, from: string, to: string) => string
  /** Rename a table. */
  renameTable: (from: string, to: string) => string
  /**
   * Recreate a table with a new schema, preserving data. Only SQLite needs
   * this (it can't ALTER COLUMN types or DROP constrained columns); the
   * MySQL/Postgres drivers throw since they do those changes in place.
   */
  rebuildTable: (spec: RebuildTableSpec) => string
  dropTable: (tableName: string) => string
  dropColumn: (tableName: string, columnName: string) => string
  dropIndex: (tableName: string, indexName: string) => string
  dropEnumType: (enumTypeName: string) => string
  createMigrationsTable: () => string
  getExecutedMigrationsQuery: () => string
  recordMigrationQuery: () => string
}

export class SQLiteDriver implements DialectDriver {
  private quoteIdentifier(id: string): string {
    // Escape double quotes by doubling them, then wrap in quotes
    // This prevents SQL injection through identifier names
    return `"${id.replace(/"/g, '""')}"`
  }

  private getColumnType(column: ColumnPlan): string {
    // Safety net: numeric foreign-key columns (ending in _id) are stored as
    // INTEGER so float storage can't corrupt ids (11.0 instead of 11). Only
    // numeric plan types are coerced — external ids are frequently strings
    // (tickers, wallet addresses, hashes) and a declared text type must win.
    if (column.name.endsWith('_id') && isNumericPlanType(column.type)) {
      return 'INTEGER'
    }

    // An enum is TEXT plus a CHECK, which needs the column name and a quoter,
    // so it stays here. Every other type comes from the shared mapping — this
    // path and the ORM's create-table path drifting apart is #1094.
    if (column.type === 'enum') {
      if (column.enumValues && column.enumValues.length > 0) {
        const enumValues = column.enumValues.map(v => `'${v.replace(/'/g, '\'\'')}'`).join(', ')
        return `TEXT CHECK (${this.quoteIdentifier(column.name)} IN (${enumValues}))`
      }
      return 'TEXT'
    }

    return sqliteAffinityFor(column.type)
  }

  private getPrimaryKeyType(column: ColumnPlan): string {
    return this.getColumnType(column)
  }

  private getAutoIncrementClause(column: ColumnPlan): string {
    if (column.isPrimaryKey && (column.type === 'integer' || column.type === 'bigint')) {
      return 'AUTOINCREMENT'
    }
    return ''
  }

  private getDefaultValue(column: ColumnPlan): string {
    if (!column.hasDefault || column.defaultValue === undefined) {
      return ''
    }

    const dv = column.defaultValue
    if (typeof dv === 'string') {
      // Handle SQL functions like CURRENT_TIMESTAMP - don't quote them
      const sqlFunctions = ['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'NOW()', 'NULL', 'TRUE', 'FALSE']
      if (sqlFunctions.includes(dv.toUpperCase())) {
        return `default ${dv.toUpperCase()}`
      }
      return `default '${dv.replace(/'/g, '\'\'')}'`
    }
    else if (typeof dv === 'number' || typeof dv === 'bigint') {
      return `default ${dv}`
    }
    else if (typeof dv === 'boolean') {
      return `default ${dv ? 1 : 0}`
    }
    else if (dv instanceof Date) {
      return `default '${dv.toISOString()}'`
    }
    return ''
  }

  createEnumType(_enumTypeName: string, _values: string[]): string {
    // SQLite doesn't support CREATE TYPE, enums are handled inline with CHECK constraints
    return ''
  }

  createTable(table: TablePlan): string {
    const columns = table.columns.map(c => this.renderColumn(c)).join(',\n  ')
    return `CREATE TABLE IF NOT EXISTS ${this.quoteIdentifier(table.table)} (\n  ${columns}\n);`
  }

  createIndex(tableName: string, index: IndexPlan): string {
    const kind = index.type === 'unique' ? 'UNIQUE ' : ''
    const idxName = qualifiedIndexName(tableName, index.name)
    const columns = index.columns.map(c => this.quoteIdentifier(c)).join(', ')
    const where = index.where ? ` WHERE ${index.where}` : ''
    return `CREATE ${kind}INDEX IF NOT EXISTS ${this.quoteIdentifier(idxName)} ON ${this.quoteIdentifier(tableName)} (${columns})${where};`
  }

  addForeignKey(_tableName: string, _columnName: string, _refTable: string, _refColumn: string, _onDelete?: string, _onUpdate?: string): string {
    // SQLite doesn't support `ALTER TABLE … ADD CONSTRAINT FOREIGN
    // KEY` — it can only declare FKs inline on `CREATE TABLE`, which
    // `renderColumn` already does. Return an empty string so the
    // orchestrator (`generateSql` / `generateDiffSql`) skips emitting
    // an unrunnable ALTER migration file for SQLite.
    //
    // Consumers that previously stripped these files from disk after
    // generation (e.g. stacksjs/stacks#1916) can drop that workaround.
    return ''
  }

  addColumn(tableName: string, column: ColumnPlan): string {
    const typeSql = this.getColumnType(column)
    const parts: string[] = [this.quoteIdentifier(column.name), typeSql]

    if (!column.isNullable && !column.isPrimaryKey) {
      parts.push('not null')
    }

    const defaultValue = this.getDefaultValue(column)
    if (defaultValue) {
      parts.push(defaultValue)
    }

    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${parts.join(' ')};`
  }

  modifyColumn(tableName: string, column: ColumnPlan): string {
    // SQLite can't ALTER COLUMN to change a type/constraint — the diff engine
    // routes such changes through `rebuildTable` instead. This path only
    // remains as a defensive fallback (e.g. if a caller invokes it directly).
    return `-- SQLite does not support ALTER COLUMN; a table rebuild is required to change ${this.quoteIdentifier(tableName)}.${this.quoteIdentifier(column.name)}`
  }

  renameColumn(tableName: string, from: string, to: string): string {
    // RENAME COLUMN is supported since SQLite 3.25.0 (Stacks requires >= 3.47.2).
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} RENAME COLUMN ${this.quoteIdentifier(from)} TO ${this.quoteIdentifier(to)};`
  }

  renameTable(from: string, to: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(from)} RENAME TO ${this.quoteIdentifier(to)};`
  }

  /**
   * SQLite's recommended table-recreate procedure (sqlite.org/lang_altertable
   * §"Making Other Kinds Of Table Schema Changes"). Used whenever a column's
   * type/constraint changes or a constrained column is dropped — operations
   * SQLite can't do in place. Data is preserved by copying mapped columns into
   * a freshly-built table and swapping it into place.
   *
   * The `PRAGMA foreign_keys` toggles MUST sit OUTSIDE the transaction — SQLite
   * ignores the pragma inside one. The whole string is executed statement-by-
   * statement by the migration runner (`db.ts` splits on `;`).
   */
  rebuildTable(spec: RebuildTableSpec): string {
    const { target, tempName, columnSource } = spec
    const q = (id: string): string => this.quoteIdentifier(id)

    const columnsSql = target.columns.map(c => this.renderColumn(c)).join(',\n  ')
    const createTmp = `CREATE TABLE ${q(tempName)} (\n  ${columnsSql}\n);`

    // Only carry over target columns that have a known source (carried/renamed).
    // Brand-new columns are omitted so they pick up their DEFAULT/NULL.
    const carried = target.columns
      .map(c => c.name)
      .filter(name => columnSource[name] !== undefined)

    const statements: string[] = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN;',
      createTmp,
    ]

    if (carried.length > 0) {
      const insertCols = carried.map(q).join(', ')
      const selectCols = carried.map(name => q(columnSource[name])).join(', ')
      statements.push(`INSERT INTO ${q(tempName)} (${insertCols}) SELECT ${selectCols} FROM ${q(target.table)};`)
    }

    statements.push(`DROP TABLE ${q(target.table)};`)
    statements.push(`ALTER TABLE ${q(tempName)} RENAME TO ${q(target.table)};`)

    // Indexes are dropped with the old table; recreate them from the target plan.
    for (const idx of target.indexes)
      statements.push(this.createIndex(target.table, idx))

    statements.push('PRAGMA foreign_key_check;')
    statements.push('COMMIT;')
    statements.push('PRAGMA foreign_keys=ON;')

    return statements.join('\n')
  }

  dropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`
  }

  dropColumn(tableName: string, columnName: string): string {
    // SQLite supports DROP COLUMN since 3.35.0, but has many limitations:
    // - Cannot drop PRIMARY KEY columns
    // - Cannot drop columns with UNIQUE constraints
    // - Cannot drop indexed columns
    // - Cannot drop columns used in foreign keys, triggers, views, or CHECK constraints
    // If the drop fails, you may need to manually recreate the table
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)};`
  }

  dropIndex(tableName: string, indexName: string): string {
    const fullIndexName = qualifiedIndexName(tableName, indexName)
    return `DROP INDEX IF EXISTS ${this.quoteIdentifier(fullIndexName)};`
  }

  dropEnumType(_enumTypeName: string): string {
    // SQLite doesn't support DROP TYPE for enums
    return ''
  }

  createMigrationsTable(): string {
    return `CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      migration TEXT NOT NULL UNIQUE,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  }

  getExecutedMigrationsQuery(): string {
    return 'SELECT migration, executed_at FROM migrations ORDER BY executed_at'
  }

  recordMigrationQuery(): string {
    return 'INSERT INTO migrations (migration) VALUES (?)'
  }

  /**
   * `json_extract` returns a scalar for a scalar, matching what Postgres `->>`
   * yields, so both dialects hand a caller the same kind of value.
   *
   * The `'$.' || key` concatenation is what lets the key be a bound parameter
   * for the caller that can bind one. Note that SQLite will NOT accept a bound
   * parameter as a whole path, which is why the interface documents that a
   * caller interpolating a key must validate it first.
   */
  jsonExtract(column: string, key: string): string {
    return `json_extract(${column}, '$.' || ${key})`
  }

  dateBucket(column: string, grain: DateBucketGrain, offsetHours = 0): string {
    const shifted = offsetHours === 0
      ? column
      : `datetime(${column}, '${offsetHours >= 0 ? '+' : '-'}${Math.abs(offsetHours)} hours')`

    switch (grain) {
      case 'hour':
        return `strftime('%Y-%m-%dT%H:00:00.000Z', ${shifted})`
      case 'week':
        // SQLite weeks start on Sunday. Walking back six days and then forward
        // to the next Monday lands on the Monday of the current week, which is
        // what date_trunc('week') gives on Postgres.
        return `strftime('%Y-%m-%dT00:00:00.000Z', ${shifted}, '-6 days', 'weekday 1')`
      case 'month':
        return `strftime('%Y-%m-01T00:00:00.000Z', ${shifted})`
      case 'year':
        return `strftime('%Y-01-01T00:00:00.000Z', ${shifted})`
      case 'day':
      default:
        return `strftime('%Y-%m-%dT00:00:00.000Z', ${shifted})`
    }
  }

  /**
   * SQLite has understood the `TRUE` and `FALSE` keywords since 3.23 and stores
   * them as 1 and 0, so emitting them costs nothing here and is what keeps a
   * statement portable to a database that refuses the integers.
   */
  booleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE'
  }

  private renderColumn(column: ColumnPlan): string {
    const typeSql = this.getColumnType(column)
    const parts: string[] = [this.quoteIdentifier(column.name), typeSql]

    if (column.isPrimaryKey) {
      parts.push('PRIMARY KEY')
      const autoIncrement = this.getAutoIncrementClause(column)
      if (autoIncrement) {
        parts.push(autoIncrement)
      }
    }

    if (!column.isNullable && !column.isPrimaryKey) {
      parts.push('not null')
    }

    const defaultValue = this.getDefaultValue(column)
    if (defaultValue) {
      parts.push(defaultValue)
    }

    // Inline FK — for SQLite this is the ONLY path that works, since
    // SQLite doesn't support `ALTER TABLE ADD CONSTRAINT`. The
    // orchestrator (`generateSql` / `generateDiffSql` in migrations.ts)
    // skips its post-CREATE `addForeignKey` pass when emitting CREATE
    // TABLE so we don't duplicate the FK on dialects that accept both
    // forms. Enforcement still requires `PRAGMA foreign_keys = ON` on
    // the SQLite connection (off by default — set this in the
    // consumer's connection bootstrap).
    if (column.references) {
      parts.push(`REFERENCES ${this.quoteIdentifier(column.references.table)}(${this.quoteIdentifier(column.references.column)})`)
      if (column.references.onDelete)
        parts.push(`ON DELETE ${column.references.onDelete.toUpperCase()}`)
      if (column.references.onUpdate)
        parts.push(`ON UPDATE ${column.references.onUpdate.toUpperCase()}`)
    }

    return parts.join(' ')
  }
}
