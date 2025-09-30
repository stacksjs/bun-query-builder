import type { ColumnPlan, IndexPlan, TablePlan, PrimitiveDefault } from '../migrations'

export interface DialectDriver {
  quoteIdentifier(id: string): string
  getColumnType(column: ColumnPlan): string
  getPrimaryKeyType(column: ColumnPlan): string
  getAutoIncrementClause(column: ColumnPlan): string
  getDefaultValue(column: ColumnPlan): string
  createEnumType(enumTypeName: string, values: string[]): string
  createTable(table: TablePlan): string
  createIndex(tableName: string, index: IndexPlan): string
  addForeignKey(tableName: string, columnName: string, refTable: string, refColumn: string): string
  addColumn(tableName: string, column: ColumnPlan): string
  dropTable(tableName: string): string
  dropEnumType(enumTypeName: string): string
  createMigrationsTable(): string
  getExecutedMigrationsQuery(): string
  recordMigrationQuery(): string
}

export class MySQLDriver implements DialectDriver {
  quoteIdentifier(id: string): string {
    return `\`${id}\``
  }

  getColumnType(column: ColumnPlan): string {
    switch (column.type) {
      case 'string': return 'varchar(255)'
      case 'text': return 'text'
      case 'boolean': return 'tinyint(1)'
      case 'integer': return 'integer'
      case 'bigint': return 'bigint'
      case 'float': return 'real'
      case 'double': return 'double precision'
      case 'decimal': return 'decimal(10,2)'
      case 'date': return 'date'
      case 'datetime': return 'datetime'
      case 'json': return 'json'
      case 'enum': 
        if (column.enumValues && column.enumValues.length > 0) {
          const enumValues = column.enumValues.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')
          return `ENUM(${enumValues})`
        }
        return 'text'
      default: return 'text'
    }
  }

  getPrimaryKeyType(column: ColumnPlan): string {
    return this.getColumnType(column)
  }

  getAutoIncrementClause(column: ColumnPlan): string {
    if (column.isPrimaryKey && (column.type === 'integer' || column.type === 'bigint')) {
      return 'auto_increment'
    }
    return ''
  }

  getDefaultValue(column: ColumnPlan): string {
    if (!column.hasDefault || column.defaultValue === undefined) {
      return ''
    }

    const dv = column.defaultValue
    if (typeof dv === 'string') {
      return `default '${dv.replace(/'/g, '\'\'')}'`
    } else if (typeof dv === 'number' || typeof dv === 'bigint') {
      return `default ${dv}`
    } else if (typeof dv === 'boolean') {
      return `default ${dv ? 1 : 0}`
    } else if (dv instanceof Date) {
      return `default '${dv.toISOString()}'`
    }
    return ''
  }

  createEnumType(enumTypeName: string, values: string[]): string {
    // MySQL doesn't support CREATE TYPE, enums are handled inline in column definitions
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

  dropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`
  }

  dropEnumType(enumTypeName: string): string {
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
