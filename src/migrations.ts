import type { ModelRecord } from './schema'
import type { SupportedDialect } from './types'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { getDialectDriver } from './drivers'
import { buildSchemaMeta } from './meta'

let migrationCounter = 0
let migrationsCreatedCount = 0
let migrationsUpdatedCount = 0

/**
 * Find workspace root by looking for package.json
 */
function findWorkspaceRoot(startPath: string): string {
  let currentPath = startPath

  // Traverse up until we find package.json or reach root
  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath
    }
    currentPath = dirname(currentPath)
  }

  // Fallback to process.cwd() if package.json not found
  return process.cwd()
}

function ensureSqlDirectory(): string {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const sqlDir = join(workspaceRoot, 'sql')
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    console.log(`-- Created SQL directory: ${sqlDir}`)
  }
  return sqlDir
}

function createMigrationFile(statement: string, fileName: string): boolean {
  if (!statement)
    return false

  const sqlDir = ensureSqlDirectory()

  // Check if a migration file with the same semantic name already exists
  const existingFiles = readdirSync(sqlDir)
  const matchingFile = existingFiles.find((file) => {
    // Extract the semantic part after the timestamp
    // Format: timestamp-semantic-name.sql
    const parts = file.match(/^\d+-(.+)\.sql$/)
    return parts && parts[1] === fileName
  })

  if (matchingFile) {
    // Overwrite the existing migration file with new changes
    const existingFilePath = join(sqlDir, matchingFile)
    writeFileSync(existingFilePath, statement)
    console.log(`-- Migration file updated: ${matchingFile}`)
    migrationsUpdatedCount++
    return true
  }

  const baseTimestamp = Math.floor(Date.now() / 1000)
  const timestamp = baseTimestamp + migrationCounter
  migrationCounter++

  const fullFileName = `${timestamp}-${fileName}.sql`
  const filePath = join(sqlDir, fullFileName)

  writeFileSync(filePath, statement)
  console.log(`-- Migration file created: ${fullFileName}`)
  migrationsCreatedCount++
  return true
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
  | 'enum'

export interface ColumnPlan {
  name: string
  type: NormalizedColumnType
  isPrimaryKey: boolean
  isUnique: boolean
  isNullable: boolean
  hasDefault: boolean
  defaultValue?: PrimitiveDefault
  references?: { table: string, column: string }
  enumValues?: string[]
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

function detectEnumFromValidationRule(rule: unknown): string[] | undefined {
  // Check if the rule has the shape of an enum validator
  if (rule && typeof rule === 'object' && 'name' in rule) {
    const ruleObj = rule as any
    // Look for enum-specific properties or patterns
    if (ruleObj.name === 'enum' || (ruleObj.getRules && Array.isArray(ruleObj.getRules()))) {
      // Try to extract enum values from various possible sources
      if (ruleObj.enumValues && Array.isArray(ruleObj.enumValues)) {
        return ruleObj.enumValues.map((v: any) => String(v))
      }
      // Check if the rule has a _values property (from the validation factory)
      if (ruleObj._values && Array.isArray(ruleObj._values)) {
        return ruleObj._values.map((v: any) => String(v))
      }
      // Check if the rule has values in its constructor or properties
      if (ruleObj.values && Array.isArray(ruleObj.values)) {
        return ruleObj.values.map((v: any) => String(v))
      }
    }
  }

  // Fallback: try to detect enum by checking if the rule has enum-like properties
  if (rule && typeof rule === 'object') {
    const ruleObj = rule as any
    // Look for arrays of string/number values that could be enum values
    const possibleValues = ruleObj.enumValues || ruleObj._values || ruleObj.values
    if (Array.isArray(possibleValues) && possibleValues.length > 0) {
      return possibleValues.map((v: any) => String(v))
    }
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
      let enumValues: string[] | undefined

      // Check for enum validation rule first
      const enumVals = detectEnumFromValidationRule(attr.validation.rule)
      if (enumVals && enumVals.length > 0) {
        inferred = 'enum'
        enumValues = enumVals
      }
      else if (!inferred) {
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
        enumValues,
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
  migrationsCreatedCount = 0
  migrationsUpdatedCount = 0

  const statements: string[] = []
  const driver = getDialectDriver(plan.dialect)

  // Create tables with their enum types in the same migration file
  for (const t of plan.tables) {
    const tableStatements: string[] = []

    // First, collect all enum types needed for this table
    const enumTypes = new Set<string>()
    for (const c of t.columns) {
      if (c.type === 'enum' && c.enumValues && c.enumValues.length > 0) {
        const enumTypeName = `${c.name}_type`
        if (!enumTypes.has(enumTypeName)) {
          const createEnumStatement = driver.createEnumType(enumTypeName, c.enumValues)
          if (createEnumStatement) {
            tableStatements.push(createEnumStatement)
          }
          enumTypes.add(enumTypeName)
        }
      }
    }

    // Then, create the table
    const createTableStatement = driver.createTable(t)
    tableStatements.push(createTableStatement)

    // Add all statements to the main statements array
    statements.push(...tableStatements)

    // Create a single migration file for this table with all its statements
    const combinedStatement = tableStatements.join('\n\n')
    createMigrationFile(combinedStatement, `create-${t.table}-table`)
  }

  // First, create all foreign key constraints (ALTER statements - will execute last)
  for (const t of plan.tables) {
    for (const c of t.columns) {
      if (c.references) {
        const alterTableStatement = driver.addForeignKey(t.table, c.name, c.references.table, c.references.column)
        statements.push(alterTableStatement)
        createMigrationFile(alterTableStatement, `alter-${t.table}-${c.name}`)
      }
    }
  }

  // Then, create all indexes (CREATE statements - will execute in middle)
  for (const t of plan.tables) {
    for (const idx of t.indexes) {
      const createIndexStatement = driver.createIndex(t.table, idx)
      statements.push(createIndexStatement)
      createMigrationFile(createIndexStatement, `create-${idx.name}-index-in-${t.table}`)
    }
  }

  // Show summary message
  const totalChanges = migrationsCreatedCount + migrationsUpdatedCount
  if (totalChanges === 0) {
    console.log('-- Nothing to migrate')
  }
  else {
    const parts: string[] = []
    if (migrationsCreatedCount > 0)
      parts.push(`${migrationsCreatedCount} created`)
    if (migrationsUpdatedCount > 0)
      parts.push(`${migrationsUpdatedCount} updated`)
    console.log(`-- Migration files: ${parts.join(', ')}`)
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

function columnsAreDifferent(col1: ColumnPlan, col2: ColumnPlan): boolean {
  // Compare column properties to detect changes
  if (col1.type !== col2.type)
    return true
  if (col1.isNullable !== col2.isNullable)
    return true
  if (col1.hasDefault !== col2.hasDefault)
    return true
  if (col1.defaultValue !== col2.defaultValue)
    return true
  if (col1.isUnique !== col2.isUnique)
    return true

  // Compare enum values for enum types
  if (col1.type === 'enum' && col2.type === 'enum') {
    const enum1 = (col1.enumValues || []).sort().join(',')
    const enum2 = (col2.enumValues || []).sort().join(',')
    if (enum1 !== enum2)
      return true
  }

  return false
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
 * Generate comprehensive SQL to migrate from a previous plan to a new plan.
 * - Creates new tables
 * - Drops removed tables
 * - Adds new columns
 * - Drops removed columns
 * - Adds new indexes
 * - Drops removed indexes
 * - Adds new foreign keys for newly added columns
 *
 * If there is no previous plan or the dialect changed, generates full SQL.
 */
export function generateDiffSql(previous: MigrationPlan | undefined, next: MigrationPlan): string[] {
  if (!previous || previous.dialect !== next.dialect)
    return generateSql(next)

  // Reset migration counter for proper ordering
  migrationCounter = 0
  migrationsCreatedCount = 0
  migrationsUpdatedCount = 0

  const chunks: string[] = []
  const driver = getDialectDriver(next.dialect)

  const prevTables = mapTablesByName(previous.tables)
  const nextTables = mapTablesByName(next.tables)

  // 0) Drop removed tables first
  for (const tableName of Object.keys(prevTables)) {
    if (!nextTables[tableName]) {
      const dropTableStatement = driver.dropTable(tableName)
      chunks.push(dropTableStatement)
      createMigrationFile(dropTableStatement, `drop-${tableName}-table`)
      console.log(`-- Detected dropped table: ${tableName}`)
    }
  }

  // 1) Add foreign key constraints for new tables (ALTER statements - will execute last)
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      for (const c of t.columns) {
        if (c.references) {
          const alterTableStatement = driver.addForeignKey(t.table, c.name, c.references.table, c.references.column)
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
        const createIndexStatement = driver.createIndex(t.table, idx)
        chunks.push(createIndexStatement)
        createMigrationFile(createIndexStatement, `create-${idx.name}-index-in-${t.table}`)
      }
    }
  }

  // 3) New tables -> create tables with their enum types in the same migration file
  for (const tableName of Object.keys(nextTables)) {
    if (!prevTables[tableName]) {
      const t = nextTables[tableName]
      const tableStatements: string[] = []

      // First, collect all enum types needed for this table
      const enumTypes = new Set<string>()
      for (const c of t.columns) {
        if (c.type === 'enum' && c.enumValues && c.enumValues.length > 0) {
          const enumTypeName = `${c.name}_type`
          if (!enumTypes.has(enumTypeName)) {
            const createEnumStatement = driver.createEnumType(enumTypeName, c.enumValues)
            if (createEnumStatement) {
              tableStatements.push(createEnumStatement)
            }
            enumTypes.add(enumTypeName)
          }
        }
      }

      // Then, create the table
      const createTableStatement = driver.createTable(t)
      tableStatements.push(createTableStatement)

      // Add all statements to the main chunks array
      chunks.push(...tableStatements)

      // Create a single migration file for this table with all its statements
      const combinedStatement = tableStatements.join('\n\n')
      createMigrationFile(combinedStatement, `create-${t.table}-table`)
    }
  }

  // 5) Create enum types for new columns in existing tables
  const enumTypes = new Set<string>()
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    const curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const currCols = mapColumnsByName(curr.columns)

    // Check for new enum columns
    for (const colName of Object.keys(currCols)) {
      if (!prevCols[colName]) {
        const c = currCols[colName]
        if (c.type === 'enum' && c.enumValues && c.enumValues.length > 0) {
          const enumTypeName = `${c.name}_type`
          if (!enumTypes.has(enumTypeName)) {
            const createEnumStatement = driver.createEnumType(enumTypeName, c.enumValues)
            if (createEnumStatement) {
              chunks.push(createEnumStatement)
              createMigrationFile(createEnumStatement, `create-${enumTypeName}-enum`)
            }
            enumTypes.add(enumTypeName)
          }
        }
      }
    }
  }

  // 6) Existing tables -> full diffs (drops, adds, and modifications)
  // Group all changes per table into single migration files
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    const curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const currCols = mapColumnsByName(curr.columns)
    const prevIdx = mapIndexesByKey(prev.indexes)
    const currIdx = mapIndexesByKey(curr.indexes)

    // Collect all changes for this table
    const tableChanges: string[] = []
    let hasChanges = false

    // Drop removed indexes first (before dropping columns that might be indexed)
    for (const key of Object.keys(prevIdx)) {
      if (!currIdx[key]) {
        const idx = prevIdx[key]
        const dropIndexStatement = driver.dropIndex(curr.table, idx.name)
        tableChanges.push(dropIndexStatement)
        chunks.push(dropIndexStatement)
        console.log(`-- Detected dropped index: ${idx.name} from ${curr.table}`)
        hasChanges = true
      }
    }

    // Drop removed columns
    for (const colName of Object.keys(prevCols)) {
      if (!currCols[colName]) {
        const dropColumnStatement = driver.dropColumn(curr.table, colName)
        tableChanges.push(dropColumnStatement)
        chunks.push(dropColumnStatement)
        console.log(`-- Detected dropped column: ${curr.table}.${colName}`)
        hasChanges = true
      }
    }

    // Modify changed columns
    for (const colName of Object.keys(currCols)) {
      if (prevCols[colName] && currCols[colName]) {
        const prevCol = prevCols[colName]
        const currCol = currCols[colName]

        if (columnsAreDifferent(prevCol, currCol)) {
          const modifyColumnStatement = driver.modifyColumn(curr.table, currCol)
          tableChanges.push(modifyColumnStatement)
          chunks.push(modifyColumnStatement)
          console.log(`-- Detected column type change: ${curr.table}.${colName} (${prevCol.type} -> ${currCol.type})`)
          hasChanges = true
        }
      }
    }

    // Add new columns
    for (const colName of Object.keys(currCols)) {
      if (!prevCols[colName]) {
        const c = currCols[colName]
        const addColumnStatement = driver.addColumn(curr.table, c)
        tableChanges.push(addColumnStatement)
        chunks.push(addColumnStatement)
        console.log(`-- Detected new column: ${curr.table}.${c.name}`)
        hasChanges = true

        if (c.references) {
          const addFkStatement = driver.addForeignKey(curr.table, c.name, c.references.table, c.references.column)
          tableChanges.push(addFkStatement)
          chunks.push(addFkStatement)
        }
      }
    }

    // Add new indexes
    for (const key of Object.keys(currIdx)) {
      if (!prevIdx[key]) {
        const idx = currIdx[key]
        const createIndexStatement = driver.createIndex(curr.table, idx)
        tableChanges.push(createIndexStatement)
        chunks.push(createIndexStatement)
        console.log(`-- Detected new index: ${idx.name} in ${curr.table}`)
        hasChanges = true
      }
    }

    // Create a single migration file with all changes for this table
    if (hasChanges) {
      const combinedStatement = tableChanges.join('\n\n')
      createMigrationFile(combinedStatement, `alter-${curr.table}-table`)
    }
  }

  // Show summary message
  const totalChanges = migrationsCreatedCount + migrationsUpdatedCount
  if (totalChanges === 0) {
    console.log('-- Nothing to migrate')
  }
  else {
    const parts: string[] = []
    if (migrationsCreatedCount > 0)
      parts.push(`${migrationsCreatedCount} created`)
    if (migrationsUpdatedCount > 0)
      parts.push(`${migrationsUpdatedCount} updated`)
    console.log(`-- Migration files: ${parts.join(', ')}`)
  }

  if (chunks.length === 0)
    return ['-- No changes detected']

  return chunks
}
