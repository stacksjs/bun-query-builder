import type { SupportedDialect } from '@/types'
import { config } from '@/config'
import { createQueryBuilder } from '../index'

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  default: any
  isPrimaryKey?: boolean
  isForeignKey?: boolean
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
}

export interface TableInspection {
  tableName: string
  rowCount: number
  columns: ColumnInfo[]
  indexes: IndexInfo[]
}

export interface InspectOptions {
  verbose?: boolean
}

/**
 * Inspect a table's structure, indexes, and statistics
 */
export async function inspectTable(tableName: string, options: InspectOptions = {}): Promise<TableInspection> {
  const dialect = config.dialect as SupportedDialect || 'postgres'
  const verbose = options.verbose ?? true

  if (verbose) {
    console.log(`-- Inspecting table: ${tableName}`)
    console.log(`-- Dialect: ${dialect}`)
    console.log()
  }

  try {
    const qb = createQueryBuilder()
    const columns: ColumnInfo[] = []
    const indexes: IndexInfo[] = []

    // Get row count
    const countResult = await qb.unsafe(`SELECT COUNT(*) as count FROM ${tableName}`)
    const rowCount = Number(countResult[0]?.count || 0)

    // Get columns based on dialect
    if (dialect === 'postgres') {
      const colsResult = await qb.unsafe(`
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE
            WHEN pk.column_name IS NOT NULL THEN true
            ELSE false
          END as is_primary_key,
          CASE
            WHEN fk.column_name IS NOT NULL THEN true
            ELSE false
          END as is_foreign_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1
        ) pk ON c.column_name = pk.column_name
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = $1
        ) fk ON c.column_name = fk.column_name
        WHERE c.table_name = $1
        ORDER BY c.ordinal_position
      `, [tableName])

      for (const col of colsResult) {
        columns.push({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
          default: col.column_default,
          isPrimaryKey: col.is_primary_key,
          isForeignKey: col.is_foreign_key,
        })
      }

      // Get indexes
      const idxResult = await qb.unsafe(`
        SELECT
          i.indexname as name,
          i.indexdef,
          ix.indisunique as is_unique
        FROM pg_indexes i
        JOIN pg_class c ON c.relname = i.indexname
        JOIN pg_index ix ON ix.indexrelid = c.oid
        WHERE i.tablename = $1
      `, [tableName])

      for (const idx of idxResult) {
        // Parse columns from indexdef
        const match = idx.indexdef?.match(/\(([^)]+)\)/)
        const colsStr = match ? match[1] : ''
        const cols = colsStr.split(',').map((c: string) => c.trim())

        indexes.push({
          name: idx.name,
          columns: cols,
          unique: idx.is_unique,
        })
      }
    }
    else if (dialect === 'mysql') {
      const colsResult = await qb.unsafe(`
        SELECT
          COLUMN_NAME as column_name,
          DATA_TYPE as data_type,
          IS_NULLABLE as is_nullable,
          COLUMN_DEFAULT as column_default,
          COLUMN_KEY as column_key
        FROM information_schema.COLUMNS
        WHERE TABLE_NAME = ?
        AND TABLE_SCHEMA = DATABASE()
        ORDER BY ORDINAL_POSITION
      `, [tableName])

      for (const col of colsResult) {
        columns.push({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
          default: col.column_default,
          isPrimaryKey: col.column_key === 'PRI',
          isForeignKey: col.column_key === 'MUL',
        })
      }

      // Get indexes
      const idxResult = await qb.unsafe(`
        SHOW INDEXES FROM ${tableName}
      `)

      const indexMap = new Map<string, { columns: string[], unique: boolean }>()

      for (const idx of idxResult) {
        const name = idx.Key_name
        if (!indexMap.has(name)) {
          indexMap.set(name, {
            columns: [],
            unique: idx.Non_unique === 0,
          })
        }
        indexMap.get(name)!.columns.push(idx.Column_name)
      }

      for (const [name, data] of indexMap) {
        indexes.push({
          name,
          columns: data.columns,
          unique: data.unique,
        })
      }
    }
    else if (dialect === 'sqlite') {
      const colsResult = await qb.unsafe(`PRAGMA table_info(${tableName})`)

      for (const col of colsResult) {
        columns.push({
          name: col.name,
          type: col.type,
          nullable: col.notnull === 0,
          default: col.dflt_value,
          isPrimaryKey: col.pk === 1,
        })
      }

      // Get indexes
      const idxResult = await qb.unsafe(`PRAGMA index_list(${tableName})`)

      for (const idx of idxResult) {
        const idxInfo = await qb.unsafe(`PRAGMA index_info(${idx.name})`)
        indexes.push({
          name: idx.name,
          columns: idxInfo.map((i: any) => i.name),
          unique: idx.unique === 1,
        })
      }
    }

    // Display results
    if (verbose) {
      console.log(`Table: ${tableName}`)
      console.log(`Rows: ${rowCount.toLocaleString()}`)
      console.log()

      console.log('Columns:')
      console.log()

      const maxNameLength = Math.max(...columns.map(c => c.name.length), 10)
      const maxTypeLength = Math.max(...columns.map(c => c.type.length), 10)
      const namePadding = maxNameLength + 2
      const typePadding = maxTypeLength + 2

      const header = `${'Name'.padEnd(namePadding)
        + 'Type'.padEnd(typePadding)
        + 'Nullable'.padEnd(10)
        + 'Default'.padEnd(20)
      }Flags`

      console.log(header)
      console.log('-'.repeat(header.length))

      for (const col of columns) {
        const name = col.name.padEnd(namePadding)
        const type = col.type.padEnd(typePadding)
        const nullable = (col.nullable ? 'YES' : 'NO').padEnd(10)
        const defaultVal = String(col.default || '').padEnd(20)
        const flags = [
          col.isPrimaryKey ? 'PK' : '',
          col.isForeignKey ? 'FK' : '',
        ].filter(Boolean).join(', ')

        console.log(`${name}${type}${nullable}${defaultVal}${flags}`)
      }

      console.log()

      if (indexes.length > 0) {
        console.log('Indexes:')
        console.log()

        for (const idx of indexes) {
          const unique = idx.unique ? ' (UNIQUE)' : ''
          console.log(`  - ${idx.name}${unique}: [${idx.columns.join(', ')}]`)
        }
        console.log()
      }
    }

    return {
      tableName,
      rowCount,
      columns,
      indexes,
    }
  }
  catch (err) {
    console.error(`-- Failed to inspect table ${tableName}:`, err)
    throw err
  }
}

/**
 * Alias for inspectTable
 */
export async function tableInfo(tableName: string, options: InspectOptions = {}): Promise<TableInspection> {
  return inspectTable(tableName, options)
}
