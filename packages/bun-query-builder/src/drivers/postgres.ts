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

export class PostgresDriver implements DialectDriver {
  private quoteIdentifier(id: string): string {
    // Escape double quotes by doubling them, then wrap in quotes
    // This prevents SQL injection through identifier names
    return `"${id.replace(/"/g, '""')}"`
  }

  private getColumnType(column: ColumnPlan): string {
    switch (column.type) {
      case 'string': return 'varchar(255)'
      case 'text': return 'text'
      case 'boolean': return 'boolean'
      case 'integer': return 'integer'
      case 'bigint': return 'bigint'
      case 'float': return 'real'
      case 'double': return 'double precision'
      case 'decimal': return 'decimal(10,2)'
      case 'date': return 'date'
      case 'datetime': return 'timestamp'
      case 'json': return 'jsonb'
      case 'enum':
        if (column.enumValues && column.enumValues.length > 0) {
          return `${column.name}_type`
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
    const idxName = `${tableName}_${index.name}`
    const columns = index.columns.map(c => this.quoteIdentifier(c)).join(', ')
    return `CREATE ${kind}INDEX IF NOT EXISTS ${this.quoteIdentifier(idxName)} ON ${this.quoteIdentifier(tableName)} (${columns});`
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
    const typeSql = this.getColumnType(column)
    // PostgreSQL requires separate ALTER statements for type, nullability, and default
    // Add USING clause to handle type conversions that aren't automatic
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ALTER COLUMN ${this.quoteIdentifier(column.name)} TYPE ${typeSql} USING ${this.quoteIdentifier(column.name)}::${typeSql};`
  }

  dropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)} CASCADE`
  }

  dropColumn(tableName: string, columnName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)};`
  }

  dropIndex(tableName: string, indexName: string): string {
    const fullIndexName = `${tableName}_${indexName}`
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
    return 'SELECT migration FROM migrations ORDER BY executed_at'
  }

  recordMigrationQuery(): string {
    return 'INSERT INTO migrations (migration) VALUES ($1)'
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

    return parts.join(' ')
  }
}
