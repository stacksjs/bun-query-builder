import type { ColumnPlan, IndexPlan, MigrationPlan, NormalizedColumnType, PrimitiveDefault, TablePlan } from '../migrations'
import type { OnForeignKeyAction } from '../schema'
import type { SupportedDialect } from '../types'
import { config, isMysqlLike } from '../config'
import { createQueryBuilder } from '../index'

/**
 * Reverse introspection (stacksjs/bun-query-builder#1047): read a LIVE database
 * and emit `defineModel(...)` source, so an existing schema can be adopted
 * without hand-writing models. Complements the forward `introspect(dir)` which
 * loads models and prints the inferred schema.
 */

export interface IntrospectedColumn {
  name: string
  /** Raw dialect column type, e.g. `varchar(255)`, `integer`, `timestamp`. */
  sqlType: string
  nullable: boolean
  isPrimaryKey: boolean
}

export interface IntrospectedModel {
  table: string
  modelName: string
  primaryKey: string
  columns: IntrospectedColumn[]
  /** Generated `defineModel(...)` TypeScript source. */
  source: string
}

/** The attribute `type` we map a raw SQL column type to. */
export type AttrType = 'string' | 'number' | 'boolean' | 'datetime' | 'json'

/** Map a raw SQL column type to a model attribute type. */
export function sqlTypeToAttr(sqlType: string): AttrType {
  const t = sqlType.toLowerCase()
  // tinyint(1) is the conventional MySQL boolean; check before the int rule.
  if (/^bool|boolean|tinyint\(1\)/.test(t))
    return 'boolean'
  if (/int|serial|numeric|decimal|double|real|float|money/.test(t))
    return 'number'
  if (/timestamp|datetime|date|time/.test(t))
    return 'datetime'
  if (/json/.test(t))
    return 'json'
  return 'string'
}

function singularize(name: string): string {
  if (/ies$/i.test(name))
    return name.replace(/ies$/i, 'y')
  if (/ses$/i.test(name))
    return name.replace(/es$/i, '')
  if (/s$/i.test(name) && !/ss$/i.test(name))
    return name.replace(/s$/i, '')
  return name
}

function pascalCase(name: string): string {
  return name
    .replace(/[-_\s]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

/** PascalCase, singular model name for a table (`blog_posts` -> `BlogPost`). */
export function modelNameForTable(table: string): string {
  return pascalCase(singularize(table))
}

async function listTables(qb: any, dialect: SupportedDialect): Promise<string[]> {
  if (dialect === 'postgres') {
    const rows = await qb.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
    return rows.map((r: any) => r.table_name)
  }
  if (isMysqlLike(dialect)) {
    const rows = await qb.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`)
    return rows.map((r: any) => r.table_name ?? r.TABLE_NAME)
  }
  const rows = await qb.unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  return rows.map((r: any) => r.name)
}

async function readColumns(qb: any, dialect: SupportedDialect, table: string): Promise<IntrospectedColumn[]> {
  if (dialect === 'sqlite') {
    const rows = await qb.unsafe(`PRAGMA table_info(${table})`)
    return rows.map((r: any) => ({
      name: r.name,
      sqlType: String(r.type || ''),
      nullable: Number(r.notnull) === 0,
      isPrimaryKey: Number(r.pk) > 0,
    }))
  }
  if (dialect === 'postgres') {
    const rows = await qb.unsafe(
      `SELECT c.column_name, c.data_type, c.is_nullable,
        (SELECT COUNT(*) FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS is_pk
      FROM information_schema.columns c
      WHERE c.table_name = $1 AND c.table_schema = 'public'
      ORDER BY c.ordinal_position`,
      [table],
    )
    return rows.map((r: any) => ({
      name: r.column_name,
      sqlType: String(r.data_type || ''),
      nullable: String(r.is_nullable).toUpperCase() === 'YES',
      isPrimaryKey: Number(r.is_pk) > 0,
    }))
  }
  // mysql
  const rows = await qb.unsafe(
    `SELECT column_name, data_type, is_nullable, column_key
    FROM information_schema.columns
    WHERE table_name = ? AND table_schema = DATABASE()
    ORDER BY ordinal_position`,
    [table],
  )
  return rows.map((r: any) => ({
    name: r.column_name ?? r.COLUMN_NAME,
    sqlType: String(r.data_type ?? r.DATA_TYPE ?? ''),
    nullable: String(r.is_nullable ?? r.IS_NULLABLE).toUpperCase() === 'YES',
    isPrimaryKey: String(r.column_key ?? r.COLUMN_KEY).toUpperCase() === 'PRI',
  }))
}

/** Generate `defineModel(...)` source for one introspected table. */
export function generateModelSource(table: string, columns: IntrospectedColumn[]): string {
  const modelName = modelNameForTable(table)
  const pk = columns.find(c => c.isPrimaryKey)?.name ?? 'id'
  const attrLines = columns.map((c) => {
    const parts = [`type: '${sqlTypeToAttr(c.sqlType)}'`]
    if (!c.nullable && !c.isPrimaryKey)
      parts.push('required: true')
    return `      ${c.name}: { ${parts.join(', ')} },`
  }).join('\n')
  return `export const ${modelName} = defineModel({
  name: '${modelName}',
  table: '${table}',
  primaryKey: '${pk}',
  attributes: {
${attrLines}
  },
})
`
}

/**
 * Introspect the configured live database and return a generated model per
 * table. Pass `tables` to limit the set.
 */
export async function introspectDatabase(opts: { tables?: string[] } = {}): Promise<IntrospectedModel[]> {
  const dialect = (config.dialect as SupportedDialect) || 'postgres'
  const qb = createQueryBuilder() as any
  const tables = opts.tables?.length ? opts.tables : await listTables(qb, dialect)
  const out: IntrospectedModel[] = []
  for (const table of tables) {
    const columns = await readColumns(qb, dialect, table)
    if (!columns.length)
      continue
    out.push({
      table,
      modelName: modelNameForTable(table),
      primaryKey: columns.find(c => c.isPrimaryKey)?.name ?? 'id',
      columns,
      source: generateModelSource(table, columns),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Full-plan introspection: read a live database into a `MigrationPlan` so it
// can serve as the `previous` side of the diff. This is the self-healing path
// used when the `.qb` snapshot is missing/stale or the DB drifted. The reverse
// type mapping is necessarily lossy (e.g. SQLite stores string/text/json all
// as TEXT), so the diff engine compares *physical storage types* — see
// `canonicalStorageType` in migrations.ts — to avoid spurious ALTERs.
// ---------------------------------------------------------------------------

/** Map a raw SQL column type back to a normalized model column type. */
export function sqlTypeToNormalized(rawType: string, dialect: SupportedDialect, ctx?: { enumValues?: string[] }): NormalizedColumnType {
  if (ctx?.enumValues && ctx.enumValues.length > 0)
    return 'enum'

  const t = String(rawType || '').toLowerCase().trim()
  const base = t.replace(/\(.*$/, '').replace(/\s+/g, ' ').trim()

  if (isMysqlLike(dialect) && /^tinyint\(1\)/.test(t))
    return 'boolean'
  if (/^bool/.test(base))
    return 'boolean'
  if (base === 'int8' || base === 'bigint' || base === 'bigserial')
    return 'bigint'
  if (/^(?:int|integer|smallint|mediumint|serial|int2|int4|tinyint)/.test(base))
    return 'integer'
  if (/^(?:varchar|character varying|nvarchar|nchar|char|character|bpchar)/.test(base)) {
    const m = t.match(/\((\d+)\)/)
    const len = m ? Number(m[1]) : undefined
    return len !== undefined && len > 255 ? 'text' : 'string'
  }
  if (/text|clob/.test(base))
    return 'text'
  if (base === 'float8' || /^double/.test(base))
    return 'double'
  if (/^(?:real|float4|float)/.test(base))
    return 'float'
  if (/^(?:numeric|decimal|money)/.test(base))
    return 'decimal'
  if (base === 'date')
    return 'date'
  if (/^(?:timestamp|datetime)/.test(base))
    return 'datetime'
  if (/^time/.test(base))
    return 'string'
  if (/json/.test(base))
    return 'json'
  if (/^enum/.test(base))
    return 'enum'
  return 'string'
}

/** Strip the `<table>_` prefix the drivers add to physical index names. */
function stripIndexPrefix(physicalName: string, table: string): string {
  const prefix = `${table}_`
  return physicalName.startsWith(prefix) ? physicalName.slice(prefix.length) : physicalName
}

function asAction(raw: unknown): OnForeignKeyAction | undefined {
  const v = String(raw ?? '').toLowerCase().trim()
  if (v === 'cascade' || v === 'restrict' || v === 'set null')
    return v as OnForeignKeyAction
  // `no action` (the SQL default) and anything unrecognized -> undefined.
  return undefined
}

async function buildSqliteTable(qb: any, table: string): Promise<TablePlan> {
  const colRows = await qb.unsafe(`PRAGMA table_info(${JSON.stringify(table)})`)
  const idxList = await qb.unsafe(`PRAGMA index_list(${JSON.stringify(table)})`)
  const fkList = await qb.unsafe(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
  const ddlRows = await qb.unsafe(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
  const ddl = String(ddlRows?.[0]?.sql ?? '')

  // Map column -> FK reference.
  const fkByColumn = new Map<string, ColumnPlan['references']>()
  for (const fk of fkList) {
    fkByColumn.set(String(fk.from), {
      table: String(fk.table),
      column: String(fk.to ?? 'id'),
      onDelete: asAction(fk.on_delete),
      onUpdate: asAction(fk.on_update),
    })
  }

  // Unique single-column indexes -> column.isUnique; collect index plans.
  const indexes: IndexPlan[] = []
  const uniqueColumns = new Set<string>()
  for (const idx of idxList) {
    const origin = String(idx.origin ?? '') // 'c' created, 'u' unique constraint, 'pk'
    const physName = String(idx.name ?? '')
    if (origin === 'pk' || physName.startsWith('sqlite_autoindex_'))
      continue
    const info = await qb.unsafe(`PRAGMA index_info(${JSON.stringify(physName)})`)
    const columns = info.map((r: any) => String(r.name)).filter(Boolean)
    if (columns.length === 0)
      continue
    const isUnique = Number(idx.unique) === 1
    if (isUnique && columns.length === 1)
      uniqueColumns.add(columns[0])
    indexes.push({ name: stripIndexPrefix(physName, table), columns, type: isUnique ? 'unique' : 'index' })
  }

  const columns: ColumnPlan[] = colRows.map((r: any) => {
    const name = String(r.name)
    const enumValues = parseSqliteCheckEnum(ddl, name)
    const isPrimaryKey = Number(r.pk) > 0
    const dflt = r.dflt_value
    const hasDefault = dflt !== null && dflt !== undefined
    return {
      name,
      type: sqlTypeToNormalized(String(r.type ?? ''), 'sqlite', { enumValues }),
      isPrimaryKey,
      isUnique: uniqueColumns.has(name),
      isNullable: isPrimaryKey ? false : Number(r.notnull) === 0,
      hasDefault,
      defaultValue: hasDefault ? (normalizeRawDefault(dflt) as PrimitiveDefault) : undefined,
      enumValues,
      references: fkByColumn.get(name),
    }
  })

  return { table, columns, indexes }
}

/** Parse `CHECK ("col" IN ('a','b'))` out of a SQLite table's DDL for one column. */
function parseSqliteCheckEnum(ddl: string, column: string): string[] | undefined {
  if (!ddl)
    return undefined
  // Match the column's CHECK ... IN (...) clause; column may be quoted or bare.
  const re = new RegExp(`(?:"${column}"|\`${column}\`|\\b${column}\\b)\\s+IN\\s*\\(([^)]*)\\)`, 'i')
  const m = ddl.match(re)
  if (!m)
    return undefined
  const values = m[1]
    .split(',')
    .map(s => s.trim().replace(/^'(.*)'$/s, '$1').replace(/''/g, '\''))
    .filter(s => s.length > 0)
  return values.length > 0 ? values : undefined
}

function normalizeRawDefault(raw: unknown): string | number | boolean {
  if (typeof raw === 'number' || typeof raw === 'boolean')
    return raw
  return String(raw)
}

async function buildPgTable(qb: any, table: string): Promise<TablePlan> {
  const colRows = await qb.unsafe(
    `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length,
      (SELECT COUNT(*) FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS is_pk
    FROM information_schema.columns c
    WHERE c.table_name = $1 AND c.table_schema = 'public'
    ORDER BY c.ordinal_position`,
    [table],
  )

  // Indexes (and uniqueness) via pg_catalog.
  const idxRows = await qb.unsafe(
    `SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
            a.attname AS column_name, array_position(ix.indkey, a.attnum) AS ord,
            pg_get_expr(ix.indpred, ix.indrelid) AS where_clause
    FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = $1 AND t.relkind = 'r'
    ORDER BY i.relname, ord`,
    [table],
  )

  // Foreign keys.
  const fkRows = await qb.unsafe(
    `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column,
            rc.delete_rule, rc.update_rule
    FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = 'public'`,
    [table],
  )

  const fkByColumn = new Map<string, ColumnPlan['references']>()
  for (const fk of fkRows) {
    fkByColumn.set(String(fk.column_name), {
      table: String(fk.ref_table),
      column: String(fk.ref_column ?? 'id'),
      onDelete: asAction(fk.delete_rule),
      onUpdate: asAction(fk.update_rule),
    })
  }

  const { indexes, uniqueColumns } = groupPhysicalIndexes(table, idxRows.map((r: any) => ({
    indexName: String(r.index_name),
    isUnique: r.is_unique === true || r.is_unique === 't',
    isPrimary: r.is_primary === true || r.is_primary === 't',
    column: String(r.column_name),
    where: r.where_clause ? String(r.where_clause) : undefined,
  })))

  const columns: ColumnPlan[] = colRows.map((r: any) => {
    const name = String(r.column_name)
    const isPrimaryKey = Number(r.is_pk) > 0
    const rawDefault = r.column_default == null ? null : String(r.column_default)
    // nextval(...) is a serial sequence, not a user default.
    const isSerial = rawDefault != null && /nextval\(/i.test(rawDefault)
    const hasDefault = rawDefault != null && !isSerial
    return {
      name,
      type: sqlTypeToNormalized(String(r.data_type ?? r.udt_name ?? ''), 'postgres'),
      isPrimaryKey,
      isUnique: uniqueColumns.has(name),
      isNullable: isPrimaryKey ? false : String(r.is_nullable).toUpperCase() === 'YES',
      hasDefault,
      defaultValue: hasDefault ? (normalizeRawDefault(rawDefault) as PrimitiveDefault) : undefined,
      references: fkByColumn.get(name),
    }
  })

  return { table, columns, indexes }
}

async function buildMysqlTable(qb: any, table: string): Promise<TablePlan> {
  const colRows = await qb.unsafe(
    `SELECT column_name, data_type, column_type, is_nullable, column_default, column_key
    FROM information_schema.columns
    WHERE table_name = ? AND table_schema = DATABASE()
    ORDER BY ordinal_position`,
    [table],
  )
  const idxRows = await qb.unsafe(
    `SELECT index_name, non_unique, seq_in_index, column_name
    FROM information_schema.statistics
    WHERE table_name = ? AND table_schema = DATABASE()
    ORDER BY index_name, seq_in_index`,
    [table],
  )
  const fkRows = await qb.unsafe(
    `SELECT kcu.column_name, kcu.referenced_table_name AS ref_table, kcu.referenced_column_name AS ref_column,
            rc.delete_rule, rc.update_rule
    FROM information_schema.key_column_usage kcu
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema
    WHERE kcu.table_name = ? AND kcu.table_schema = DATABASE() AND kcu.referenced_table_name IS NOT NULL`,
    [table],
  )

  const fkByColumn = new Map<string, ColumnPlan['references']>()
  for (const fk of fkRows) {
    fkByColumn.set(String(fk.column_name ?? fk.COLUMN_NAME), {
      table: String(fk.ref_table ?? fk.REF_TABLE),
      column: String(fk.ref_column ?? fk.REF_COLUMN ?? 'id'),
      onDelete: asAction(fk.delete_rule ?? fk.DELETE_RULE),
      onUpdate: asAction(fk.update_rule ?? fk.UPDATE_RULE),
    })
  }

  const { indexes, uniqueColumns } = groupPhysicalIndexes(table, idxRows.map((r: any) => ({
    indexName: String(r.index_name ?? r.INDEX_NAME),
    isUnique: Number(r.non_unique ?? r.NON_UNIQUE) === 0,
    isPrimary: String(r.index_name ?? r.INDEX_NAME).toUpperCase() === 'PRIMARY',
    column: String(r.column_name ?? r.COLUMN_NAME),
  })))

  const columns: ColumnPlan[] = colRows.map((r: any) => {
    const name = String(r.column_name ?? r.COLUMN_NAME)
    const columnType = String(r.column_type ?? r.COLUMN_TYPE ?? '')
    const enumValues = parseMysqlEnum(columnType)
    const key = String(r.column_key ?? r.COLUMN_KEY ?? '').toUpperCase()
    const isPrimaryKey = key === 'PRI'
    const rawDefault = (r.column_default ?? r.COLUMN_DEFAULT)
    const hasDefault = rawDefault != null
    return {
      name,
      type: sqlTypeToNormalized(String(r.data_type ?? r.DATA_TYPE ?? columnType), 'mysql', { enumValues }),
      isPrimaryKey,
      isUnique: uniqueColumns.has(name),
      isNullable: isPrimaryKey ? false : String(r.is_nullable ?? r.IS_NULLABLE).toUpperCase() === 'YES',
      hasDefault,
      defaultValue: hasDefault ? (normalizeRawDefault(rawDefault) as PrimitiveDefault) : undefined,
      enumValues,
      references: fkByColumn.get(name),
    }
  })

  return { table, columns, indexes }
}

function parseMysqlEnum(columnType: string): string[] | undefined {
  const m = columnType.match(/^enum\((.*)\)$/i)
  if (!m)
    return undefined
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^'(.*)'$/s, '$1').replace(/''/g, '\''))
    .filter(s => s.length > 0)
}

/** Collapse per-(index,column) rows into IndexPlans; track single-col unique columns. */
function groupPhysicalIndexes(
  table: string,
  rows: Array<{ indexName: string, isUnique: boolean, isPrimary: boolean, column: string, where?: string }>,
): { indexes: IndexPlan[], uniqueColumns: Set<string> } {
  const byName = new Map<string, { isUnique: boolean, isPrimary: boolean, columns: string[], where?: string }>()
  for (const r of rows) {
    if (r.isPrimary)
      continue
    const entry = byName.get(r.indexName) ?? { isUnique: r.isUnique, isPrimary: r.isPrimary, columns: [], where: r.where }
    entry.columns.push(r.column)
    byName.set(r.indexName, entry)
  }

  const indexes: IndexPlan[] = []
  const uniqueColumns = new Set<string>()
  for (const [physName, entry] of byName) {
    if (entry.columns.length === 0)
      continue
    if (entry.isUnique && entry.columns.length === 1)
      uniqueColumns.add(entry.columns[0])
    indexes.push({
      name: stripIndexPrefix(physName, table),
      columns: entry.columns,
      type: entry.isUnique ? 'unique' : 'index',
      where: entry.where,
    })
  }
  return { indexes, uniqueColumns }
}

/**
 * Read the live database into a full `MigrationPlan`. Tables are read in the
 * dialect-native way (PRAGMA / information_schema / pg_catalog). The internal
 * `migrations` bookkeeping table is excluded.
 */
export async function buildPlanFromDatabase(dialect?: SupportedDialect, opts: { tables?: string[] } = {}): Promise<MigrationPlan> {
  const d = dialect || (config.dialect as SupportedDialect) || 'postgres'
  const qb = createQueryBuilder() as any
  const allTables = opts.tables?.length ? opts.tables : await listTables(qb, d)
  const tables = allTables.filter((t: string) => t !== 'migrations')

  const out: TablePlan[] = []
  for (const table of tables) {
    let plan: TablePlan
    if (d === 'sqlite')
      plan = await buildSqliteTable(qb, table)
    else if (d === 'postgres')
      plan = await buildPgTable(qb, table)
    else
      plan = await buildMysqlTable(qb, table)
    if (plan.columns.length > 0)
      out.push(plan)
  }

  return { dialect: d, tables: out }
}
