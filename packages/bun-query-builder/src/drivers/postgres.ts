import type { ColumnPlan, IndexPlan, RebuildTableSpec, TablePlan } from '../migrations'
import { qualifiedIndexName } from './index-name'

export interface DialectDriver {
  createEnumType: (enumTypeName: string, values: string[]) => string
  createTable: (table: TablePlan) => string
  /**
   * `columns` is the table's column plan, which MySQL needs and the others
   * ignore: a key part over a TEXT column has to name a prefix length there,
   * and the length is only knowable from the column's type.
   */
  createIndex: (tableName: string, index: IndexPlan, columns?: readonly ColumnPlan[]) => string
  addForeignKey: (tableName: string, columnName: string, refTable: string, refColumn: string, onDelete?: string, onUpdate?: string, existingConstraintNames?: string[]) => string
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

  // ---------------------------------------------------------------------------
  // Query-time fragments
  //
  // DDL is not the only place the dialects disagree, and the disagreements at
  // query time are the expensive ones: a `strftime` or a `json_extract` parses
  // on SQLite and is a syntax error on Postgres, so an application developed
  // against SQLite passes its whole suite and then fails on the live site. The
  // renderers below exist so an application never has to name a dialect.
  // ---------------------------------------------------------------------------

  /**
   * Read one key out of a JSON/JSONB column, yielding text.
   *
   * `key` is SQL, not a value: pass a placeholder (`'?'`, `'$3'`) to bind it, or
   * a quoted literal. SQLite cannot take a bound parameter as a JSON *path* —
   * bound, it is treated as a literal string and matches nothing — so a caller
   * that must interpolate should validate the key against an allowlist first.
   */
  jsonExtract: (column: string, key: string) => string

  /**
   * Truncate a timestamp column to a bucket, rendered as an ISO-8601 string.
   *
   * Every dialect returns the same `YYYY-MM-DDTHH:MM:SS.000Z` shape, because
   * callers compare the result against buckets generated in application code. A
   * format that varied by dialect would line up in development and silently
   * produce empty series in production.
   *
   * `offsetHours` shifts into a target timezone before truncating. Weeks start
   * on Monday everywhere, which SQLite needs to be told and Postgres does not.
   *
   * The column may be a real timestamp or an ISO string in a text column; each
   * driver casts as its dialect requires.
   */
  dateBucket: (column: string, grain: DateBucketGrain, offsetHours?: number) => string

  /**
   * A boolean literal for a SQL statement.
   *
   * SQLite accepts `1` and `0` for a boolean column and Postgres rejects them
   * with `is of type boolean but expression is of type integer`, so an app that
   * writes integers works until the day it meets a stricter database.
   */
  booleanLiteral: (value: boolean) => string
}

/** The buckets {@link DialectDriver.dateBucket} can truncate to. */
export type DateBucketGrain = 'hour' | 'day' | 'week' | 'month' | 'year'

/**
 * The ISO shape every driver's {@link DialectDriver.dateBucket} must produce.
 *
 * Exported so a driver's tests can assert against one definition rather than
 * each restating the format it happens to emit.
 */
export const DATE_BUCKET_FORMAT = 'YYYY-MM-DDTHH:MM:SS.000Z'

export class PostgresDriver implements DialectDriver {
  private quoteIdentifier(id: string): string {
    // Escape double quotes by doubling them, then wrap in quotes
    // This prevents SQL injection through identifier names
    return `"${id.replace(/"/g, '""')}"`
  }

  private getColumnType(column: ColumnPlan): string {
    switch (column.type) {
      case 'string': return `varchar(${column.maxLength ?? 255})`
      case 'text': return 'text'
      case 'boolean': return 'boolean'
      case 'integer': return 'integer'
      case 'bigint': return 'bigint'
      case 'float': return 'real'
      case 'double': return 'double precision'
      case 'decimal': return 'decimal(10,2)'
      case 'date': return 'date'
      case 'datetime': return 'timestamp'
      case 'timestamptz': return 'timestamptz'
      case 'json': return 'jsonb'
      case 'enum':
        if (column.enumValues && column.enumValues.length > 0) {
          // Only the generator-stamped, table-qualified name is safe to emit:
          // enum columns sharing a name across tables map to distinct Postgres
          // types, and a guessed `<column>_type` names a type nothing creates,
          // which fails at migration time rather than here. Falling back to
          // text keeps the column usable and its values intact.
          return column.enumTypeName ? this.quoteIdentifier(column.enumTypeName) : 'text'
        }
        return 'text'
      default: return 'text'
    }
  }

  private getPrimaryKeyType(column: ColumnPlan): string {
    switch (column.type) {
      case 'integer': return 'SERIAL'
      case 'bigint': return 'BIGSERIAL'
      default: return this.getColumnType(column)
    }
  }

  private getAutoIncrementClause(_column: ColumnPlan): string {
    // PostgreSQL uses SERIAL types instead of AUTO_INCREMENT
    return ''
  }

  private getDefaultValue(column: ColumnPlan): string {
    if (!column.hasDefault || column.defaultValue === undefined) {
      return ''
    }

    const dv = column.defaultValue
    if (typeof dv === 'string') {
      // Check for raw SQL expressions that should not be quoted
      const upperDv = dv.toUpperCase()

      // The database's own clock in UTC. `CURRENT_TIMESTAMP` is the session's
      // local one, which is a different value on any host not set to UTC and is
      // the bug this spelling exists to avoid.
      if (upperDv === 'UTC_TIMESTAMP')
        return `default (now() AT TIME ZONE 'utc')`

      const rawSqlExpressions = ['CURRENT_TIMESTAMP', 'NOW()', 'NULL', 'CURRENT_DATE', 'CURRENT_TIME']
      if (rawSqlExpressions.includes(upperDv)) {
        return `default ${upperDv}`
      }
      return `default '${dv.replace(/'/g, '\'\'')}'`
    }
    else if (typeof dv === 'number' || typeof dv === 'bigint') {
      return `default ${dv}`
    }
    else if (typeof dv === 'boolean') {
      return `default ${dv ? 'true' : 'false'}`
    }
    else if (dv instanceof Date) {
      return `default '${dv.toISOString()}'`
    }
    return ''
  }

  createEnumType(enumTypeName: string, values: string[]): string {
    const enumValues = values.map(v => `'${v.replace(/'/g, '\'\'')}'`).join(', ')
    return `CREATE TYPE ${this.quoteIdentifier(enumTypeName)} AS ENUM (${enumValues});`
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

  /** Add a foreign key, dropping exact live constraint names when replacing one. */
  addForeignKey(tableName: string, columnName: string, refTable: string, refColumn: string, onDelete?: string, onUpdate?: string, existingConstraintNames: string[] = []): string {
    const fkName = `${tableName}_${columnName}_fk`
    let sql = `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD CONSTRAINT ${this.quoteIdentifier(fkName)} FOREIGN KEY (${this.quoteIdentifier(columnName)}) REFERENCES ${this.quoteIdentifier(refTable)}(${this.quoteIdentifier(refColumn)})`
    if (onDelete)
      sql += ` ON DELETE ${onDelete.toUpperCase()}`
    if (onUpdate)
      sql += ` ON UPDATE ${onUpdate.toUpperCase()}`

    const drops = [...new Set(existingConstraintNames)]
      .map(name => `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(name)};`)
      .join('\n')
    return drops ? `${drops}\n${sql};` : `${sql};`
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

  /**
   * Bring a column to the state the model declares.
   *
   * Postgres needs a separate ALTER per facet, and only the type one was ever
   * emitted - so making a column nullable, or changing its default, generated a
   * migration that ran cleanly and changed nothing. The schema silently
   * disagreed with the models from then on, and the next diff proposed the same
   * no-op again. MySQL never had this because `MODIFY COLUMN` restates the
   * whole definition at once.
   *
   * All three are emitted unconditionally rather than diffed, because each is
   * declarative: setting a column to the nullability it already has is a no-op.
   * `SET NOT NULL` against existing nulls does fail, and should - that is the
   * model asking for something the data does not support, and silence would
   * leave the two disagreeing again.
   */
  modifyColumn(tableName: string, column: ColumnPlan): string {
    const typeSql = this.getColumnType(column)
    const table = this.quoteIdentifier(tableName)
    const name = this.quoteIdentifier(column.name)

    // The old default comes off before the type changes, and the new one goes
    // on after.
    //
    // Postgres checks the existing default against the new type, and refuses
    // the whole statement when it cannot cast it: turning a `varchar` column
    // that defaults to `'pending'` into an enum fails with "default for column
    // cannot be cast automatically", naming the type rather than the default,
    // which is the part that actually has to move. The column is left as it
    // was and the same migration is proposed again on the next run.
    //
    // Unconditional because it costs nothing when there is no default, and
    // because the case it protects is exactly the one where the generator
    // cannot tell what the old default was: it only knows what the model says
    // the new one should be.
    const statements = [
      `ALTER TABLE ${table} ALTER COLUMN ${name} DROP DEFAULT;`,
      `ALTER TABLE ${table} ALTER COLUMN ${name} TYPE ${typeSql} USING ${name}::${typeSql};`,
    ]

    // A primary key carries NOT NULL through the constraint itself, and saying
    // it again here would fight with it.
    if (!column.isPrimaryKey)
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} ${column.isNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`)

    const defaultValue = this.getDefaultValue(column)
    if (defaultValue)
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} SET ${defaultValue};`)

    return statements.join('\n')
  }

  renameColumn(tableName: string, from: string, to: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} RENAME COLUMN ${this.quoteIdentifier(from)} TO ${this.quoteIdentifier(to)};`
  }

  renameTable(from: string, to: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(from)} RENAME TO ${this.quoteIdentifier(to)};`
  }

  rebuildTable(): string {
    // Postgres changes column types/constraints in place via ALTER COLUMN —
    // it never needs the SQLite recreate dance.
    throw new Error('[migrations] rebuildTable is only implemented for SQLite; Postgres uses in-place ALTER.')
  }

  dropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)} CASCADE`
  }

  dropColumn(tableName: string, columnName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)};`
  }

  dropIndex(tableName: string, indexName: string): string {
    const fullIndexName = qualifiedIndexName(tableName, indexName)
    return `DROP INDEX IF EXISTS ${this.quoteIdentifier(fullIndexName)};`
  }

  dropEnumType(enumTypeName: string): string {
    return `DROP TYPE IF EXISTS ${this.quoteIdentifier(enumTypeName)} CASCADE`
  }

  createMigrationsTable(): string {
    return `CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      migration VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  }

  getExecutedMigrationsQuery(): string {
    return 'SELECT migration, executed_at FROM migrations ORDER BY executed_at'
  }

  recordMigrationQuery(): string {
    return 'INSERT INTO migrations (migration) VALUES ($1)'
  }

  /**
   * `->>` yields text, matching what SQLite's `json_extract` returns for a
   * scalar, so the two dialects agree on the type a caller gets back.
   *
   * The cast is explicit because a JSON document is very often kept in a text
   * column: `->>` on a `varchar` is an operator-does-not-exist error, and
   * casting an already-`jsonb` column is free.
   */
  jsonExtract(column: string, key: string): string {
    return `(${column}::jsonb ->> ${key})`
  }

  dateBucket(column: string, grain: DateBucketGrain, offsetHours = 0): string {
    const shifted = offsetHours === 0
      ? `${column}::timestamp`
      : `(${column}::timestamp ${offsetHours >= 0 ? '+' : '-'} interval '${Math.abs(offsetHours)} hours')`

    // date_trunc already starts weeks on Monday, which is what the SQLite
    // driver goes to some trouble to arrange.
    const truncated = grain === 'week' ? `date_trunc('week', ${shifted})` : shifted

    switch (grain) {
      case 'hour':
        return `to_char(${truncated}, 'YYYY-MM-DD"T"HH24:00:00.000"Z"')`
      case 'month':
        return `to_char(${truncated}, 'YYYY-MM-01"T"00:00:00.000"Z"')`
      case 'year':
        return `to_char(${truncated}, 'YYYY-01-01"T"00:00:00.000"Z"')`
      case 'week':
      case 'day':
      default:
        return `to_char(${truncated}, 'YYYY-MM-DD"T"00:00:00.000"Z"')`
    }
  }

  booleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE'
  }

  private renderColumn(column: ColumnPlan): string {
    const typeSql = column.isPrimaryKey ? this.getPrimaryKeyType(column) : this.getColumnType(column)
    const parts: string[] = [this.quoteIdentifier(column.name), typeSql]

    if (column.isPrimaryKey) {
      parts.push('PRIMARY KEY')
    }

    if (!column.isNullable && !column.isPrimaryKey) {
      parts.push('not null')
    }

    const defaultValue = this.getDefaultValue(column)
    if (defaultValue) {
      parts.push(defaultValue)
    }

    if (column.references) {
      let reference = `REFERENCES ${this.quoteIdentifier(column.references.table)}(${this.quoteIdentifier(column.references.column)})`
      if (column.references.onDelete)
        reference += ` ON DELETE ${column.references.onDelete.toUpperCase()}`
      if (column.references.onUpdate)
        reference += ` ON UPDATE ${column.references.onUpdate.toUpperCase()}`
      parts.push(reference)
    }

    return parts.join(' ')
  }
}
