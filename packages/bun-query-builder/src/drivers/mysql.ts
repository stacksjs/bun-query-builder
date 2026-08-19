import type { ColumnPlan, IndexPlan, RebuildTableSpec, TablePlan } from '../migrations'
import type { DateBucketGrain } from './postgres'
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

  /**
   * The table's foreign keys, as table-level constraints.
   *
   * Separated from the column so it can be suppressed by the engines that have
   * no foreign keys (SingleStore, a sharded Vitess keyspace) without them
   * having to reimplement the column renderer.
   */
  protected foreignKeyClauses(table: TablePlan): string[] {
    return table.columns.filter(column => column.references).map((column) => {
      const reference = column.references!
      const name = `${table.table}_${column.name}_fk`
      let clause = `CONSTRAINT ${this.quoteIdentifier(name)} FOREIGN KEY (${this.quoteIdentifier(column.name)}) REFERENCES ${this.quoteIdentifier(reference.table)}(${this.quoteIdentifier(reference.column)})`

      if (reference.onDelete)
        clause += ` ON DELETE ${reference.onDelete.toUpperCase()}`
      if (reference.onUpdate)
        clause += ` ON UPDATE ${reference.onUpdate.toUpperCase()}`

      return clause
    })
  }

  createTable(table: TablePlan): string {
    /*
     * Foreign keys go in the table body, not on the column, and this is the
     * difference between a schema that has them and one that does not.
     *
     * MySQL parses a column-level `REFERENCES` clause and then throws it away -
     * its own manual says so - accepting the DDL and creating no constraint. So
     * a corpus written the Postgres way applied cleanly, reported success, and
     * left a database with no referential integrity anywhere in it: 123 of them
     * in ReviewOS, none of which existed. The only spelling InnoDB acts on is
     * the table-level one below.
     */
    const parts = [
      ...table.columns.map(c => this.renderColumn(c)),
      ...this.foreignKeyClauses(table),
    ]

    /*
     * The character set is named rather than inherited.
     *
     * MySQL 8 defaults to utf8mb4, so on a stock server this changes nothing -
     * and that is the point: the schema should not depend on how the operator's
     * server was configured. A server whose default is `latin1` (MySQL 5.7's,
     * and what a great many `my.cnf` files still say) silently creates latin1
     * tables, and the first four-byte character - an emoji in a comment, a name
     * outside the BMP - is rejected on insert or mangled on read, years after
     * the schema was created.
     *
     * The collation is deliberately left to the server: it decides comparison
     * and ordering rather than what can be stored, and naming MySQL 8's
     * `utf8mb4_0900_ai_ci` here would make this DDL unusable on MariaDB, which
     * does not have it. Tables on one server still agree with each other, which
     * is what a join needs.
     */
    return `CREATE TABLE IF NOT EXISTS ${this.quoteIdentifier(table.table)} (\n  ${parts.join(',\n  ')}\n) DEFAULT CHARSET=utf8mb4;`
  }

  /**
   * How many leading characters of a long column go into a key.
   *
   * 255 characters is 1020 bytes under utf8mb4, and it is long enough that a
   * lookup on a file path or a URL narrows to a handful of rows before the
   * engine rechecks the full value. A prefix answers equality and range the way
   * a whole key does; what it cannot do is cover the query, and on a UNIQUE
   * index it enforces uniqueness over the truncated value - which is why the
   * rules below narrow as little as they can get away with.
   */
  protected static readonly KEY_PREFIX_CHARACTERS = 255

  /**
   * InnoDB's limit on a whole key, in bytes, under the DYNAMIC row format that
   * has been the default since MySQL 5.7.9.
   */
  protected static readonly MAX_KEY_BYTES = 3072

  /** utf8mb4, the charset `createTable` names, is four bytes per character. */
  protected static readonly BYTES_PER_CHARACTER = 4

  /**
   * How wide this column is in a key, in bytes, and whether it can be indexed
   * whole at all.
   *
   * TEXT and BLOB cannot: MySQL raises "BLOB/TEXT column used in key
   * specification without a key length" for any key part over one. Everything
   * else has a width, and the widths are what the budget below is spent on.
   */
  protected keyPartWidth(column: ColumnPlan): { bytes: number, indexableWhole: boolean } {
    const rendered = this.getColumnType(column).toLowerCase()

    if (rendered.includes('text') || rendered.includes('blob') || rendered === 'json')
      return { bytes: Number.POSITIVE_INFINITY, indexableWhole: false }

    const characters = rendered.match(/^(?:var)?char\((\d+)\)$/)?.[1]

    if (characters !== undefined)
      return { bytes: Number(characters) * MySQLDriver.BYTES_PER_CHARACTER, indexableWhole: true }

    // Everything else is a fixed-width scalar. Eight bytes covers the widest of
    // them (bigint, double, datetime with fractional seconds) and the exact
    // figure does not matter: these never approach the limit, and overstating
    // them only makes the budget below more cautious.
    return { bytes: 8, indexableWhole: true }
  }

  /**
   * The key parts of an index, prefixed only as far as MySQL forces.
   *
   * Two separate rules, and it is worth keeping them apart:
   *
   * - A TEXT or BLOB column cannot go in a key at all without a prefix, so it
   *   always gets one. This is the common case - a model string longer than 767
   *   characters becomes TEXT - and it is what stopped ReviewOS's corpus on its
   *   first MySQL run, on a review thread indexed by file path.
   * - A *composite* key can exceed 3072 bytes with no single column anywhere
   *   near it: `(bigint, varchar(500), varchar(500))` is 4008. So the total is
   *   checked, and the widest string parts are narrowed one at a time until it
   *   fits, rather than narrowing everything on principle. On a UNIQUE index a
   *   prefix enforces uniqueness over the truncated value, so every character
   *   kept is a distinction preserved.
   *
   * If it still does not fit, this says so. The alternative is DDL that the
   * server rejects at apply time, halfway through a corpus.
   */
  protected keyParts(tableName: string, index: IndexPlan, columns?: readonly ColumnPlan[]): string[] {
    const parts = index.columns.map((name) => {
      const column = columns?.find(one => one.name === name)

      /*
       * Without the column plan this cannot tell a TEXT column from a short
       * one, so it emits the name as written rather than guessing: a prefix
       * nobody asked for is a narrower key than the author wrote, and the
       * server's complaint is at least loud.
       */
      const width = column ? this.keyPartWidth(column) : { bytes: 0, indexableWhole: true }
      const prefixed = !width.indexableWhole

      return {
        name,
        prefixed,
        bytes: prefixed ? MySQLDriver.KEY_PREFIX_CHARACTERS * MySQLDriver.BYTES_PER_CHARACTER : width.bytes,
        // Only a string can be prefixed; narrowing an integer is not a thing.
        narrowable: !width.indexableWhole || width.bytes > MySQLDriver.KEY_PREFIX_CHARACTERS * MySQLDriver.BYTES_PER_CHARACTER,
      }
    })

    const total = (): number => parts.reduce((sum, part) => sum + part.bytes, 0)

    while (total() > MySQLDriver.MAX_KEY_BYTES) {
      // Widest first, and ties keep declaration order, so the same index always
      // renders the same way.
      const widest = parts
        .filter(part => part.narrowable && !part.prefixed)
        .sort((a, b) => b.bytes - a.bytes)[0]

      if (!widest) {
        throw new Error(
          `[migrations] Index '${index.name}' on table '${tableName}' needs ${total()} bytes of key, over MySQL's ${MySQLDriver.MAX_KEY_BYTES}. `
          + `Every column in it is already at its ${MySQLDriver.KEY_PREFIX_CHARACTERS}-character prefix, so shorten a column or drop one from the index.`,
        )
      }

      widest.prefixed = true
      widest.bytes = MySQLDriver.KEY_PREFIX_CHARACTERS * MySQLDriver.BYTES_PER_CHARACTER
    }

    return parts.map(part => part.prefixed
      ? `${this.quoteIdentifier(part.name)}(${MySQLDriver.KEY_PREFIX_CHARACTERS})`
      : this.quoteIdentifier(part.name))
  }

  createIndex(tableName: string, index: IndexPlan, columns?: readonly ColumnPlan[]): string {
    if (index.where) {
      throw new Error(
        `[migrations] Partial indexes (CompositeIndex.where) are not supported on MySQL. Index '${index.name}' on table '${tableName}' uses WHERE clause: ${index.where}`,
      )
    }
    const kind = index.type === 'unique' ? 'UNIQUE ' : ''
    const idxName = qualifiedIndexName(tableName, index.name)
    const keyParts = this.keyParts(tableName, index, columns).join(', ')
    // MySQL doesn't support IF NOT EXISTS for CREATE INDEX, so we use a different approach
    return `CREATE ${kind}INDEX ${this.quoteIdentifier(idxName)} ON ${this.quoteIdentifier(tableName)} (${keyParts});`
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
      .map(name => `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP FOREIGN KEY ${this.quoteIdentifier(name)};`)
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

  /**
   * `->>` is MySQL's unquoting extract and returns text, matching SQLite's
   * `json_extract` and Postgres's `->>`.
   *
   * MySQL takes the path as an expression, so a bound `key` works here without
   * the concatenation SQLite needs.
   */
  jsonExtract(column: string, key: string): string {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, CONCAT('$.', ${key})))`
  }

  dateBucket(column: string, grain: DateBucketGrain, offsetHours = 0): string {
    const shifted = offsetHours === 0
      ? column
      : `DATE_ADD(${column}, INTERVAL ${offsetHours} HOUR)`

    switch (grain) {
      case 'hour':
        return `DATE_FORMAT(${shifted}, '%Y-%m-%dT%H:00:00.000Z')`
      case 'week':
        // Mode 3 makes the week start on Monday, matching the other drivers.
        return `DATE_FORMAT(DATE_SUB(${shifted}, INTERVAL WEEKDAY(${shifted}) DAY), '%Y-%m-%dT00:00:00.000Z')`
      case 'month':
        return `DATE_FORMAT(${shifted}, '%Y-%m-01T00:00:00.000Z')`
      case 'year':
        return `DATE_FORMAT(${shifted}, '%Y-01-01T00:00:00.000Z')`
      case 'day':
      default:
        return `DATE_FORMAT(${shifted}, '%Y-%m-%dT00:00:00.000Z')`
    }
  }

  booleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE'
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

    // No `REFERENCES` here: see `createTable`. MySQL ignores the inline form,
    // so writing it produces a column that looks constrained and is not.

    return parts.join(' ')
  }
}
