import type { ModelRecord } from './schema'
import type { SupportedDialect } from './types'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSchemaMeta } from './meta'

let migrationCounter = 0

function ensureSqlDirectory(): string {
  const sqlDir = join(__dirname, '..', 'sql')
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    console.log(`-- Created SQL directory: ${sqlDir}`)
  }
  return sqlDir
}

function createMigrationFile(statement: string, fileName: string): void {
  if (!statement)
    return

  const baseTimestamp = Math.floor(Date.now() / 1000)
  const timestamp = baseTimestamp + migrationCounter
  migrationCounter++

  const fullFileName = `${timestamp}-${fileName}.sql`
  const sqlDir = ensureSqlDirectory()
  const filePath = join(sqlDir, fullFileName)

  writeFileSync(filePath, statement)
  console.log(`-- Migration file created: ${fullFileName}`)
}

export type PrimitiveDefault = string | number | boolean | bigint | Date

export type NormalizedColumnType =
  | 'string'
  | 'text'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'float'
  | 'double'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'json'

export interface ColumnPlan {
  name: string
  type: NormalizedColumnType
  isPrimaryKey: boolean
  isUnique: boolean
  isNullable: boolean
  hasDefault: boolean
  defaultValue?: PrimitiveDefault
  references?: { table: string, column: string }
}

export interface IndexPlan {
  name: string
  columns: string[]
  type: 'index' | 'unique'
}

export interface TablePlan {
  table: string
  columns: ColumnPlan[]
  indexes: IndexPlan[]
}

export interface MigrationPlan {
  dialect: SupportedDialect
  tables: TablePlan[]
}

function guessTypeFromName(columnName: string): NormalizedColumnType | undefined {
  if (columnName.endsWith('_id'))
    return 'bigint' // Match primary key type
  if (columnName.endsWith('_at'))
    return 'datetime'
  if (columnName.startsWith('is_') || columnName.startsWith('has_'))
    return 'boolean'
  return undefined
}

function normalizeDefaultValue(value: unknown): PrimitiveDefault | undefined {
  if (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || value instanceof Date
  ) {
    return value
  }
  return undefined
}

export interface InferenceOptions {
  dialect: SupportedDialect
}

export function buildMigrationPlan(models: ModelRecord, options: InferenceOptions): MigrationPlan {
  const meta = buildSchemaMeta(models)
  const tables: TablePlan[] = []

  for (const modelName of Object.keys(models)) {
    const model = models[modelName]
    const table = (model.table as string) || `${String(model.name).toLowerCase()}s`
    const primaryKey = model.primaryKey ?? 'id'
    const attrs = model.attributes ?? {}

    const columns: ColumnPlan[] = []
    const indexes: IndexPlan[] = []

    for (const attrName of Object.keys(attrs)) {
      const attr = attrs[attrName]

      // Base nullability: if no validation rule enforcing required, default nullable
      const isNullable = true

      // Type inference heuristics
      let inferred: NormalizedColumnType | undefined = guessTypeFromName(attrName)
      if (!inferred) {
        // Fallback by default value type, if provided
        const dv = normalizeDefaultValue(attr.default)
        if (typeof dv === 'string')
          inferred = dv.length > 255 ? 'text' : 'string'
        else if (typeof dv === 'number')
          inferred = Number.isInteger(dv) ? 'integer' : 'float'
        else if (typeof dv === 'boolean')
          inferred = 'boolean'
        else if (typeof dv === 'bigint')
          inferred = 'bigint'
        else if (dv instanceof Date)
          inferred = 'datetime'
      }
      const isPk = attrName === primaryKey

      // Final fallback - primary keys should be integers, others default to string
      if (!inferred) {
        inferred = isPk ? 'bigint' : 'string'
      }

      const col: ColumnPlan = {
        name: attrName,
        type: inferred,
        isPrimaryKey: isPk,
        isUnique: Boolean(attr.unique),
        isNullable,
        hasDefault: typeof attr.default !== 'undefined',
        defaultValue: normalizeDefaultValue(attr.default),
      }

      // Foreign key inference for *_id referencing another model's table
      if (attrName.endsWith('_id')) {
        const base = attrName.replace(/_id$/, '')
        const maybeModel = base.charAt(0).toUpperCase() + base.slice(1)
        const refTable = meta.modelToTable[maybeModel]
        if (refTable) {
          const refPk = meta.primaryKeys[refTable] ?? 'id'
          col.references = { table: refTable, column: refPk }
        }
      }

      columns.push(col)
    }

    // Composite indexes from model definition
    for (const idx of (model.indexes ?? [])) {
      indexes.push({ name: idx.name, columns: idx.columns, type: 'index' })
    }

    // Unique single-column indexes from attribute flags
    for (const c of columns) {
      if (c.isUnique && !c.isPrimaryKey)
        indexes.push({ name: `${table}_${c.name}_unique`, columns: [c.name], type: 'unique' })
    }

    tables.push({ table, columns, indexes })
  }

  return { dialect: options.dialect, tables }
}

export function generateSql(plan: MigrationPlan): string[] {
  // Reset migration counter for proper ordering
  migrationCounter = 0

  const statements: string[] = []
  const q = (id: string) => plan.dialect === 'mysql' ? `\`${id}\`` : id

  const columnSql = (c: ColumnPlan): string => {
    const typeSql = (() => {
      // For PostgreSQL, use SERIAL types for auto-incrementing primary keys
      if (plan.dialect === 'postgres' && c.isPrimaryKey) {
        switch (c.type) {
          case 'integer': return 'SERIAL'
          case 'bigint': return 'BIGSERIAL'
          default: break
        }
      }

      switch (c.type) {
        case 'string': return plan.dialect === 'mysql' ? 'varchar(255)' : 'varchar(255)'
        case 'text': return 'text'
        case 'boolean': return plan.dialect === 'mysql' ? 'tinyint(1)' : 'boolean'
        case 'integer': return plan.dialect === 'sqlite' ? 'integer' : 'integer'
        case 'bigint': return 'bigint'
        case 'float': return 'real'
        case 'double': return 'double precision'
        case 'decimal': return 'decimal(10,2)'
        case 'date': return 'date'
        case 'datetime': return plan.dialect === 'mysql' ? 'datetime' : 'timestamp'
        case 'json': return plan.dialect === 'mysql' ? 'json' : (plan.dialect === 'postgres' ? 'jsonb' : 'text')
        default: return 'text'
      }
    })()

    const parts: string[] = [q(c.name), typeSql]
    if (c.isPrimaryKey) {
      parts.push('PRIMARY KEY')
      // Add AUTO_INCREMENT for MySQL primary keys
      if (plan.dialect === 'mysql' && (c.type === 'integer' || c.type === 'bigint')) {
        parts.push('auto_increment')
      }
    }
    if (!c.isNullable && !c.isPrimaryKey)
      parts.push('not null')
    if (c.hasDefault) {
      const dv = c.defaultValue
      if (typeof dv === 'string')
        parts.push(`default '${dv.replace(/'/g, '\'\'')}'`)
      else if (typeof dv === 'number' || typeof dv === 'bigint')
        parts.push(`default ${dv}`)
      else if (typeof dv === 'boolean')
        parts.push(`default ${dv ? 1 : 0}`)
      else if (dv instanceof Date)
        parts.push(`default '${dv.toISOString()}'`)
    }
    return parts.join(' ')
  }

  // Finally, create all tables (CREATE statements - will execute first)
  for (const t of plan.tables) {
    const createTableStatement = `CREATE TABLE ${q(t.table)} (\n  ${t.columns.map(c => columnSql(c)).join(',\n  ')}\n);`
    statements.push(createTableStatement)
    createMigrationFile(createTableStatement, `create-${t.table}-table`)
  }

  // First, create all foreign key constraints (ALTER statements - will execute last)
  for (const t of plan.tables) {
    for (const c of t.columns) {
      if (c.references) {
        const fkName = `${t.table}_${c.name}_fk`
        const alterTableStatement = `ALTER TABLE ${q(t.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`
        statements.push(alterTableStatement)
        createMigrationFile(alterTableStatement, `alter-${t.table}-${c.name}`)
      }
    }
  }

  // Then, create all indexes (CREATE statements - will execute in middle)
  for (const t of plan.tables) {
    for (const idx of t.indexes) {
      const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
      const idxName = `${t.table}_${idx.name}`
      const createIndexStatement = `CREATE ${kind}INDEX ${q(idxName)} ON ${q(t.table)} (${idx.columns.map(c => q(c)).join(', ')});`
      statements.push(createIndexStatement)
      createMigrationFile(createIndexStatement, `create-${idx.name}-index-in-${t.table}`)
    }
  }

  return statements
}

/**
 * Helper function to convert SQL statements array to a single string (for backward compatibility)
 */
export function generateSqlString(plan: MigrationPlan): string {
  return generateSql(plan).join('\n')
}

/**
 * Helper function to convert diff SQL statements array to a single string (for backward compatibility)
 */
export function generateDiffSqlString(previous: MigrationPlan | undefined, next: MigrationPlan): string {
  return generateDiffSql(previous, next).join('\n')
}

/**
 * Compute a stable hash for a migration plan. Useful for snapshotting.
 */
export function hashMigrationPlan(plan: MigrationPlan): string {
  // eslint-disable-next-line ts/no-require-imports
  const crypto = require('node:crypto')
  function canonicalize(value: any): any {
    if (value == null || typeof value !== 'object' || value instanceof Date)
      return value
    if (Array.isArray(value))
      return value.map(v => canonicalize(v))
    const out: Record<string, any> = {}
    for (const key of Object.keys(value).sort())
      out[key] = canonicalize(value[key])
    return out
  }
  const canon = JSON.stringify(canonicalize(plan))
  return crypto.createHash('sha256').update(canon).digest('hex')
}

function mapTablesByName(tables: TablePlan[]): Record<string, TablePlan> {
  const map: Record<string, TablePlan> = {}
  for (const t of tables)
    map[t.table] = t
  return map
}

function mapColumnsByName(columns: ColumnPlan[]): Record<string, ColumnPlan> {
  const map: Record<string, ColumnPlan> = {}
  for (const c of columns)
    map[c.name] = c
  return map
}

function mapIndexesByKey(indexes: IndexPlan[]): Record<string, IndexPlan> {
  const map: Record<string, IndexPlan> = {}
  for (const i of indexes) {
    const key = `${i.type}:${i.name}:${i.columns.join(',')}`
    map[key] = i
  }
  return map
}

/**
 * Generate safe, additive-only SQL to migrate from a previous plan to a new plan.
 * - Creates new tables
 * - Adds new columns (no drops or type/nullable/default changes)
 * - Adds new foreign keys for newly added columns
 * - Adds new indexes and unique indexes
 *
 * If there is no previous plan or the dialect changed, generates full SQL.
 */
export function generateDiffSql(previous: MigrationPlan | undefined, next: MigrationPlan): string[] {
  if (!previous || previous.dialect !== next.dialect)
    return generateSql(next)

  // Reset migration counter for proper ordering
  migrationCounter = 0

  const chunks: string[] = []
  const q = (id: string) => next.dialect === 'mysql' ? `\`${id}\`` : id

  const prevTables = mapTablesByName(previous.tables)
  const nextTables = mapTablesByName(next.tables)

  // 1) Add foreign key constraints for new tables (ALTER statements - will execute last)
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      for (const c of t.columns) {
        if (c.references) {
          const fkName = `${t.table}_${c.name}_fk`
          const alterTableStatement = `ALTER TABLE ${q(t.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`
          chunks.push(alterTableStatement)
          createMigrationFile(alterTableStatement, `alter-${t.table}-${c.name}`)
        }
      }
    }
  }

  // 2) Create indexes for new tables (CREATE statements - will execute in middle)
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      for (const idx of t.indexes) {
        const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
        const idxName = `${t.table}_${idx.name}`
        const createIndexStatement = `CREATE ${kind}INDEX ${q(idxName)} ON ${q(t.table)} (${idx.columns.map(c => q(c)).join(', ')});`
        chunks.push(createIndexStatement)
        createMigrationFile(createIndexStatement, `create-${idx.name}-index-in-${t.table}`)
      }
    }
  }

  // 3) New tables -> create tables (CREATE statements - will execute first)
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      const createTableStatement = `CREATE TABLE ${q(t.table)} (\n  ${t.columns.map((c) => {
        // Reuse column rendering from generateSql
        const tmp: ColumnPlan = c
        const typeSql = (() => {
          switch (tmp.type) {
            case 'string': return next.dialect === 'mysql' ? 'varchar(255)' : 'varchar(255)'
            case 'text': return 'text'
            case 'boolean': return next.dialect === 'mysql' ? 'tinyint(1)' : 'boolean'
            case 'integer': return next.dialect === 'sqlite' ? 'integer' : 'integer'
            case 'bigint': return 'bigint'
            case 'float': return 'real'
            case 'double': return 'double precision'
            case 'decimal': return 'decimal(10,2)'
            case 'date': return 'date'
            case 'datetime': return next.dialect === 'mysql' ? 'datetime' : 'timestamp'
            case 'json': return next.dialect === 'mysql' ? 'json' : (next.dialect === 'postgres' ? 'jsonb' : 'text')
            default: return 'text'
          }
        })()
        const parts: string[] = [q(tmp.name), typeSql]
        if (tmp.isPrimaryKey) {
          parts.push('PRIMARY KEY')
          // Add AUTO_INCREMENT for MySQL primary keys
          if (next.dialect === 'mysql' && (tmp.type === 'integer' || tmp.type === 'bigint')) {
            parts.push('auto_increment')
          }
        }
        if (!tmp.isNullable && !tmp.isPrimaryKey)
          parts.push('not null')
        if (tmp.hasDefault) {
          const dv = tmp.defaultValue
          if (typeof dv === 'string')
            parts.push(`default '${dv.replace(/'/g, '\'\'')}'`)
          else if (typeof dv === 'number' || typeof dv === 'bigint')
            parts.push(`default ${dv}`)
          else if (typeof dv === 'boolean')
            parts.push(`default ${dv ? 1 : 0}`)
          else if (dv instanceof Date)
            parts.push(`default '${dv.toISOString()}'`)
        }
        return parts.join(' ')
      }).join(',\n  ')}\n);`
      chunks.push(createTableStatement)
      createMigrationFile(createTableStatement, `create-${t.table}-table`)
    }
  }

  // 4) Existing tables -> add-only diffs (ALTER statements first, then CREATE)
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    const curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const currCols = mapColumnsByName(curr.columns)

    // Add new columns (ALTER statements - will execute last)
    for (const colName of Object.keys(currCols)) {
      if (!prevCols[colName]) {
        const c = currCols[colName]
        // Render column (without primary key for ADD COLUMN safety)
        const typeSql = (() => {
          switch (c.type) {
            case 'string': return next.dialect === 'mysql' ? 'varchar(255)' : 'varchar(255)'
            case 'text': return 'text'
            case 'boolean': return next.dialect === 'mysql' ? 'tinyint(1)' : 'boolean'
            case 'integer': return next.dialect === 'sqlite' ? 'integer' : 'integer'
            case 'bigint': return 'bigint'
            case 'float': return 'real'
            case 'double': return 'double precision'
            case 'decimal': return 'decimal(10,2)'
            case 'date': return 'date'
            case 'datetime': return next.dialect === 'mysql' ? 'datetime' : 'timestamp'
            case 'json': return next.dialect === 'mysql' ? 'json' : (next.dialect === 'postgres' ? 'jsonb' : 'text')
            default: return 'text'
          }
        })()
        const parts: string[] = [q(c.name), typeSql]
        // Avoid setting primary key via ADD COLUMN, which is unsafe
        if (!c.isNullable && !c.isPrimaryKey)
          parts.push('not null')
        if (c.hasDefault) {
          const dv = c.defaultValue
          if (typeof dv === 'string')
            parts.push(`default '${dv.replace(/'/g, '\'\'')}'`)
          else if (typeof dv === 'number' || typeof dv === 'bigint')
            parts.push(`default ${dv}`)
          else if (typeof dv === 'boolean')
            parts.push(`default ${dv ? 1 : 0}`)
          else if (dv instanceof Date)
            parts.push(`default '${dv.toISOString()}'`)
        }
        const addColumnStatement = `ALTER TABLE ${q(curr.table)} ADD COLUMN ${parts.join(' ')};`
        chunks.push(addColumnStatement)
        createMigrationFile(addColumnStatement, `alter-${curr.table}-add-${c.name}`)

        if (c.references) {
          const fkName = `${curr.table}_${c.name}_fk`
          const addFkStatement = `ALTER TABLE ${q(curr.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`
          chunks.push(addFkStatement)
          createMigrationFile(addFkStatement, `alter-${curr.table}-${c.name}`)
        }
      }
    }

    // Add new indexes (CREATE statements - will execute in middle)
    const prevIdx = mapIndexesByKey(prev.indexes)
    const currIdx = mapIndexesByKey(curr.indexes)
    for (const key of Object.keys(currIdx)) {
      if (!prevIdx[key]) {
        const idx = currIdx[key]
        const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
        const idxName = `${curr.table}_${idx.name}`
        const createIndexStatement = `CREATE ${kind}INDEX ${q(idxName)} ON ${q(curr.table)} (${idx.columns.map(c => q(c)).join(', ')});`
        chunks.push(createIndexStatement)
        createMigrationFile(createIndexStatement, `create-${idx.name}-index-in-${curr.table}`)
      }
    }
  }

  if (chunks.length === 0)
    return ['-- No changes detected']

  return chunks
}
