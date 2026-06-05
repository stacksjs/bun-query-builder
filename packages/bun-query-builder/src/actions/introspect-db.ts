import type { SupportedDialect } from '../types'
import { config } from '../config'
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
  if (dialect === 'mysql') {
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
