import type { ModelRecord } from './schema'
import type { SupportedDialect } from './types'
import { buildSchemaMeta } from './meta'

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
    return 'bigint'
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
      // Final fallback
      if (!inferred)
        inferred = 'string'

      const isPk = attrName === primaryKey
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

export function generateSql(plan: MigrationPlan): string {
  const chunks: string[] = []
  const q = (id: string) => plan.dialect === 'mysql' ? `\`${id}\`` : `"${id}"`

  const columnSql = (c: ColumnPlan): string => {
    const typeSql = (() => {
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
    if (c.isPrimaryKey)
      parts.push('primary key')
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

  for (const t of plan.tables) {
    chunks.push(`CREATE TABLE ${q(t.table)} (\n  ${t.columns.map(c => columnSql(c)).join(',\n  ')}\n);`)
    for (const c of t.columns) {
      if (c.references) {
        const fkName = `${t.table}_${c.name}_fk`
        chunks.push(`ALTER TABLE ${q(t.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`)
      }
    }
    for (const idx of t.indexes) {
      const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
      const idxName = `${t.table}_${idx.name}`
      chunks.push(`CREATE ${kind}INDEX ${q(idxName)} ON ${q(t.table)} (${idx.columns.map(c => q(c)).join(', ')});`)
    }
  }
  return chunks.join('\n')
}

/**
 * Compute a stable hash for a migration plan. Useful for snapshotting.
 */
export function hashMigrationPlan(plan: MigrationPlan): string {
  // eslint-disable-next-line ts/no-require-imports
  const crypto = require('node:crypto')
  const canon = JSON.stringify(plan, Object.keys(plan).sort())
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
export function generateDiffSql(previous: MigrationPlan | undefined, next: MigrationPlan): string {
  if (!previous || previous.dialect !== next.dialect)
    return generateSql(next)

  const chunks: string[] = []
  const q = (id: string) => next.dialect === 'mysql' ? `\`${id}\`` : `"${id}"`

  const prevTables = mapTablesByName(previous.tables)
  const nextTables = mapTablesByName(next.tables)

  // 1) New tables -> full create
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      chunks.push(`CREATE TABLE ${q(t.table)} (\n  ${t.columns.map((c) => {
        // Reuse column rendering from generateSql
        const plan: MigrationPlan = { dialect: next.dialect, tables: [] }
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
        if (tmp.isPrimaryKey)
          parts.push('primary key')
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
      }).join(',\n  ')}\n);`)
      for (const c of t.columns) {
        if (c.references) {
          const fkName = `${t.table}_${c.name}_fk`
          chunks.push(`ALTER TABLE ${q(t.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`)
        }
      }
      for (const idx of t.indexes) {
        const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
        const idxName = `${t.table}_${idx.name}`
        chunks.push(`CREATE ${kind}INDEX ${q(idxName)} ON ${q(t.table)} (${idx.columns.map(c => q(c)).join(', ')});`)
      }
    }
  }

  // 2) Existing tables -> add-only diffs
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    const curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const currCols = mapColumnsByName(curr.columns)

    // Add new columns
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
        chunks.push(`ALTER TABLE ${q(curr.table)} ADD COLUMN ${parts.join(' ')};`)

        if (c.references) {
          const fkName = `${curr.table}_${c.name}_fk`
          chunks.push(`ALTER TABLE ${q(curr.table)} ADD CONSTRAINT ${q(fkName)} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.references.table)}(${q(c.references.column)});`)
        }
      }
    }

    // Add new indexes
    const prevIdx = mapIndexesByKey(prev.indexes)
    const currIdx = mapIndexesByKey(curr.indexes)
    for (const key of Object.keys(currIdx)) {
      if (!prevIdx[key]) {
        const idx = currIdx[key]
        const kind = idx.type === 'unique' ? 'UNIQUE ' : ''
        const idxName = `${curr.table}_${idx.name}`
        chunks.push(`CREATE ${kind}INDEX ${q(idxName)} ON ${q(curr.table)} (${idx.columns.map(c => q(c)).join(', ')});`)
      }
    }
  }

  if (chunks.length === 0)
    return '-- No changes detected\n'

  return chunks.join('\n')
}
