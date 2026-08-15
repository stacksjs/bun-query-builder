import type { MigrationPlan, NormalizedColumnType } from '../migrations'
import type { SupportedDialect } from '../types'
import { config } from '../config'
import { introspectDatabase } from './introspect-db'

/**
 * Compare a live database against what the models declare.
 *
 * This exists because the failure it catches is silent by construction. The
 * migration runner only applies migration FILES: it asks "which of these have
 * not run yet", not "does the database actually look like the models". So a
 * database created from an older, wrong migration set reports **"nothing to
 * migrate — your database is already up to date"** forever, while a column that
 * should be `text` sits at `varchar(255)` and one that should hold 99.5 is an
 * integer that stores 100.
 *
 * Every layer says it is fine. The write succeeds, the read comes back rounded
 * or the insert is refused for length, and the only symptom reaches a customer.
 * `CREATE TABLE IF NOT EXISTS` cannot repair it either, so a corrected migration
 * set deploys as a no-op and the wrong schema survives every deploy after it.
 *
 * The comparison is by type FAMILY rather than by exact SQL string. Dialects
 * spell the same type several ways — `character varying`, `varchar`, `int4`,
 * `integer`, `real`, `float4` — and an audit that reported those as drift would
 * be noise, which is the fastest way to teach people to ignore it.
 */

export interface ColumnDrift {
  table: string
  column: string
  /** The family the model asks for, e.g. `text`. */
  expected: string
  /** The family the database actually has, e.g. `varchar`. */
  actual: string
  /** The raw type as the database reports it, for the message. */
  actualSqlType: string
}

export interface SchemaDrift {
  /** Declared by a model, absent from the database. */
  missingTables: string[]
  /** Table exists, column does not. */
  missingColumns: Array<{ table: string, column: string, expected: string }>
  /** Column exists with a different type family. */
  typeMismatches: ColumnDrift[]
  /** True when nothing differs. */
  clean: boolean
}

/**
 * The coarse family a column type belongs to.
 *
 * Deliberately coarse. `bigint` and `integer` are both `integer` here: widening
 * an id is not the class of mistake this looks for, and flagging it would bury
 * the ones that are. What it does separate is the pairs that silently lose
 * data — text from bounded varchar, and fractional from whole.
 */
export type TypeFamily = 'text' | 'varchar' | 'integer' | 'fractional' | 'boolean' | 'date' | 'json' | 'binary' | 'other'

/** The family a model's declared type belongs to. */
export function familyOfDeclared(type: NormalizedColumnType): TypeFamily {
  switch (type) {
    case 'text':
      return 'text'
    case 'string':
    case 'enum':
      return 'varchar'
    case 'integer':
    case 'bigint':
      return 'integer'
    case 'float':
    case 'double':
    case 'decimal':
      return 'fractional'
    case 'boolean':
      return 'boolean'
    case 'date':
    case 'datetime':
    case 'timestamptz':
      return 'date'
    case 'json':
      return 'json'
    default:
      return 'other'
  }
}

/** The family a raw SQL type reported by a database belongs to. */
export function familyOfSqlType(sqlType: string): TypeFamily {
  const type = String(sqlType ?? '').toLowerCase().trim()

  // Order matters. `tinyint(1)` is MySQL's boolean and must not read as an
  // integer, and `character varying` must not read as `character`/text.
  if (/^(?:bool|boolean|bit)\b/.test(type) || type === 'tinyint(1)')
    return 'boolean'

  if (/^(?:json|jsonb)\b/.test(type))
    return 'json'

  if (/^(?:bytea|blob|binary|varbinary)\b/.test(type))
    return 'binary'

  if (/^(?:date|time|timestamp|datetime)\b/.test(type))
    return 'date'

  if (/(?:^|\b)(?:varchar|character varying|nvarchar|char)\b/.test(type))
    return 'varchar'

  if (/^(?:text|longtext|mediumtext|tinytext|clob|citext)\b/.test(type))
    return 'text'

  // `float4`/`float8` are Postgres's internal names for real and double
  // precision, and appear wherever pg_catalog is read rather than
  // information_schema.
  if (/^(?:decimal|numeric|real|double|money)\b/.test(type) || /^float\d*\b/.test(type))
    return 'fractional'

  // Likewise `int2`/`int4`/`int8`. A trailing digit is part of the name, so a
  // plain word boundary after `int` does not match them.
  if (/^(?:integer|bigint|smallint|tinyint|serial|bigserial|smallserial|mediumint)\b/.test(type) || /^int\d*\b/.test(type))
    return 'integer'

  return 'other'
}

/**
 * Whether a live column is an acceptable home for what the model declares.
 *
 * Same family always passes. Beyond that, only widenings are tolerated: a
 * model asking for `varchar` is content in a `text` column, because nothing is
 * lost. The reverse is exactly the bug this exists to find.
 */
export function satisfies(declared: TypeFamily, actual: TypeFamily): boolean {
  if (declared === actual)
    return true

  // A bounded string fits in an unbounded one.
  if (declared === 'varchar' && actual === 'text')
    return true

  // A whole number fits in a fractional column without losing anything. The
  // reverse does not, which is the 99.5-becomes-100 case.
  if (declared === 'integer' && actual === 'fractional')
    return true

  // SQLite reports very little, and several dialects report enums and custom
  // types as something this cannot classify. Unknown is not evidence of drift.
  if (declared === 'other' || actual === 'other')
    return true

  return false
}

/**
 * Audit the live database against a migration plan.
 *
 * Pass the plan built from the models (`buildMigrationPlan`). Tables the models
 * do not declare are ignored: a database is allowed to hold more than one
 * application's models, and framework-owned tables are not this plan's business.
 */
export async function auditSchemaDrift(
  plan: MigrationPlan,
  options: { dialect?: SupportedDialect } = {},
): Promise<SchemaDrift> {
  const dialect = options.dialect ?? (config.dialect as SupportedDialect)
  const declaredTables = plan.tables.map(table => table.table)

  const live = await introspectDatabase({ tables: declaredTables })
  const byTable = new Map(live.map(model => [model.table.toLowerCase(), model]))

  const missingTables: string[] = []
  const missingColumns: SchemaDrift['missingColumns'] = []
  const typeMismatches: ColumnDrift[] = []

  for (const table of plan.tables) {
    const liveTable = byTable.get(table.table.toLowerCase())

    if (!liveTable) {
      missingTables.push(table.table)
      continue
    }

    const liveColumns = new Map(liveTable.columns.map(column => [column.name.toLowerCase(), column]))

    for (const column of table.columns) {
      const liveColumn = liveColumns.get(column.name.toLowerCase())
      const declared = familyOfDeclared(column.type)

      if (!liveColumn) {
        missingColumns.push({ table: table.table, column: column.name, expected: declared })
        continue
      }

      const actual = familyOfSqlType(liveColumn.sqlType)

      if (!satisfies(declared, actual)) {
        typeMismatches.push({
          table: table.table,
          column: column.name,
          expected: declared,
          actual,
          actualSqlType: liveColumn.sqlType,
        })
      }
    }
  }

  void dialect

  return {
    missingTables,
    missingColumns,
    typeMismatches,
    clean: missingTables.length === 0 && missingColumns.length === 0 && typeMismatches.length === 0,
  }
}

/**
 * A human-readable report, or an empty string when there is nothing to say.
 *
 * Says what to do as well as what is wrong. A drift warning that only names the
 * problem leaves the reader to guess whether it matters, and the honest answer
 * here is that it always does: the schema cannot repair itself, because the
 * migration runner has already decided there is nothing to run.
 */
export function formatSchemaDrift(drift: SchemaDrift): string {
  if (drift.clean)
    return ''

  const lines: string[] = []

  if (drift.missingTables.length > 0)
    lines.push(`  Missing tables: ${drift.missingTables.join(', ')}`)

  for (const column of drift.missingColumns.slice(0, 10))
    lines.push(`  • ${column.table}.${column.column} is missing (models declare ${column.expected})`)

  for (const mismatch of drift.typeMismatches.slice(0, 10))
    lines.push(`  • ${mismatch.table}.${mismatch.column} is ${mismatch.actualSqlType}, models declare ${mismatch.expected}`)

  const shown = Math.min(drift.missingColumns.length, 10) + Math.min(drift.typeMismatches.length, 10)
  const total = drift.missingColumns.length + drift.typeMismatches.length
  if (total > shown)
    lines.push(`  + ${total - shown} more`)

  return [
    'The live schema does not match the models.',
    ...lines,
    '',
    'Migrations will NOT fix this on their own: the runner only applies files that have',
    'not run yet, and a corrected `CREATE TABLE IF NOT EXISTS` is a no-op against a table',
    'that already exists. Regenerate and apply the difference, or rebuild the schema.',
  ].join('\n')
}
