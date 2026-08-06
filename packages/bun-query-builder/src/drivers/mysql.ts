import type { ColumnPlan, IndexPlan, RebuildTableSpec, TablePlan } from '../migrations'
import { qualifiedIndexName } from './index-name'

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

export class MySQLDriver implements DialectDriver {
  protected quoteIdentifier(id: string): string {
    // Escape backticks by doubling them, then wrap in backticks
    // This prevents SQL injection through identifier names
    return `\`${id.replace(/`/g, '``')}\``
  }

  protected getColumnType(column: ColumnPlan): string {
    switch (column.type) {
      case 'string': return `varchar(${column.maxLength ?? 255})`
      case 'text': return 'text'
      case 'boolean': return 'tinyint(1)'
      case 'integer': return 'integer'
      case 'bigint': return 'bigint'
      case 'float': return 'real'
      case 'double': return 'double precision'
      case 'decimal': return 'decimal(10,2)'
      case 'date': return 'date'
      case 'datetime': return 'datetime'
      case 'timestamptz': return 'datetime'
      case 'json': return 'json'
      case 'enum':
        if (column.enumValues && column.enumValues.length > 0) {
          const enumValues = column.enumValues.map(v => `'${v.replace(/'/g, '\'\'')}'`).join(', ')
          return `ENUM(${enumValues})`
        }
        return 'text'
      default: return 'text'
    }
  }

  protected getPrimaryKeyType(column: ColumnPlan): string {
    return this.getColumnType(column)
  }

  protected getAutoIncrementClause(column: ColumnPlan): string {
    if (column.isPrimaryKey && (column.type === 'integer' || column.type === 'bigint')) {
      return 'auto_increment'
    }
    return ''
  }

  protected getDefaultValue(column: ColumnPlan): string {
    if (!column.hasDefault || column.defaultValue === undefined) {
      return ''
    }

    const dv = column.defaultValue
    if (typeof dv === 'string') {
      // Check for raw SQL expressions that should not be quoted
      const rawSqlExpressions = ['CURRENT_TIMESTAMP', 'NOW()', 'NULL', 'CURRENT_DATE', 'CURRENT_TIME']
      const upperDv = dv.toUpperCase()
      if (rawSqlExpressions.includes(upperDv)) {
        return `default ${upperDv}`
      }
      const literal = `'${dv.replace(/'/g, '\'\'')}'`
      // MySQL 8 accepts defaults on TEXT/JSON columns only when the value is
      // written as an expression. Vitess enforces the same rule at vtgate.
      // The model still owns the default; the parentheses merely select the
      // portable MySQL 8 syntax instead of emitting DDL the server rejects.
      if (column.type === 'text' || column.type === 'json' || (column.type === 'enum' && !column.enumValues?.length))
        return `default (${literal})`
      return `default ${literal}`
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
    // MySQL doesn't support CREATE TYPE, enums are handled inline in column definitions
    return ''
  }

  createTable(table: TablePlan): string {
    const columns = table.columns.map(c => this.renderColumn(c)).join(',\n  ')
    return `CREATE TABLE IF NOT EXISTS ${this.quoteIdentifier(table.table)} (\n  ${columns}\n);`
  }

  createIndex(tableName: string, index: IndexPlan): string {
    if (index.where) {
      throw new Error(
        `[migrations] Partial indexes (CompositeIndex.where) are not supported on MySQL. Index '${index.name}' on table '${tableName}' uses WHERE clause: ${index.where}`,
      )
    }
    const kind = index.type === 'unique' ? 'UNIQUE ' : ''
    const idxName = qualifiedIndexName(tableName, index.name)
    const columns = index.columns.map(c => this.quoteIdentifier(c)).join(', ')
    // MySQL doesn't support IF NOT EXISTS for CREATE INDEX, so we use a different approach
    return `CREATE ${kind}INDEX ${this.quoteIdentifier(idxName)} ON ${this.quoteIdentifier(tableName)} (${columns});`
  }

  /**
   * Replace the foreign key on a column, rather than adding a second one.
   *
   * Same defect the Postgres driver had, and the same consequence: a column
   * created inline with `REFERENCES` already carries a constraint under a name
   * the server chose, adding another leaves both, and every one the server
   * holds is enforced - so a migration that adds `ON DELETE CASCADE` applies
   * cleanly and deletes go on failing against the `RESTRICT` beside it.
   *
   * MySQL has no `DROP CONSTRAINT IF EXISTS` and no anonymous DO block, so
   * this is a prepared statement built from `information_schema`. It drops
   * every single-column foreign key on the column, whatever it is called;
   * composite keys are left alone, because a composite key that mentions this
   * column is a different rule nobody asked to change.
   */
  addForeignKey(tableName: string, columnName: string, refTable: string, refColumn: string, onDelete?: string, onUpdate?: string): string {
    const fkName = `${tableName}_${columnName}_fk`
    let sql = `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD CONSTRAINT ${this.quoteIdentifier(fkName)} FOREIGN KEY (${this.quoteIdentifier(columnName)}) REFERENCES ${this.quoteIdentifier(refTable)}(${this.quoteIdentifier(refColumn)})`
    if (onDelete)
      sql += ` ON DELETE ${onDelete.toUpperCase()}`
    if (onUpdate)
      sql += ` ON UPDATE ${onUpdate.toUpperCase()}`

    return `${this.dropForeignKeysOn(tableName, columnName)}\n${sql};`
  }

  /**
   * Drop every single-column foreign key on a column, by discovery.
   *
   * The `HAVING COUNT(*) = 1` is what keeps it to single-column keys: a
   * composite key has more than one row in `KEY_COLUMN_USAGE` for the same
   * constraint name.
   *
   * The drops are folded into **one** `ALTER TABLE … DROP FOREIGN KEY a, DROP
   * FOREIGN KEY b`, because `PREPARE` takes a single statement - stringing
   * several together with semicolons is a syntax error, not a batch. When
   * there is nothing to drop the statement becomes `SELECT 1`, since `PREPARE`
   * on an empty string is an error rather than a no-op.
   */
  private dropForeignKeysOn(tableName: string, columnName: string): string {
    const table = this.quoteLiteral(tableName)
    const column = this.quoteLiteral(columnName)

    return `SET @drop_fks := (
  SELECT CONCAT(
    'ALTER TABLE \`', ${table}, '\` DROP FOREIGN KEY \`',
    GROUP_CONCAT(kcu.CONSTRAINT_NAME SEPARATOR '\`, DROP FOREIGN KEY \`'),
    '\`'
  )
  FROM information_schema.KEY_COLUMN_USAGE kcu
  WHERE kcu.TABLE_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = ${table}
    AND kcu.COLUMN_NAME = ${column}
    AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
    AND kcu.CONSTRAINT_NAME IN (
      SELECT single.CONSTRAINT_NAME FROM (
        SELECT inner_kcu.CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE inner_kcu
        WHERE inner_kcu.TABLE_SCHEMA = DATABASE()
          AND inner_kcu.TABLE_NAME = ${table}
          AND inner_kcu.REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY inner_kcu.CONSTRAINT_NAME
        HAVING COUNT(*) = 1
      ) AS single
    )
);
SET @drop_fks := IFNULL(@drop_fks, 'SELECT 1');
PREPARE drop_fks_stmt FROM @drop_fks;
EXECUTE drop_fks_stmt;
DEALLOCATE PREPARE drop_fks_stmt;`
  }

  /** A single-quoted SQL string, for the identifiers `information_schema` stores as text. */
  private quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, '\'\'')}'`
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
    const typeSql = this.getColumnType(column)
    const parts: string[] = [this.quoteIdentifier(column.name), typeSql]

    if (!column.isNullable && !column.isPrimaryKey) {
      parts.push('not null')
    }

    const defaultValue = this.getDefaultValue(column)
    if (defaultValue) {
      parts.push(defaultValue)
    }

    // MySQL uses MODIFY COLUMN to change column definition
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} MODIFY COLUMN ${parts.join(' ')};`
  }

  renameColumn(tableName: string, from: string, to: string): string {
    // RENAME COLUMN is supported since MySQL 8.0. Older servers would need the
    // `CHANGE <old> <new> <fullType>` form; Stacks targets 8.0+.
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} RENAME COLUMN ${this.quoteIdentifier(from)} TO ${this.quoteIdentifier(to)};`
  }

  renameTable(from: string, to: string): string {
    return `RENAME TABLE ${this.quoteIdentifier(from)} TO ${this.quoteIdentifier(to)};`
  }

  rebuildTable(): string {
    // MySQL changes column types/constraints in place via MODIFY COLUMN —
    // it never needs the SQLite recreate dance.
    throw new Error('[migrations] rebuildTable is only implemented for SQLite; MySQL uses in-place ALTER.')
  }

  dropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`
  }

  dropColumn(tableName: string, columnName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)};`
  }

  dropIndex(tableName: string, indexName: string): string {
    const fullIndexName = qualifiedIndexName(tableName, indexName)
    return `DROP INDEX ${this.quoteIdentifier(fullIndexName)} ON ${this.quoteIdentifier(tableName)};`
  }

  dropEnumType(_enumTypeName: string): string {
    // MySQL doesn't support DROP TYPE for enums
    return ''
  }

  createMigrationsTable(): string {
    return `CREATE TABLE IF NOT EXISTS migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      migration VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  }

  getExecutedMigrationsQuery(): string {
    return 'SELECT migration, executed_at FROM migrations ORDER BY executed_at'
  }

  recordMigrationQuery(): string {
    return 'INSERT INTO migrations (migration) VALUES (?)'
  }

  protected renderColumn(column: ColumnPlan): string {
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
