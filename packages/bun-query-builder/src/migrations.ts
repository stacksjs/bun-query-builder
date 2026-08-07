import type { ForeignKeyConfig, ModelRecord, OnForeignKeyAction } from './schema'
import { qualifiedIndexName } from './drivers/index-name'
import { normalizeRelationList } from './relation-utils'
import { singularizerFor, tableNameFor } from './inflect'
import type { SupportedDialect } from './types'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { config } from './config'
import { getDialectDriver } from './drivers'
import { isNumericPlanType } from './drivers/sqlite'
import { buildSchemaMeta } from './meta'
import { getSqlDirectory } from './workspace'

/**
 * Informational stdout line — printed only when the active config has
 * `verbose: true`. Same gate as the `info()` helper in
 * `actions/migrate.ts`; kept duplicated rather than shared to avoid a
 * cross-file import cycle through the action layer.
 */
function info(message: string): void {
  if (config.verbose) console.log(message)
}

/**
 * Convert a camelCase or PascalCase string to snake_case
 * Examples:
 *   companyName -> company_name
 *   billingEmail -> billing_email
 *   isPersonal -> is_personal
 *   createdAt -> created_at
 *   HTMLParser -> html_parser
 *   p256dh     -> p256dh      (one token, not two)
 *   sha256Sum  -> sha256_sum  (a real boundary, on the case change)
 */
function snakeCase(str: string): string {
  return str
    // Handle acronyms and consecutive uppercase letters
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Handle transition from lowercase to uppercase. This already covers every
    // digit-then-uppercase case, which is the only place a digit is next to a
    // word boundary.
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    // There used to be a third rule here: `.replace(/(\d)([A-Z])/gi, …)`. The
    // `i` flag made it match a digit followed by a *lowercase* letter, which is
    // never a boundary - `p256dh` is one token, the name the Push API gives a
    // subscription key, and it came out as `p256_dh`. An application's model
    // said `p256dh`, the generated migration said `p256_dh`, and the query that
    // read it back found nothing. Both spellings look plausible and the failure
    // is an empty result rather than an error.
    //
    // Without the flag the rule was redundant with the one above it, so it is
    // gone rather than corrected.
    .toLowerCase()
}

/**
 * Singularize a TABLE name for pivot/FK derivation, honoring
 * `relations.singularizeStrategy`. Must stay in lockstep with the resolver in
 * pivot.ts — the migration emits the columns those resolvers query.
 */
function singularizeTable(table: string): string {
  return singularizerFor(config.relations?.singularizeStrategy)(table)
}

let migrationCounter = 0
let migrationsCreatedCount = 0
let migrationsUpdatedCount = 0
let useDeterministicNames = true
/**
 * Names of the files the current generate run wrote.
 *
 * A caller that also APPLIES the SQL needs to know exactly which files it has
 * just executed, so the on-disk corpus and the database's migration ledger do
 * not disagree — otherwise the runner replays what was already applied and
 * dies on `duplicate column name`.
 */
let createdMigrationFiles: string[] = []
/**
 * Bodies of the migrations already on disk, resolved lazily once per generate
 * run and added to as that run writes more. Null between runs so a corpus
 * changed by anything else is re-read rather than remembered.
 */
let existingCorpusBodies: Set<string> | null = null

/** The files written by the most recent generate run, in creation order. */
export function lastCreatedMigrationFiles(): string[] {
  return [...createdMigrationFiles]
}

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
  const sqlDir = getSqlDirectory(workspaceRoot, config.migrationDir)
  if (!existsSync(sqlDir)) {
    mkdirSync(sqlDir, { recursive: true })
    info(`-- Created SQL directory: ${sqlDir}`)
  }
  return sqlDir
}

/**
 * Header stamped onto every migration file this generator writes.
 *
 * Provenance, not decoration. The runner treats generated ALTER migrations as
 * transient — replayed rather than recorded, and deleted once applied — and it
 * used to decide that from the FILENAME. A hand-written
 * `0000000131-alter-farms-table.sql` is a perfectly natural name for a person
 * to choose, and it was deleted off their disk the first time they migrated.
 * A marker the generator writes and a human does not is the only signal that
 * actually distinguishes the two.
 *
 * Files without it are treated as authored, which is the safe reading: they
 * are recorded, run once, and never removed.
 */
export const GENERATED_MARKER = '-- qb:generated'

/** True when this SQL was written by the generator rather than by a person. */
export function isGeneratedMigrationSql(sql: string): boolean {
  return sql.trimStart().startsWith(GENERATED_MARKER)
}

/**
 * The comparable body of a migration: its statements, with the provenance
 * header, comments and whitespace taken out. Two files with the same body do
 * the same thing to the schema, whatever they are called.
 */
export function migrationBody(sql: string): string {
  return sql
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
}

/**
 * Statements already present in the migration corpus, by body.
 *
 * Rebuilt per generate run rather than cached across runs: a corpus is a
 * directory on disk that another process — or the same one, earlier in this
 * command — may have just written to.
 */
function existingMigrationBodies(sqlDir: string): Set<string> {
  const bodies = new Set<string>()
  let files: string[]
  try {
    files = readdirSync(sqlDir).filter(f => f.endsWith('.sql'))
  }
  catch {
    return bodies
  }

  for (const file of files) {
    try {
      bodies.add(migrationBody(readFileSync(join(sqlDir, file), 'utf8')))
    }
    catch {
      // Unreadable file: it cannot be compared against, so it cannot suppress
      // a write. Better a duplicate the operator can see than a change lost.
    }
  }

  return bodies
}

function createMigrationFile(statement: string, fileName: string): boolean {
  if (!statement)
    return false

  const sqlDir = ensureSqlDirectory()

  /*
   * Never write a statement the corpus already carries.
   *
   * Migrations are permanent now, so a duplicate is not noise — it is the
   * same schema change queued to run twice, which on the next machine is an
   * `ADD COLUMN` that fails as a duplicate and takes the run down with it.
   * The diff recomputes changes it has already emitted whenever the snapshot
   * is missing (fresh checkout, cleared cache, `--from-db`), and that is
   * precisely when this matters.
   *
   * Compared by body rather than by filename, because the generator stamps
   * ALTER files with a timestamp: the same change emitted twice gets two
   * different names and only the SQL gives it away.
   */
  if (existingCorpusBodies === null)
    existingCorpusBodies = existingMigrationBodies(sqlDir)

  const body = migrationBody(statement)
  if (body.length > 0 && existingCorpusBodies.has(body)) {
    info(`-- Migration already in the corpus, not writing it again: ${fileName}`)
    return false
  }

  migrationCounter++

  // For framework/fresh migrations: use deterministic zero-padded sequence numbers
  // so the same models always produce the same filenames (clean git diffs).
  // For user diff migrations: use timestamps since they're additive/incremental.
  let sequence = useDeterministicNames
    ? String(migrationCounter).padStart(10, '0')
    : String(Math.floor(Date.now() / 1000) + migrationCounter)

  let fullFileName = `${sequence}-${fileName}.sql`

  /*
   * A timestamped name has to be free before we take it.
   *
   * The sequence is `unix seconds + counter`, and the counter resets every
   * run — so two changes migrated within the same second produced the SAME
   * filename, and the second silently overwrote the first. Both changes were
   * lost at once: the overwritten migration was gone from the corpus, and the
   * survivor inherited a name the migrations table had already recorded as
   * executed, so it never ran either. Walk forward to the first free name,
   * which also keeps the corpus in ascending order.
   *
   * Deterministic names are exempt on purpose: that path regenerates a whole
   * framework corpus and overwriting the previous copy is the point.
   */
  if (!useDeterministicNames) {
    let next = Number(sequence)
    while (existsSync(join(sqlDir, fullFileName))) {
      next += 1
      sequence = String(next)
      fullFileName = `${sequence}-${fileName}.sql`
    }
  }

  const filePath = join(sqlDir, fullFileName)

  writeFileSync(filePath, `${GENERATED_MARKER}\n${statement}`)
  info(`-- Migration file created: ${fullFileName}`)
  migrationsCreatedCount++
  createdMigrationFiles.push(fullFileName)
  // Two identical statements inside ONE run must not both be written either.
  existingCorpusBodies?.add(body)
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
  | 'timestamptz'
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
  references?: {
    table: string
    column: string
    onDelete?: OnForeignKeyAction
    onUpdate?: OnForeignKeyAction
    /** Physical names discovered from a live database; models leave this unset. */
    constraintNames?: string[]
  }
  enumValues?: string[]
  /**
   * Explicit max length for `string` columns, taken from the model's
   * `.max(n)` / `.maxLength(n)` validation rule. Drivers emit `varchar(n)`
   * instead of the default `varchar(255)`, so tight columns (2-char country
   * codes, 32-char hash ids) don't reserve 255 — this shrinks storage and, on
   * a columnstore, the bytes scanned per row. Ignored for non-string types and
   * when unset (falls back to 255). Bounded values through 767 characters are
   * preserved as `varchar(n)`: that covers indexable UTF-8 identifiers such as
   * the RFC mailbox maximum of 320 characters while staying within MySQL 8's
   * 3072-byte single-key limit under utf8mb4. Larger values become `text`.
   */
  maxLength?: number
  /**
   * Fully-qualified enum type name for Postgres named enum types. Stamped by
   * the migration generator as `<table>_<column>_type` so the same enum
   * column name in different tables (e.g. `status` on monitors vs incidents,
   * which carry different value sets) does not collide in Postgres's global
   * type namespace. SQLite/MySQL render enums inline and ignore this.
   */
  enumTypeName?: string
}

export interface IndexPlan {
  name: string
  columns: string[]
  type: 'index' | 'unique'
  /**
   * Partial-index predicate (`CREATE [UNIQUE] INDEX ... WHERE <expr>`).
   * Postgres + SQLite support this; MySQL does not — `mysql` driver throws
   * at migration generation if set.
   */
  where?: string
}

export interface TablePlan {
  table: string
  columns: ColumnPlan[]
  indexes: IndexPlan[]
  /**
   * SingleStore distributed-table metadata (ignored by every other dialect's
   * driver). SingleStore hash-partitions rows across leaf nodes by the
   * `shardKey` columns; `sortKey` sets the columnstore sort order; `tableKind`
   * chooses the storage engine. Populated from the model's `shardKey` /
   * `sortKey` / `tableKind` options by `buildMigrationPlan`. When omitted,
   * SingleStore falls back to sharding on the primary key (or a random key for
   * columnstore), so plain MySQL-shaped DDL still works.
   */
  shardKey?: string[]
  sortKey?: string[]
  tableKind?: 'rowstore' | 'columnstore' | 'reference'
}

export interface MigrationPlan {
  dialect: SupportedDialect
  /** Captured in the plan so Vitess DDL does not depend on mutable global config. */
  vitessSharded?: boolean
  tables: TablePlan[]
}

/**
 * Inputs for a SQLite table rebuild ("12-step recreate"). SQLite can't
 * `ALTER COLUMN` to change a type, and can't `DROP COLUMN` when the column
 * is a PK / unique / indexed / FK target. The fix is to create a new table
 * with the desired schema, copy data across, drop the old table, and rename
 * the new one into place. See `SQLiteDriver.rebuildTable`.
 */
export interface RebuildTableSpec {
  /** The full desired schema of the table after the change. */
  target: TablePlan
  /** Temp table name to build under, e.g. `_qb_tmp_<table>` (collision-checked). */
  tempName: string
  /**
   * Maps a TARGET column name -> the OLD column name it is populated from.
   * - same key/value => column carried over unchanged
   * - value differs from key => a rename (old name -> new target name)
   * - key omitted entirely => a brand-new column (gets its DEFAULT / NULL)
   * A dropped column simply never appears as a value, so its data is discarded.
   */
  columnSource: Record<string, string>
}

/** The kind of schema change a single migration operation represents. */
export type MigrationOpKind =
  | 'create_table'
  | 'drop_table'
  | 'rename_table'
  | 'add_column'
  | 'drop_column'
  | 'modify_column'
  | 'rename_column'
  | 'create_index'
  | 'drop_index'
  | 'add_foreign_key'
  | 'rebuild_table'
  | 'create_enum'

/**
 * A structured description of one change emitted by the diff engine. Callers
 * (e.g. the Stacks `buddy migrate` command) inspect these to gate destructive
 * changes behind confirmation and to surface rename candidates, instead of
 * re-parsing the raw SQL strings.
 */
export interface MigrationOperation {
  kind: MigrationOpKind
  table: string
  column?: string
  /** For renames: the previous identifier. */
  from?: string
  /** For renames: the new identifier. */
  to?: string
  /** True when the op can lose data (drop column/table, lossy type change/rebuild). */
  destructive: boolean
  /** For rename candidates: how confident the heuristic is. */
  confidence?: 'high' | 'low'
  /** The SQL this op emits (joined when an op maps to multiple statements). */
  sql: string
}

/**
 * Whether changing a normalized physical type can preserve every existing
 * value. Keep this deliberately conservative: integer-to-bigint widens the
 * numeric range, and varchar-to-text removes a length ceiling. The reverse
 * directions remain destructive and still require explicit confirmation.
 */
export function isLosslessTypeChange(from: NormalizedColumnType, to: NormalizedColumnType): boolean {
  return (from === 'integer' && to === 'bigint')
    || (from === 'string' && to === 'text')
}

/** Result of {@link generateDiffOperations}: raw statements + structured ops. */
export interface DiffResult {
  statements: string[]
  operations: MigrationOperation[]
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
    const possibleValues = ruleObj.allowedValues || ruleObj.enumValues || ruleObj._values || ruleObj.values
    if (Array.isArray(possibleValues) && possibleValues.length > 0) {
      return possibleValues.map((v: any) => String(v))
    }
  }

  return undefined
}

/**
 * Extract the max value from a validation rule's rules array.
 * Supports formats: { name: 'max', params: { max: 500 } }, { name: 'max', args: [500] }, etc.
 */
function extractMaxFromRules(ruleObj: any): number | undefined {
  if (!ruleObj?.rules || !Array.isArray(ruleObj.rules))
    return undefined

  for (const r of ruleObj.rules) {
    if (r?.name === 'max' || r?.name === 'maxLength') {
      if (r.params && typeof r.params.max === 'number')
        return r.params.max
      if (Array.isArray(r.args) && typeof r.args[0] === 'number')
        return r.args[0]
      if (typeof r.value === 'number')
        return r.value
      if (typeof r.expectedValue === 'number')
        return r.expectedValue
    }
  }

  return undefined
}

const MAX_BOUNDED_VARCHAR_LENGTH = 767

function detectTypeFromValidationRule(rule: unknown): NormalizedColumnType | undefined {
  if (!rule || typeof rule !== 'object')
    return undefined

  const ruleObj = rule as any

  // Check the name property which often indicates the validation type
  if (ruleObj.name) {
    const name = String(ruleObj.name).toLowerCase()

    switch (name) {
      case 'string':
      case 'text': {
        // Keep indexable bounded identifiers as varchar(n). Larger content
        // belongs in TEXT so it does not consume the MySQL row-size budget.
        const maxValue = extractMaxFromRules(ruleObj)
        return maxValue && maxValue > MAX_BOUNDED_VARCHAR_LENGTH ? 'text' : 'string'
      }
      case 'integer':
      case 'int':
        return 'integer'
      case 'bigint':
        return 'bigint'
      case 'float':
        return 'float'
      case 'number':
        return 'integer'
      case 'double':
        return 'double'
      case 'decimal':
        return 'decimal'
      case 'boolean':
      case 'bool':
        return 'boolean'
      case 'date':
        return 'date'
      case 'datetime':
      case 'timestamp':
        return 'datetime'
      case 'timestamptz':
      case 'timestamp_tz':
        return 'timestamptz'
      case 'json':
        return 'json'
      case 'enum':
        return 'enum'
    }
  }

  // Check for type property
  if (ruleObj.type) {
    const type = String(ruleObj.type).toLowerCase()
    if (type === 'string' || type === 'text')
      return 'string'
    if (type === 'integer' || type === 'int')
      return 'integer'
    if (type === 'bigint')
      return 'bigint'
    if (type === 'float')
      return 'float'
    if (type === 'number')
      return 'integer'
    if (type === 'boolean')
      return 'boolean'
    if (type === 'date')
      return 'date'
    if (type === 'datetime')
      return 'datetime'
    if (type === 'timestamptz' || type === 'timestamp_tz')
      return 'timestamptz'
    if (type === 'json')
      return 'json'
  }

  return undefined
}

function normalizeAttributeType(value: unknown): NormalizedColumnType | undefined {
  if (typeof value !== 'string')
    return undefined
  const type = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  switch (type) {
    case 'varchar':
    case 'string': return 'string'
    case 'text': return 'text'
    case 'bool':
    case 'boolean': return 'boolean'
    case 'int':
    case 'integer': return 'integer'
    case 'bigint': return 'bigint'
    case 'float': return 'float'
    case 'double': return 'double'
    case 'number':
    case 'numeric':
    case 'decimal': return 'decimal'
    case 'date': return 'date'
    case 'datetime':
    case 'timestamp': return 'datetime'
    case 'timestamp_tz':
    case 'timestamptz':
    case 'timestamp_with_time_zone': return 'timestamptz'
    case 'json':
    case 'jsonb': return 'json'
    case 'enum': return 'enum'
    default: return undefined
  }
}

export interface InferenceOptions {
  dialect: SupportedDialect
  vitessSharded?: boolean
}

export function buildMigrationPlan(models: ModelRecord, options: InferenceOptions): MigrationPlan {
  const meta = buildSchemaMeta(models)
  const tables: TablePlan[] = []

  for (const modelName of Object.keys(models)) {
    const model = models[modelName]
    const table = tableNameFor(model)
    const primaryKey = model.primaryKey ?? 'id'
    const _autoIncrement = model.autoIncrement !== false // default to true
    const attrs = model.attributes ?? {}

    const columns: ColumnPlan[] = []
    const indexes: IndexPlan[] = []

    // Always add the primary key column first (if not already in attributes)
    // This ensures every table has an id column by default
    if (!attrs[primaryKey]) {
      columns.push({
        name: snakeCase(primaryKey),
        type: 'bigint',
        isPrimaryKey: true,
        isUnique: false,
        isNullable: false,
        hasDefault: false,
      })
    }

    // Foreign keys a `belongsTo` pins to a column name, so a declared attribute
    // is resolved against what the model SAYS it points at rather than what its
    // column name looks like. `author_id` reads as the `Author` model under the
    // name heuristic below; a model that declares
    // `belongsTo: [{ model: 'User', foreignKey: 'author_id' }]` means users,
    // and the constraint has to agree or every insert is rejected.
    const declaredFkTargets = new Map<string, { table: string, onDelete?: OnForeignKeyAction }>()
    // Whether this model documents its relationships at all. A model that does
    // is taken at its word; one that does not falls back to convention.
    const declaresBelongsTo = normalizeRelationList(model.belongsTo).length > 0

    // Columns that are one half of a polymorphic pair.
    //
    // `commentable_id` alongside `commentable_type` means the row points at one
    // of several tables, chosen per row. No foreign key can express that: the
    // constraint would name a single table and reject every row pointing at any
    // other one. So a `_id` column with a matching `_type` beside it never gets
    // a foreign key, whether it was declared or merely inferred - there is no
    // spelling of the relationship that would make the constraint correct.
    const columnNames = new Set(Object.keys(attrs).map(name => snakeCase(name)))
    const polymorphicColumns = new Set<string>()
    for (const column of columnNames) {
      if (!column.endsWith('_type')) continue
      const idColumn = `${column.slice(0, -'_type'.length)}_id`
      if (columnNames.has(idColumn))
        polymorphicColumns.add(idColumn)
    }
    for (const rel of normalizeRelationList(model.belongsTo)) {
      const column = rel.foreignKey ?? `${snakeCase(rel.model)}_id`
      const table = meta.modelToTable[rel.model]
      if (table)
        declaredFkTargets.set(column, { table, onDelete: rel.onDelete })
    }

    for (const attrName of Object.keys(attrs)) {
      const attr = attrs[attrName]

      // Convert attribute name to snake_case for database column
      const columnName = snakeCase(attrName)

      // Models are the schema source of truth, so nullability must follow the
      // attribute instead of silently making every non-PK column nullable.
      // `nullable` is the explicit database override; otherwise top-level
      // `required` wins, then validator metadata such as schema.*.required().
      const validatorRequired = Boolean((attr.validation?.rule as any)?.isRequired)
      const isNullable = attrName === primaryKey
        ? false
        : (attr.nullable ?? !(attr.required ?? validatorRequired))

      // Type inference heuristics
      let inferred: NormalizedColumnType | undefined
      let enumValues: string[] | undefined
      const isPk = attrName === primaryKey

      // Priority 1: an explicit model column type, then validator inference.
      // A generic `type: 'string'` still needs its validator width: otherwise
      // `.max(16_000)` silently becomes varchar(255) and valid model data is
      // truncated by MySQL/Vitess. Explicit `text` remains authoritative.
      inferred = normalizeAttributeType(attr.type) ?? detectTypeFromValidationRule(attr.validation?.rule)
      if (inferred === 'string') {
        const maxLength = extractMaxFromRules(attr.validation?.rule)
        if (maxLength && maxLength > MAX_BOUNDED_VARCHAR_LENGTH)
          inferred = 'text'
      }

      // Priority 2: Check for enum validation rule (or extract enum values if type is enum)
      if (!inferred || inferred === 'enum') {
        const enumVals = detectEnumFromValidationRule(attr.validation?.rule)
        if (enumVals && enumVals.length > 0) {
          inferred = 'enum'
          enumValues = enumVals
        }
      }

      // Priority 3: Guess from column name patterns (use snake_case column name)
      if (!inferred) {
        inferred = guessTypeFromName(columnName)
      }

      // Priority 4: Infer from default value type
      if (!inferred) {
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

      // Final fallback - primary keys should be integers, others default to string
      if (!inferred) {
        inferred = isPk ? 'bigint' : 'string'
      }

      // For a bounded string, carry the max length so drivers can emit
      // varchar(n) instead of varchar(255). Only meaningful when ≤ 767 —
      // larger maxes were already promoted to `text` above.
      const maxLen = inferred === 'string' ? extractMaxFromRules(attr.validation?.rule) : undefined

      const col: ColumnPlan = {
        name: columnName,
        type: inferred,
        isPrimaryKey: isPk,
        isUnique: Boolean(attr.unique),
        isNullable,
        hasDefault: typeof attr.default !== 'undefined',
        defaultValue: normalizeDefaultValue(attr.default),
        enumValues,
        maxLength: typeof maxLen === 'number' && maxLen > 0 && maxLen <= MAX_BOUNDED_VARCHAR_LENGTH ? maxLen : undefined,
      }

      // Foreign key inference for *_id columns
      // Infer FK when:
      //   1. foreignKey is an explicit ForeignKeyConfig object, OR
      //   2. foreignKey is explicitly true, OR
      //   3. The model declares a belongsTo relationship matching the inferred model name, OR
      //   4. A model with the inferred name exists in the models record (convention-based)
      // Skip when foreignKey is explicitly false
      if (columnName.endsWith('_id') && attr.foreignKey !== false && !polymorphicColumns.has(columnName)) {
        if (typeof attr.foreignKey === 'object' && attr.foreignKey !== null) {
          // Explicit FK config — use it directly
          const fkConfig = attr.foreignKey as ForeignKeyConfig
          col.references = {
            table: fkConfig.table,
            column: fkConfig.column ?? 'id',
            onDelete: fkConfig.onDelete,
            onUpdate: fkConfig.onUpdate,
          }
          if (fkConfig.nullable !== undefined)
            col.isNullable = fkConfig.nullable
        }
        else {
          const declared = declaredFkTargets.get(columnName)
          const base = columnName.replace(/_id$/, '')
          // Try PascalCase first (user_id -> User), then try camelCase variants
          const maybeModel = base.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())

          // What the model declares wins over what the column name suggests.
          //
          // And when a model documents its belongsTo relationships at all, that
          // list is the answer: a `_id` column missing from it is not a foreign
          // key, it is a column that happens to end in `_id`. Guessing anyway
          // reaches across domains - an `author_id` meaning a forge user
          // resolves to a CMS `authors` table simply because some other model
          // in the app is called Author, and the result is a constraint against
          // the wrong table, or against one that does not exist.
          //
          // Convention still applies to models that declare nothing, which is
          // the case the inference was written for.
          const refTable = declared?.table ?? (declaresBelongsTo ? undefined : meta.modelToTable[maybeModel])
          if (refTable) {
            // When the referenced model exists in the schema, auto-infer FK.
            //
            // `onDelete` comes from the relation, and it has to: declaring the
            // column in `attributes` is the normal way to give it a validation
            // rule or a name, and it used to cost the relation its ON DELETE
            // silently. The same model declaring the same `belongsTo` got a
            // cascade or did not depending on whether its foreign key column
            // was also written down as an attribute, which is not a
            // distinction anybody would expect to matter.
            const refPk = meta.primaryKeys[refTable] ?? 'id'
            col.references = { table: refTable, column: refPk, onDelete: declared?.onDelete }
          }
        }
      }

      columns.push(col)
    }

    // Auto-generate FK columns from belongsTo relationships
    // If a model declares belongsTo: ['Order', 'Customer'], automatically add
    // order_id and customer_id columns with FK constraints (unless already defined in attributes)
    const belongsToRelations = normalizeRelationList(model.belongsTo)
    for (const rel of belongsToRelations) {
      // Object form may pin a custom FK column name; otherwise use convention.
      const fkColumnName = rel.foreignKey ?? `${snakeCase(rel.model)}_id`

      // Skip if the column was already defined in attributes
      if (columns.some(c => c.name === fkColumnName))
        continue

      // The target model may not be in the loaded set: a models directory is
      // frequently a subset of the schema (framework tables, another app
      // sharing the database, a relation that points at a model living
      // elsewhere). That costs us the CONSTRAINT, but it must not cost us the
      // COLUMN — the ORM writes `<model>_id` on every belongsTo regardless, so
      // omitting it produced a CREATE TABLE the ORM could not insert into, and
      // made the differ read the live column as a stray and propose dropping
      // it on every run.
      const refTable = meta.modelToTable[rel.model]
      const refPk = refTable ? (meta.primaryKeys[refTable] ?? 'id') : undefined

      columns.push({
        name: fkColumnName,
        type: 'bigint',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: true,
        hasDefault: false,
        // Carry the declared ON DELETE so the FK constraint (inline for
        // SQLite, ALTER TABLE for MySQL/Postgres) enforces it.
        references: refTable && refPk && !polymorphicColumns.has(fkColumnName)
          ? { table: refTable, column: refPk, onDelete: rel.onDelete }
          : undefined,
      })
    }

    // Handle useTimestamps trait - add created_at and updated_at columns
    const traits = model.traits as Record<string, any> | undefined
    const useTimestamps = traits?.useTimestamps ?? traits?.timestampable ?? false
    if (useTimestamps) {
      // Add created_at column if not already present
      if (!columns.some(c => c.name === 'created_at')) {
        columns.push({
          name: 'created_at',
          type: 'datetime',
          isPrimaryKey: false,
          isUnique: false,
          isNullable: false,
          hasDefault: true,
          defaultValue: 'CURRENT_TIMESTAMP' as any,
        })
      }
      // Add updated_at column if not already present
      if (!columns.some(c => c.name === 'updated_at')) {
        columns.push({
          name: 'updated_at',
          type: 'datetime',
          isPrimaryKey: false,
          isUnique: false,
          isNullable: true,
          hasDefault: false,
        })
      }
    }

    // Handle useSoftDeletes trait - add deleted_at column
    const useSoftDeletes = traits?.useSoftDeletes ?? traits?.softDeletable ?? false
    if (useSoftDeletes) {
      if (!columns.some(c => c.name === 'deleted_at')) {
        columns.push({
          name: 'deleted_at',
          type: 'datetime',
          isPrimaryKey: false,
          isUnique: false,
          isNullable: true,
          hasDefault: false,
        })
      }
    }

    // Handle useUuid trait - add uuid column (nullable unique string). The
    // ORM auto-populates it on create() for models with this trait, so the
    // generated schema must have the column.
    const useUuid = traits?.useUuid ?? false
    if (useUuid) {
      if (!columns.some(c => c.name === 'uuid')) {
        columns.push({
          name: 'uuid',
          type: 'string',
          isPrimaryKey: false,
          isUnique: true,
          isNullable: true,
          hasDefault: false,
        })
      }
    }

    // Composite indexes from model definition — honor the optional `unique`
    // and `where` (partial index) flags from the schema-level CompositeIndex.
    for (const idx of (model.indexes ?? [])) {
      indexes.push({
        name: idx.name,
        columns: idx.columns.map((c: string) => snakeCase(c)),
        type: idx.unique ? 'unique' : 'index',
        where: idx.where,
      })
    }

    // Unique single-column indexes from attribute flags
    for (const c of columns) {
      if (c.isUnique && !c.isPrimaryKey)
        indexes.push({ name: `${table}_${c.name}_unique`, columns: [c.name], type: 'unique' })
    }

    // SingleStore distributed-table hints (no-ops on other dialects). Column
    // names are snake_cased to match the emitted schema.
    const shardKey = Array.isArray(model.shardKey) ? (model.shardKey as string[]).map(snakeCase) : undefined
    const sortKey = Array.isArray(model.sortKey) ? (model.sortKey as string[]).map(snakeCase) : undefined
    const tableKind = model.tableKind as TablePlan['tableKind']

    tables.push({ table, columns, indexes, shardKey, sortKey, tableKind })
  }

  // Trait-driven shared/per-model pivot tables. The likeable, taggable, and
  // categorizable traits all read/write to canonical pivot tables that the
  // framework expects to exist. Auto-emit them whenever any model declares
  // the corresponding trait, so `_likeable.like()` / `_taggable.addTag()` /
  // `_categorizable.addCategory()` work right after migrate:fresh.
  const seenTables = new Set(tables.map(t => t.table))
  function ensureTable(plan: TablePlan) {
    if (!seenTables.has(plan.table)) {
      seenTables.add(plan.table)
      tables.push(plan)
    }
  }

  for (const modelName of Object.keys(models)) {
    const model = models[modelName] as any
    const traits = (model?.traits ?? {}) as Record<string, any>
    const modelTable = tableNameFor(model)
    const singular = singularizeTable(modelTable)

    // likeable → per-model `<table>_likes` pivot keyed by user_id + <model>_id
    if (traits.likeable) {
      const opts = typeof traits.likeable === 'object' ? traits.likeable as { table?: string, foreignKey?: string } : {}
      const likeTable = opts.table || `${modelTable}_likes`
      const fk = opts.foreignKey || `${singular}_id`
      ensureTable({
        table: likeTable,
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'user_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: 'users', column: 'id' } },
          { name: fk, type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: modelTable, column: 'id' } },
          { name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any },
          { name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [{ name: `${likeTable}_user_target_unique`, columns: ['user_id', fk], type: 'unique' }],
      })
    }

    // taggable → canonical `taggables` records plus the polymorphic pivot.
    // The runtime ORM and CMS packages both read the plural record table, and
    // CMS post sync stores links in `taggable_models`. Keeping both plans here
    // makes a generated schema match the relation APIs it is meant to serve.
    if (traits.taggable) {
      ensureTable({
        table: 'taggables',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'name', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'slug', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'description', type: 'text', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
          { name: 'order', type: 'integer', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 0 as any },
          { name: 'is_active', type: 'boolean', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: true as any },
          { name: 'taggable_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
          { name: 'taggable_type', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any },
          { name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [
          { name: 'taggables_target_index', columns: ['taggable_id', 'taggable_type'], type: 'index' },
          { name: 'taggables_type_slug_unique', columns: ['taggable_type', 'slug'], type: 'unique' },
        ],
      })
      ensureTable({
        table: 'taggable_models',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'tag_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: 'taggables', column: 'id' } },
          { name: 'taggable_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'taggable_type', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any },
          { name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [
          { name: 'taggable_models_owner_unique', columns: ['tag_id', 'taggable_id', 'taggable_type'], type: 'unique' },
          { name: 'taggable_models_target_index', columns: ['taggable_id', 'taggable_type'], type: 'index' },
        ],
      })
    }

    // categorizable → canonical `categorizables` records plus the polymorphic pivot.
    if (traits.categorizable) {
      ensureTable({
        table: 'categorizables',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'name', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'slug', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'description', type: 'text', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
          { name: 'is_active', type: 'boolean', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: true as any },
          { name: 'categorizable_type', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any },
          { name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [{ name: 'categorizables_type_slug_unique', columns: ['categorizable_type', 'slug'], type: 'unique' }],
      })
      ensureTable({
        table: 'categorizable_models',
        columns: [
          { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'category_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: { table: 'categorizables', column: 'id' } },
          { name: 'categorizable_id', type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'categorizable_type', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false },
          { name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any },
          { name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false },
        ],
        indexes: [
          { name: 'categorizable_models_owner_unique', columns: ['category_id', 'categorizable_id', 'categorizable_type'], type: 'unique' },
          { name: 'categorizable_models_target_index', columns: ['categorizable_id', 'categorizable_type'], type: 'index' },
        ],
      })
    }
  }

  // Option A: inline `belongsToMany: { rel: { model, pivot: { columns, ... } } }`
  // emits a dedicated pivot table when no `through:` model is present (Option B
  // pivots are full models and emit themselves through the main loop above).
  for (const modelName of Object.keys(models)) {
    const model = models[modelName] as any
    const btm = model?.belongsToMany
    if (!btm || typeof btm !== 'object' || Array.isArray(btm)) continue
    const parentTable = tableNameFor(model)
    const parentSingular = singularizeTable(parentTable)

    for (const [relKey, value] of Object.entries(btm)) {
      const cfg = value as any
      if (!cfg || typeof cfg !== 'object') continue
      // Option B (`through:`) is a real model and emits via the main loop.
      if (cfg.through) continue
      // Skip when the user hasn't declared any pivot metadata — preserves the
      // legacy behavior where pivot tables are user-managed.
      const pivotCfg = cfg.pivot as { columns?: Record<string, any>, timestamps?: boolean, uniques?: string[][] } | undefined
      if (!pivotCfg || (!pivotCfg.columns && !pivotCfg.timestamps && !pivotCfg.uniques)) continue

      const relatedModelName = cfg.model as string
      const relatedRaw = models[relatedModelName] as any
      const relatedTable = (relatedRaw?.table as string) || `${String(relatedModelName).toLowerCase()}s`
      const relatedSingular = singularizeTable(relatedTable)
      const pivotTable = (cfg.table as string) || [parentSingular, relatedSingular].sort().join('_')
      const fkParent = (cfg.foreignKey as string) || `${parentSingular}_id`
      const fkRelated = (cfg.relatedKey as string) || `${relatedSingular}_id`

      // A pivot column with a `_type` sibling is polymorphic, exactly as in the
      // main loop: `taggable_id` beside `taggable_type` points at whichever
      // table that row's type names, so no single-table constraint can be
      // right. The pivot builder used to reference the related model's table
      // regardless, which produced a foreign key against whatever the `_type`
      // column happened to default to - and then rejected every row tagging
      // anything else.
      const pivotColumnNames = new Set<string>([fkParent, fkRelated, ...Object.keys(pivotCfg.columns ?? {})])
      const pivotPolymorphic = new Set<string>()
      for (const column of pivotColumnNames) {
        if (!column.endsWith('_type')) continue
        const idColumn = `${column.slice(0, -'_type'.length)}_id`
        if (pivotColumnNames.has(idColumn))
          pivotPolymorphic.add(idColumn)
      }

      const referenceTo = (column: string, table: string) =>
        pivotPolymorphic.has(column) ? undefined : { table, column: 'id' }

      const cols: ColumnPlan[] = [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: fkParent, type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: referenceTo(fkParent, parentTable) },
        { name: fkRelated, type: 'bigint', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, references: referenceTo(fkRelated, relatedTable) },
      ]
      if (pivotCfg.columns) {
        for (const [name, attr] of Object.entries(pivotCfg.columns)) {
          const a = attr as any
          const colType: NormalizedColumnType = guessTypeFromName(name) ?? 'string'
          cols.push({
            name,
            type: colType,
            isPrimaryKey: false,
            isUnique: false,
            isNullable: a?.nullable ?? false,
            hasDefault: a?.default !== undefined,
            defaultValue: a?.default,
          })
        }
      }
      if (pivotCfg.timestamps) {
        cols.push({ name: 'created_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: true, defaultValue: 'CURRENT_TIMESTAMP' as any })
        cols.push({ name: 'updated_at', type: 'datetime', isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false })
      }

      const idx: IndexPlan[] = []
      // Default uniqueness on (parent_fk, related_fk) — overridden by explicit uniques.
      const declaredUniques = pivotCfg.uniques && pivotCfg.uniques.length > 0
        ? pivotCfg.uniques
        : [[fkParent, fkRelated]]
      for (let i = 0; i < declaredUniques.length; i++) {
        const u = declaredUniques[i]
        idx.push({
          name: `${pivotTable}_${u.join('_')}_unique${i > 0 ? `_${i}` : ''}`,
          columns: [...u],
          type: 'unique',
        })
      }

      // Don't override an existing model with the same table name (e.g.
      // someone declared the pivot as a real model AND inline — through-form
      // wins via the earlier `continue`, this branch is a safety net).
      ensureTable({ table: pivotTable, columns: cols, indexes: idx })
      // Avoid silently overriding a relKey-keyed name conflict across two
      // parents declaring the same pivot — `ensureTable` is idempotent on
      // table name, so the second declaration is dropped. (Acceptable: both
      // sides typically declare the same pivot.)
      void relKey
    }
  }

  // A foreign-key column must use the same physical storage type as the
  // referenced column. Model attributes often validate identifiers with the
  // generic number validator, which infers INTEGER even though Stacks' default
  // primary key is BIGINT. SQLite tolerates that mismatch; MySQL and Vitess
  // reject the constraint. Once both tables are present in the plan, the
  // referenced column is the authoritative type source.
  const tablesByName = new Map(tables.map(table => [table.table, table]))
  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.references)
        continue
      const referenced = tablesByName
        .get(column.references.table)
        ?.columns.find(candidate => candidate.name === column.references!.column)
      if (!referenced || column.type === referenced.type)
        continue

      column.type = referenced.type
      column.maxLength = referenced.maxLength
      column.enumValues = referenced.enumValues
      column.enumTypeName = referenced.enumTypeName
    }
  }

  return { dialect: options.dialect, vitessSharded: options.vitessSharded, tables }
}

export function generateSql(plan: MigrationPlan, opts: { dryRun?: boolean } = {}): string[] {
  // Reset migration counter for proper ordering
  migrationCounter = 0
  migrationsCreatedCount = 0
  migrationsUpdatedCount = 0
  createdMigrationFiles = []
  existingCorpusBodies = null
  useDeterministicNames = true // Framework migrations use deterministic sequence names

  // In dry-run mode we compute statements/operations without touching disk —
  // used by callers that want to PREVIEW a migration (e.g. to gate destructive
  // changes behind confirmation) before generating for real.
  const emit = opts.dryRun ? (): boolean => false : createMigrationFile

  const statements: string[] = []
  const driver = getDialectDriver(plan.dialect, { vitessSharded: plan.vitessSharded })

  const { tables, deferredForeignKeys } = orderTablesForCreate(plan.tables, plan.dialect)

  // Create tables, indexes, and all acyclic foreign keys in one migration
  // file per model. Dependency ordering lets MySQL/Postgres render the FKs
  // inline instead of producing a second wave of alter-* migrations.
  for (const [tableIndex, originalTable] of tables.entries()) {
    const t: TablePlan = {
      ...originalTable,
      columns: originalTable.columns.map(column => deferredForeignKeys.has(foreignKeyKey(originalTable.table, column.name))
        ? { ...column, references: undefined }
        : column),
    }
    const tableStatements: string[] = []

    // First, collect all enum types needed for this table
    const enumTypes = new Set<string>()
    for (const c of t.columns) {
      if (c.type === 'enum' && c.enumValues && c.enumValues.length > 0) {
        const enumTypeName = `${t.table}_${c.name}_type`
        c.enumTypeName = enumTypeName
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

    for (const idx of t.indexes)
      tableStatements.push(driver.createIndex(t.table, idx))

    // A cyclic graph cannot express every constraint inline because one side
    // necessarily references a table that does not exist yet. Keep those
    // model-derived constraints in the final create migration: by then every
    // table exists, without creating a second wave of alter-* migration files.
    if (tableIndex === tables.length - 1) {
      for (const deferredTable of tables) {
        for (const column of deferredTable.columns) {
          if (!column.references || !deferredForeignKeys.has(foreignKeyKey(deferredTable.table, column.name)))
            continue
          const addForeignKey = driver.addForeignKey(deferredTable.table, column.name, column.references.table, column.references.column, column.references.onDelete, column.references.onUpdate)
          if (addForeignKey)
            tableStatements.push(addForeignKey)
        }
      }
    }

    // Add all statements to the main statements array
    statements.push(...tableStatements)

    // Create a single migration file for this table with all its statements
    const combinedStatement = tableStatements.join('\n\n')
    emit(combinedStatement, `create-${t.table}-table`)
  }

  // Show summary message
  const totalChanges = migrationsCreatedCount + migrationsUpdatedCount
  if (totalChanges === 0) {
    info('-- Nothing to migrate')
  }
  else {
    const parts: string[] = []
    if (migrationsCreatedCount > 0)
      parts.push(`${migrationsCreatedCount} created`)
    if (migrationsUpdatedCount > 0)
      parts.push(`${migrationsUpdatedCount} updated`)
    info(`-- Migration files: ${parts.join(', ')}`)
  }

  return statements
}

function foreignKeyKey(table: string, column: string): string {
  return `${table}\0${column}`
}

/**
 * Stable topological ordering for CREATE TABLE. References to tables outside
 * the current plan are assumed to exist already. SQLite accepts forward
 * references, including cycles; MySQL/Postgres defer only cycle edges.
 */
function orderTablesForCreate(input: TablePlan[], dialect: SupportedDialect): { tables: TablePlan[], deferredForeignKeys: Set<string> } {
  if (dialect === 'sqlite' || input.length < 2)
    return { tables: input, deferredForeignKeys: new Set() }

  const byName = new Map(input.map(table => [table.table, table]))
  const dependencies = new Map<string, Set<string>>()
  for (const table of input) {
    dependencies.set(table.table, new Set(table.columns
      .map(column => column.references?.table)
      .filter((target): target is string => Boolean(target && target !== table.table && byName.has(target)))))
  }

  const ordered: TablePlan[] = []
  const emitted = new Set<string>()
  while (ordered.length < input.length) {
    const ready = input.find(table => !emitted.has(table.table)
      && [...(dependencies.get(table.table) ?? [])].every(target => emitted.has(target)))
    if (!ready) break
    ordered.push(ready)
    emitted.add(ready.table)
  }

  const cycleTables = new Set(input.filter(table => !emitted.has(table.table)).map(table => table.table))
  const deferredForeignKeys = new Set<string>()
  for (const table of input) {
    if (!cycleTables.has(table.table)) continue
    for (const column of table.columns) {
      if (column.references && cycleTables.has(column.references.table) && column.references.table !== table.table)
        deferredForeignKeys.add(foreignKeyKey(table.table, column.name))
    }
  }

  ordered.push(...input.filter(table => cycleTables.has(table.table)))
  return { tables: ordered, deferredForeignKeys }
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

/**
 * The dialect's *physical* storage type for a column. Two model types that
 * collapse to the same physical type produce no real schema change, so the
 * diff should ignore the difference. This is what keeps the live-DB
 * introspection path (where the exact model type can't be recovered) from
 * emitting spurious ALTERs on every run.
 *
 * SQLite is the lossy one (string/text/date/datetime/json all map to TEXT;
 * boolean/integer/bigint to INTEGER; float/double/decimal to REAL). For
 * Postgres/MySQL the normalized type round-trips faithfully enough to compare
 * directly.
 */
export function canonicalStorageType(col: ColumnPlan, dialect: SupportedDialect): string {
  if (dialect === 'sqlite') {
    // Mirror SQLiteDriver.getColumnType: numeric `_id` columns are forced to
    // INTEGER (float storage would corrupt ids); declared string/text ids
    // (tickers, wallet addresses, hashes) keep their TEXT storage.
    if (col.name.endsWith('_id') && isNumericPlanType(col.type))
      return 'INTEGER'
    switch (col.type) {
      case 'string':
      case 'text':
      case 'date':
      case 'datetime':
      case 'timestamptz':
      case 'json':
      case 'enum':
        return 'TEXT'
      case 'boolean':
      case 'integer':
      case 'bigint':
        return 'INTEGER'
      case 'float':
      case 'double':
      case 'decimal':
        return 'REAL'
      default:
        return 'TEXT'
    }
  }
  if (dialect === 'mysql' || dialect === 'vitess' || dialect === 'singlestore') {
    switch (col.type) {
      case 'string': return `VARCHAR(${col.maxLength ?? 255})`
      case 'text': return 'TEXT'
      case 'boolean': return 'TINYINT(1)'
      case 'integer': return 'INTEGER'
      case 'bigint': return 'BIGINT'
      case 'float': return 'REAL'
      case 'double': return 'DOUBLE'
      case 'decimal': return 'DECIMAL'
      case 'date': return 'DATE'
      case 'datetime':
      case 'timestamptz': return 'DATETIME'
      case 'json': return 'JSON'
      case 'enum': return 'ENUM'
      default: return col.type
    }
  }
  return col.type
}

/**
 * Canonical string form of a column default, so equivalent defaults expressed
 * differently by a live DB vs a model (quoting, casts, `now()` vs
 * `CURRENT_TIMESTAMP`, `0` vs `'0'`) compare equal.
 */
export function canonicalizeDefault(col: ColumnPlan): string | undefined {
  if (!col.hasDefault || col.defaultValue === undefined)
    return undefined

  const dv = col.defaultValue
  if (dv instanceof Date)
    return dv.toISOString()
  if (typeof dv === 'boolean')
    return dv ? '1' : '0'
  if (typeof dv === 'bigint' || typeof dv === 'number')
    return String(dv)

  let s = String(dv).trim()
  // Strip Postgres `::type` casts (e.g. `'active'::text`).
  s = s.replace(/::[\w ]+$/i, '').trim()
  // Strip one layer of surrounding quotes.
  if ((s.startsWith('\'') && s.endsWith('\'')) || (s.startsWith('"') && s.endsWith('"')))
    s = s.slice(1, -1)

  const upper = s.toUpperCase()
  const sqlFns = ['CURRENT_TIMESTAMP', 'NOW()', 'CURRENT_DATE', 'CURRENT_TIME', 'NULL', 'TRUE', 'FALSE']
  if (sqlFns.includes(upper))
    return upper === 'NOW()' ? 'CURRENT_TIMESTAMP' : upper

  // For boolean columns the DB may echo 0/1/'t'/'f'; normalize to 1/0.
  if (col.type === 'boolean') {
    if (/^(?:1|t|true|yes)$/i.test(s))
      return '1'
    if (/^(?:0|f|false|no)$/i.test(s))
      return '0'
  }

  // Numeric literal -> canonical number form (`0.00` === `0`).
  if (/^-?\d+(?:\.\d+)?$/.test(s))
    return String(Number(s))

  return s
}

function columnsAreDifferent(col1: ColumnPlan, col2: ColumnPlan, dialect: SupportedDialect): boolean {
  // Compare physical storage type, not the model type — see canonicalStorageType.
  if (canonicalStorageType(col1, dialect) !== canonicalStorageType(col2, dialect))
    return true
  if (col1.isNullable !== col2.isNullable)
    return true
  if (col1.hasDefault !== col2.hasDefault)
    return true
  if (canonicalizeDefault(col1) !== canonicalizeDefault(col2))
    return true
  if (col1.isUnique !== col2.isUnique)
    return true

  // Compare enum values for enum types
  if (col1.type === 'enum' && col2.type === 'enum') {
    const enum1 = (col1.enumValues || []).slice().sort().join(',')
    const enum2 = (col2.enumValues || []).slice().sort().join(',')
    if (enum1 !== enum2)
      return true
  }

  return false
}

/**
 * A stable signature of everything about a column *except its name*. Two
 * columns with the same signature — one removed, one added, on the same table
 * — are a probable rename. See {@link detectColumnRenames}.
 */
function columnSignature(col: ColumnPlan, dialect: SupportedDialect): string {
  return JSON.stringify([
    canonicalStorageType(col, dialect),
    col.isPrimaryKey,
    col.isUnique,
    col.isNullable,
    col.hasDefault,
    canonicalizeDefault(col) ?? null,
    (col.enumValues ?? []).slice().sort(),
    col.references
      ? [col.references.table, col.references.column, col.references.onDelete ?? null, col.references.onUpdate ?? null]
      : null,
  ])
}

/**
 * Detect probable column renames between a table's previous and next columns.
 * A pair (removed `from`, added `to`) is a rename only when their signatures
 * match AND the signature is unambiguous — exactly one removed and one added
 * column share it. Anything ambiguous is left as a drop + add so the caller's
 * destructive-op gate can catch it.
 */
function detectColumnRenames(
  prevCols: Record<string, ColumnPlan>,
  currCols: Record<string, ColumnPlan>,
  dialect: SupportedDialect,
): { renames: Array<{ from: string, to: string }>, removed: string[], added: string[] } {
  const removed = Object.keys(prevCols).filter(n => !currCols[n])
  const added = Object.keys(currCols).filter(n => !prevCols[n])

  const sigRemoved = new Map<string, string[]>()
  const sigAdded = new Map<string, string[]>()
  for (const n of removed) {
    const s = columnSignature(prevCols[n], dialect)
    const list = sigRemoved.get(s) ?? []
    list.push(n)
    sigRemoved.set(s, list)
  }
  for (const n of added) {
    const s = columnSignature(currCols[n], dialect)
    const list = sigAdded.get(s) ?? []
    list.push(n)
    sigAdded.set(s, list)
  }

  const renames: Array<{ from: string, to: string }> = []
  const usedRemoved = new Set<string>()
  const usedAdded = new Set<string>()
  for (const [sig, rem] of sigRemoved) {
    const add = sigAdded.get(sig)
    if (rem.length === 1 && add && add.length === 1) {
      renames.push({ from: rem[0], to: add[0] })
      usedRemoved.add(rem[0])
      usedAdded.add(add[0])
    }
  }

  return {
    renames,
    removed: removed.filter(n => !usedRemoved.has(n)),
    added: added.filter(n => !usedAdded.has(n)),
  }
}

/** Whether a column is constrained such that SQLite can't DROP it in place. */
function isColumnConstrained(table: TablePlan, columnName: string): boolean {
  const col = table.columns.find(c => c.name === columnName)
  if (col && (col.isPrimaryKey || col.isUnique || col.references))
    return true
  return table.indexes.some(idx => idx.columns.includes(columnName))
}

/**
 * Whether two columns' foreign-key references differ (added, removed, or a
 * changed target/onDelete/onUpdate). columnsAreDifferent intentionally omitted
 * this, so FK-only changes produced no migration diff — see
 * stacksjs/bun-query-builder#1037.
 */
function referencesAreDifferent(r1?: ColumnPlan['references'], r2?: ColumnPlan['references']): boolean {
  if (Boolean(r1) !== Boolean(r2))
    return true
  if (!r1 || !r2)
    return false
  // More than one single-column FK on the same column means an older
  // reconciliation accumulated constraints. Collapse them back to the one
  // rule declared by the model even if one of the live rules already matches.
  if ((r1.constraintNames?.length ?? 0) > 1)
    return true
  // Canonicalize the referential action: an omitted action is `NO ACTION` in
  // SQL, so a model `onDelete: undefined` must compare equal to a live DB that
  // reports `'no action'` (otherwise the live-DB path would churn — and on
  // SQLite an FK change forces a full table rebuild).
  const act = (a?: string): string => (a ?? 'no action').toLowerCase()
  return r1.table !== r2.table
    || r1.column !== r2.column
    || act(r1.onDelete) !== act(r2.onDelete)
    || act(r1.onUpdate) !== act(r2.onUpdate)
}

/** The identity of an index in a diff: its kind, its name and its columns. */
/**
 * Identify an index by the name it actually has in the database.
 *
 * A model may declare `books_isbn_unique` or `isbn_unique` for the same index -
 * the driver prefixes the table name only when it is not already there, so both
 * spellings create `books_isbn_unique`. Keying on the declared name made those
 * two look like different indexes, and a schema introspected straight back out
 * of the database diffed against its own models as a drop and a re-create.
 *
 * Qualifying is the direction that works. Stripping the prefix instead cannot:
 * it maps both spellings onto one, so it cannot say which the model wrote.
 */
function indexKey(index: IndexPlan, table: string): string {
  return `${index.type}:${qualifiedIndexName(table, index.name)}:${index.columns.join(',')}`
}

function mapIndexesByKey(indexes: IndexPlan[], table: string): Record<string, IndexPlan> {
  const map: Record<string, IndexPlan> = {}
  for (const i of indexes) map[indexKey(i, table)] = i
  return map
}

export interface DiffOptions {
  /**
   * Emit data-preserving `RENAME COLUMN` for unambiguous detected renames
   * (default). Set false to force the literal `DROP` + `ADD` interpretation
   * (which loses the old column's data) — e.g. when the rename heuristic
   * guessed wrong.
   */
  applyRenames?: boolean
  /**
   * Compute statements/operations without writing any migration files to disk.
   * Used to PREVIEW a migration (e.g. to gate destructive changes behind
   * confirmation) before generating for real.
   */
  dryRun?: boolean
  /**
   * Treat a column that exists in `previous` but not in `next` as out of
   * scope rather than removed — keep it, and never emit a drop for it.
   *
   * Set when `previous` was recovered by introspecting the live database
   * instead of read from a model snapshot. The two are not the same evidence.
   * A snapshot is a record of what the MODELS said last time, so a column
   * missing from `next` genuinely means "the attribute was removed". Live
   * introspection only says the column is THERE, and a database carries
   * columns no model has ever declared: ones added by hand-written
   * migrations, by another app sharing the schema, by an extension. Reading
   * those as removals turns a self-heal into data loss.
   *
   * This is the column-level form of a rule the reconcile path already
   * applies to whole tables — an introspected table absent from the models is
   * out of scope, not garbage. The cost is that a genuine attribute removal
   * is deferred until a snapshot exists to prove it; the run that reconciles
   * writes one, so the next diff drops it normally.
   */
  preserveUnknownColumns?: boolean
}

/**
 * Generate comprehensive SQL to migrate from a previous plan to a new plan,
 * plus a structured list of the operations involved (so callers can gate
 * destructive changes and report renames without re-parsing SQL).
 *
 * Handles: created/dropped tables, added/dropped/renamed/modified columns,
 * added/dropped indexes, foreign-key changes, and — on SQLite — table rebuilds
 * for changes the dialect can't do in place.
 *
 * If there is no previous plan or the dialect changed, generates full SQL.
 */
export function generateDiffOperations(previous: MigrationPlan | undefined, next: MigrationPlan, opts: DiffOptions = {}): DiffResult {
  if (!previous || previous.dialect !== next.dialect) {
    const statements = generateSql(next, { dryRun: opts.dryRun })
    const operations: MigrationOperation[] = next.tables.map(t => ({
      kind: 'create_table' as const,
      table: t.table,
      destructive: false,
      sql: '',
    }))
    return { statements, operations }
  }

  const applyRenames = opts.applyRenames !== false // default true (data-preserving)
  const preserveUnknownColumns = opts.preserveUnknownColumns === true
  // In dry-run mode we don't write any migration files (preview only).
  const emit = opts.dryRun ? (): boolean => false : createMigrationFile

  // Reset migration counter for proper ordering
  migrationCounter = 0
  migrationsCreatedCount = 0
  migrationsUpdatedCount = 0
  createdMigrationFiles = []
  existingCorpusBodies = null
  useDeterministicNames = false // User diff migrations use timestamps

  const chunks: string[] = []
  const operations: MigrationOperation[] = []
  const driver = getDialectDriver(next.dialect, { vitessSharded: next.vitessSharded })
  const dialect = next.dialect

  const prevTables = mapTablesByName(previous.tables)
  const nextTables = mapTablesByName(next.tables)

  // 0) Drop removed tables first
  for (const tableName of Object.keys(prevTables)) {
    if (!nextTables[tableName]) {
      const dropTableStatement = driver.dropTable(tableName)
      chunks.push(dropTableStatement)
      operations.push({ kind: 'drop_table', table: tableName, destructive: true, sql: dropTableStatement })
      emit(dropTableStatement, `drop-${tableName}-table`)
      info(`-- Detected dropped table: ${tableName}`)
    }
  }

  // 1) New tables -> dependency-ordered create migrations containing their
  // enum types, inline foreign keys, and indexes. Existing referenced tables
  // are already present; only cycles among this batch require deferred SQL.
  const newTablePlans = Object.keys(nextTables)
    .filter(tableName => !prevTables[tableName])
    .map(tableName => nextTables[tableName])
  const { tables: orderedNewTables, deferredForeignKeys } = orderTablesForCreate(newTablePlans, dialect)

  for (const [tableIndex, originalTable] of orderedNewTables.entries()) {
    const t: TablePlan = {
      ...originalTable,
      columns: originalTable.columns.map(column => deferredForeignKeys.has(foreignKeyKey(originalTable.table, column.name))
        ? { ...column, references: undefined }
        : column),
    }
    const tableStatements: string[] = []

    // First, collect all enum types needed for this table
    const enumTypes = new Set<string>()
    for (const c of t.columns) {
      if (c.type === 'enum' && c.enumValues && c.enumValues.length > 0) {
        const enumTypeName = `${t.table}_${c.name}_type`
        c.enumTypeName = enumTypeName
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

    for (const idx of t.indexes) {
      const createIndexStatement = driver.createIndex(t.table, idx)
      tableStatements.push(createIndexStatement)
      operations.push({ kind: 'create_index', table: t.table, column: idx.name, destructive: false, sql: createIndexStatement })
    }

    for (const column of originalTable.columns) {
      if (column.references && !deferredForeignKeys.has(foreignKeyKey(originalTable.table, column.name)))
        operations.push({ kind: 'add_foreign_key', table: originalTable.table, column: column.name, destructive: false, sql: createTableStatement })
    }

    // Put unavoidable cyclic constraints in the final create migration so
    // incremental generation never produces standalone alter-* migrations.
    if (tableIndex === orderedNewTables.length - 1) {
      for (const deferredTable of orderedNewTables) {
        for (const column of deferredTable.columns) {
          if (!column.references || !deferredForeignKeys.has(foreignKeyKey(deferredTable.table, column.name)))
            continue
          const addForeignKey = driver.addForeignKey(deferredTable.table, column.name, column.references.table, column.references.column, column.references.onDelete, column.references.onUpdate)
          if (!addForeignKey) continue
          tableStatements.push(addForeignKey)
          operations.push({ kind: 'add_foreign_key', table: deferredTable.table, column: column.name, destructive: false, sql: addForeignKey })
        }
      }
    }

    // Add all statements to the main chunks array
    chunks.push(...tableStatements)
    operations.push({ kind: 'create_table', table: t.table, destructive: false, sql: createTableStatement })

    // Create a single migration file for this table with all its statements
    const combinedStatement = tableStatements.join('\n\n')
    emit(combinedStatement, `create-${t.table}-table`)
  }

  // 2) Create enum types for new columns in existing tables
  const enumTypes = new Set<string>()
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    const curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const currCols = mapColumnsByName(curr.columns)

    // Stamp the table-qualified type name on EVERY enum column, not just the
    // new ones. A column that already exists can still be re-emitted later as
    // an `ALTER COLUMN ... TYPE`, and an unstamped column falls back to the
    // bare `<column>_type` in the driver — a type nothing ever creates, so the
    // migration dies partway through with `type "status_type" does not exist`.
    // Only new columns get a CREATE TYPE; the rest already have theirs.
    for (const colName of Object.keys(currCols)) {
      const c = currCols[colName]
      if (c.type !== 'enum' || !c.enumValues || c.enumValues.length === 0)
        continue

      const enumTypeName = `${curr.table}_${c.name}_type`
      c.enumTypeName = enumTypeName

      if (prevCols[colName])
        continue

      if (!enumTypes.has(enumTypeName)) {
        const createEnumStatement = driver.createEnumType(enumTypeName, c.enumValues)
        if (createEnumStatement) {
          chunks.push(createEnumStatement)
          operations.push({ kind: 'create_enum', table: curr.table, column: c.name, destructive: false, sql: createEnumStatement })
          emit(createEnumStatement, `create-${enumTypeName}-enum`)
        }
        enumTypes.add(enumTypeName)
      }
    }
  }

  // 6) Existing tables -> full diffs (drops, adds, renames, and modifications)
  // Group all changes per table into single migration files
  for (const tableName of Object.keys(nextTables)) {
    const prev = prevTables[tableName]
    let curr = nextTables[tableName]
    if (!prev)
      continue

    const prevCols = mapColumnsByName(prev.columns)
    const prevIdx = mapIndexesByKey(prev.indexes, prev.table)
    let currCols = mapColumnsByName(curr.columns)
    let currIdx = mapIndexesByKey(curr.indexes, curr.table)

    // Resolve renames first so a renamed column isn't seen as drop + add.
    //
    // Not when reconciling from the database, though. Rename detection reads
    // "one column gone, one column of the same type arrived" as one column
    // that moved — sound when `previous` is the models' own prior state, and
    // unfounded when it is a live schema that may carry columns the models
    // have never described. There, a hand-written `legacy_note` and a newly
    // declared `region` are two different columns that happen to share a
    // type, and treating them as one moves data into a column that means
    // something else. Preserve and add instead; the data stays where it is.
    let renames: Array<{ from: string, to: string }> = []
    let removedCols = Object.keys(prevCols).filter(n => !currCols[n])
    let addedCols = Object.keys(currCols).filter(n => !prevCols[n])
    if (applyRenames && !preserveUnknownColumns) {
      const detected = detectColumnRenames(prevCols, currCols, dialect)
      renames = detected.renames
      removedCols = detected.removed
      addedCols = detected.added
    }

    // Columns the models never declared, kept because `previous` was read off
    // the database rather than from a snapshot.
    //
    // `curr` is then treated as though it had carried them all along, which is
    // the part that actually matters: a rebuild triggered by some unrelated
    // change recreates the table from `curr`, so a preserved column left out
    // of it would be dropped by the back door — silently, and without the
    // destructive gate ever seeing a `drop_column`.
    if (preserveUnknownColumns) {
      const preserved = removedCols.map(name => prevCols[name])
      // Live introspection cannot prove ownership of an index any more than it
      // can prove ownership of a column. Framework helpers, hand-written
      // migrations, and another app sharing the schema may all add indexes to
      // model-owned columns. Treat every live-only index as out of scope on a
      // reconcile run; a model snapshot remains the evidence required to drop
      // one intentionally.
      const keptIndexes = prev.indexes.filter(idx => !currIdx[indexKey(idx, prev.table)])

      if (preserved.length > 0 || keptIndexes.length > 0) {
        if (preserved.length > 0) {
          info(`-- Keeping ${preserved.length} column(s) on "${curr.table}" no model declares: ${removedCols.join(', ')} — reconciled from the database, where an undeclared column is out of scope rather than removed`)
        }
        if (keptIndexes.length > 0) {
          info(`-- Keeping ${keptIndexes.length} index(es) on "${curr.table}" no model declares: ${keptIndexes.map(index => index.name).join(', ')} — reconciled from the database, where an undeclared index is out of scope rather than removed`)
        }

        curr = { ...curr, columns: [...curr.columns, ...preserved], indexes: [...curr.indexes, ...keptIndexes] }
        currCols = mapColumnsByName(curr.columns)
        currIdx = mapIndexesByKey(curr.indexes, curr.table)
      }
      removedCols = []
    }

    // Columns present on both sides whose attributes changed, and FK-only changes.
    const modifiedCols = Object.keys(currCols).filter(n => prevCols[n] && columnsAreDifferent(prevCols[n], currCols[n], dialect))
    const fkChangedCols = Object.keys(currCols).filter(n => prevCols[n] && referencesAreDifferent(prevCols[n].references, currCols[n].references))

    // ---- SQLite rebuild path -------------------------------------------------
    // SQLite can't ALTER a column's type/constraint, can't change a FK, and
    // can't DROP a constrained column. Any of those requires recreating the
    // table. Pure adds / index changes / renames stay in-place below.
    if (dialect === 'sqlite') {
      const needsRebuild
        = modifiedCols.length > 0
          || fkChangedCols.length > 0
          || removedCols.some(name => isColumnConstrained(prev, name))

      if (needsRebuild) {
        const columnSource: Record<string, string> = {}
        const renameTo = new Map(renames.map(r => [r.to, r.from]))
        for (const c of curr.columns) {
          if (prevCols[c.name])
            columnSource[c.name] = c.name // carried over
          else if (renameTo.has(c.name))
            columnSource[c.name] = renameTo.get(c.name)! // renamed: pull from old name
          // else: brand-new column -> omit so it gets its DEFAULT / NULL
        }

        let tempName = `_qb_tmp_${curr.table}`
        let guard = 0
        while ((prevTables[tempName] || nextTables[tempName]) && guard < 100) {
          guard += 1
          tempName = `_qb_tmp_${curr.table}_${guard}`
        }

        const rebuildStatement = driver.rebuildTable({ target: curr, tempName, columnSource })
        chunks.push(rebuildStatement)
        const typeChanged = modifiedCols.some(n => prevCols[n].type !== currCols[n].type)
        operations.push({
          kind: 'rebuild_table',
          table: curr.table,
          destructive: removedCols.length > 0 || typeChanged,
          sql: rebuildStatement,
        })
        for (const r of renames)
          operations.push({ kind: 'rename_column', table: curr.table, from: r.from, to: r.to, destructive: false, confidence: 'high', sql: rebuildStatement })
        for (const name of removedCols)
          operations.push({ kind: 'drop_column', table: curr.table, column: name, destructive: true, sql: rebuildStatement })
        info(`-- Detected SQLite table rebuild required: ${curr.table}`)
        emit(rebuildStatement, `alter-${curr.table}-table`)
        continue
      }
    }

    // ---- In-place path (Postgres/MySQL always; simple SQLite changes) -------
    const tableChanges: string[] = []
    let hasChanges = false

    // Drop removed indexes first (before dropping columns that might be indexed)
    for (const key of Object.keys(prevIdx)) {
      if (!currIdx[key]) {
        const idx = prevIdx[key]
        const dropIndexStatement = driver.dropIndex(curr.table, idx.name)
        tableChanges.push(dropIndexStatement)
        chunks.push(dropIndexStatement)
        operations.push({ kind: 'drop_index', table: curr.table, column: idx.name, destructive: false, sql: dropIndexStatement })
        info(`-- Detected dropped index: ${idx.name} from ${curr.table}`)
        hasChanges = true
      }
    }

    // Rename columns (data-preserving)
    for (const r of renames) {
      const renameStatement = driver.renameColumn(curr.table, r.from, r.to)
      tableChanges.push(renameStatement)
      chunks.push(renameStatement)
      operations.push({ kind: 'rename_column', table: curr.table, from: r.from, to: r.to, destructive: false, confidence: 'high', sql: renameStatement })
      info(`-- Detected renamed column: ${curr.table}.${r.from} -> ${r.to}`)
      hasChanges = true
    }

    // Drop removed columns
    for (const colName of removedCols) {
      const dropColumnStatement = driver.dropColumn(curr.table, colName)
      tableChanges.push(dropColumnStatement)
      chunks.push(dropColumnStatement)
      operations.push({ kind: 'drop_column', table: curr.table, column: colName, destructive: true, sql: dropColumnStatement })
      info(`-- Detected dropped column: ${curr.table}.${colName}`)
      hasChanges = true
    }

    // Modify changed columns
    for (const colName of modifiedCols) {
      const prevCol = prevCols[colName]
      const currCol = currCols[colName]
      const modifyColumnStatement = driver.modifyColumn(curr.table, currCol)
      tableChanges.push(modifyColumnStatement)
      chunks.push(modifyColumnStatement)
      operations.push({
        kind: 'modify_column',
        table: curr.table,
        column: colName,
        destructive: prevCol.type !== currCol.type && !isLosslessTypeChange(prevCol.type, currCol.type),
        sql: modifyColumnStatement,
      })
      info(`-- Detected column change: ${curr.table}.${colName} (${prevCol.type} -> ${currCol.type})`)
      hasChanges = true
    }

    // Foreign-key reference changes are independent of column attributes
    // (an FK-only change leaves type/nullable/etc identical). #1037.
    for (const colName of fkChangedCols) {
      const currCol = currCols[colName]
      if (!currCol.references)
        continue
      const addFkStatement = driver.addForeignKey(
        curr.table,
        currCol.name,
        currCol.references.table,
        currCol.references.column,
        currCol.references.onDelete,
        currCol.references.onUpdate,
        prevCols[colName].references?.constraintNames,
      )
      if (!addFkStatement)
        continue
      tableChanges.push(addFkStatement)
      chunks.push(addFkStatement)
      operations.push({ kind: 'add_foreign_key', table: curr.table, column: colName, destructive: false, sql: addFkStatement })
      info(`-- Detected foreign-key change: ${curr.table}.${colName} -> ${currCol.references.table}(${currCol.references.column})`)
      hasChanges = true
    }

    // Add new columns
    for (const colName of addedCols) {
      const c = currCols[colName]
      const addColumnStatement = driver.addColumn(curr.table, c)
      tableChanges.push(addColumnStatement)
      chunks.push(addColumnStatement)
      operations.push({ kind: 'add_column', table: curr.table, column: c.name, destructive: false, sql: addColumnStatement })
      info(`-- Detected new column: ${curr.table}.${c.name}`)
      hasChanges = true

      if (c.references) {
        const addFkStatement = driver.addForeignKey(curr.table, c.name, c.references.table, c.references.column, c.references.onDelete, c.references.onUpdate)
        if (addFkStatement) {
          tableChanges.push(addFkStatement)
          chunks.push(addFkStatement)
          operations.push({ kind: 'add_foreign_key', table: curr.table, column: c.name, destructive: false, sql: addFkStatement })
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
        operations.push({ kind: 'create_index', table: curr.table, column: idx.name, destructive: false, sql: createIndexStatement })
        info(`-- Detected new index: ${idx.name} in ${curr.table}`)
        hasChanges = true
      }
    }

    // Create a single migration file with all changes for this table
    if (hasChanges) {
      const combinedStatement = tableChanges.join('\n\n')
      emit(combinedStatement, `alter-${curr.table}-table`)
    }
  }

  // Show summary message
  const totalChanges = migrationsCreatedCount + migrationsUpdatedCount
  if (totalChanges === 0) {
    info('-- Nothing to migrate')
  }
  else {
    const parts: string[] = []
    if (migrationsCreatedCount > 0)
      parts.push(`${migrationsCreatedCount} created`)
    if (migrationsUpdatedCount > 0)
      parts.push(`${migrationsUpdatedCount} updated`)
    info(`-- Migration files: ${parts.join(', ')}`)
  }

  const statements = chunks.length === 0 ? ['-- No changes detected'] : chunks
  return { statements, operations }
}

/**
 * Generate comprehensive SQL to migrate from a previous plan to a new plan.
 * Thin wrapper over {@link generateDiffOperations} preserved for existing
 * callers that only need the raw statements.
 */
export function generateDiffSql(previous: MigrationPlan | undefined, next: MigrationPlan, opts: DiffOptions = {}): string[] {
  return generateDiffOperations(previous, next, opts).statements
}
