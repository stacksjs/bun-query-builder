import type { ColumnPlan, IndexPlan, TablePlan } from '../migrations'

export interface DialectDriver {
  createEnumType: (enumTypeName: string, values: string[]) => string
  createTable: (table: TablePlan) => string
  createIndex: (tableName: string, index: IndexPlan) => string
  addForeignKey: (tableName: string, columnName: string, refTable: string, refColumn: string) => string
  addColumn: (tableName: string, column: ColumnPlan) => string
  modifyColumn: (tableName: string, column: ColumnPlan) => string
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
    return `"${id}"`
  }

  private getColumnType(column: ColumnPlan): string {
    switch (column.type) {
      case 'string': return 'TEXT'
      case 'text': return 'TEXT'
      case 'boolean': return 'INTEGER' // SQLite uses INTEGER for booleans (0/1)
      case 'integer': return 'INTEGER'
      case 'bigint': return 'INTEGER'
      case 'float': return 'REAL'
      case 'double': return 'REAL'
      case 'decimal': return 'REAL'
      case 'date': return 'TEXT'
      case 'datetime': return 'TEXT'
      case 'json': return 'TEXT'
      case 'enum':
        if (column.enumValues && column.enumValues.length > 0) {
          const enumValues = column.enumValues.map(v => `'${v.replace(/'/g, '\'\'')}'`).join(', ')
          return `TEXT CHECK (${this.quoteIdentifier(column.name)} IN (${enumValues}))`
        }
        return 'TEXT'
      default: return 'TEXT'
    }
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
    return `CREATE TABLE ${this.quoteIdentifier(table.table)} (\n  ${columns}\n);`
  }

  createIndex(tableName: string, index: IndexPlan): string {
    const kind = index.type === 'unique' ? 'UNIQUE ' : ''
    const idxName = `${tableName}_${index.name}`
    const columns = index.columns.map(c => this.quoteIdentifier(c)).join(', ')
    return `CREATE ${kind}INDEX ${this.quoteIdentifier(idxName)} ON ${this.quoteIdentifier(tableName)} (${columns});`
  }

  addForeignKey(tableName: string, columnName: string, refTable: string, refColumn: string): string {
    const fkName = `${tableName}_${columnName}_fk`
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD CONSTRAINT ${this.quoteIdentifier(fkName)} FOREIGN KEY (${this.quoteIdentifier(columnName)}) REFERENCES ${this.quoteIdentifier(refTable)}(${this.quoteIdentifier(refColumn)});`
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
    // SQLite does not support ALTER COLUMN to change type
    // This requires recreating the table with the new schema
    return `-- SQLite does not support ALTER COLUMN. Manual table recreation needed to change ${this.quoteIdentifier(tableName)}.${this.quoteIdentifier(column.name)} type`;
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
    const fullIndexName = `${tableName}_${indexName}`
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
    return 'SELECT migration FROM migrations ORDER BY executed_at'
  }

  recordMigrationQuery(): string {
    return 'INSERT INTO migrations (migration) VALUES (?)'
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

    return parts.join(' ')
  }
}
