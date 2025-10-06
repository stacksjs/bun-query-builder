import type { SupportedDialect } from '@/types'
import { config } from '@/config'
import { bunSql } from '@/db'
import { createQueryBuilder } from '../index'

export interface TableInfo {
  name: string
  rowCount: number
  columns?: number
  indexes?: number
}

export interface DatabaseInfo {
  dialect: SupportedDialect
  database: string
  tables: TableInfo[]
  totalTables: number
  totalRows: number
}

/**
 * Get database information and statistics
 */
export async function dbInfo(): Promise<DatabaseInfo> {
  const dialect = config.dialect as SupportedDialect || 'postgres'
  const database = config.database?.database || 'unknown'

  console.log('-- Database Information')
  console.log(`-- Dialect: ${dialect}`)
  console.log(`-- Database: ${database}`)
  console.log()

  try {
    const qb = createQueryBuilder()
    const tables: TableInfo[] = []

    // Get list of tables based on dialect
    let tableNames: string[] = []

    if (dialect === 'postgres') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `).execute()
      tableNames = result.map((r: any) => r.table_name)
    }
    else if (dialect === 'mysql') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `).execute()
      tableNames = result.map((r: any) => r.table_name)
    }
    else if (dialect === 'sqlite') {
      const result = await qb.unsafe(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).execute()
      tableNames = result.map((r: any) => r.name)
    }

    // Get row counts and column counts for each table
    for (const tableName of tableNames) {
      try {
        // Get row count
        const countResult = await qb.unsafe(`SELECT COUNT(*) as count FROM ${tableName}`).execute()
        const rowCount = Number(countResult[0]?.count || 0)

        // Get column count
        let columnCount = 0
        let indexCount = 0

        if (dialect === 'postgres') {
          const colResult = await qb.unsafe(`
            SELECT COUNT(*) as count
            FROM information_schema.columns
            WHERE table_name = $1
          `, [tableName]).execute()
          columnCount = Number(colResult[0]?.count || 0)

          const idxResult = await qb.unsafe(`
            SELECT COUNT(*) as count
            FROM pg_indexes
            WHERE tablename = $1
          `, [tableName]).execute()
          indexCount = Number(idxResult[0]?.count || 0)
        }
        else if (dialect === 'mysql') {
          const colResult = await qb.unsafe(`
            SELECT COUNT(*) as count
            FROM information_schema.columns
            WHERE table_name = ?
            AND table_schema = DATABASE()
          `, [tableName]).execute()
          columnCount = Number(colResult[0]?.count || 0)

          const idxResult = await qb.unsafe(`
            SELECT COUNT(*) as count
            FROM information_schema.statistics
            WHERE table_name = ?
            AND table_schema = DATABASE()
          `, [tableName]).execute()
          indexCount = Number(idxResult[0]?.count || 0)
        }
        else if (dialect === 'sqlite') {
          const colResult = await qb.unsafe(`PRAGMA table_info(${tableName})`).execute()
          columnCount = colResult.length

          const idxResult = await qb.unsafe(`PRAGMA index_list(${tableName})`).execute()
          indexCount = idxResult.length
        }

        tables.push({
          name: tableName,
          rowCount,
          columns: columnCount,
          indexes: indexCount,
        })
      }
      catch (err) {
        console.error(`-- Error getting info for table ${tableName}:`, err)
      }
    }

    const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0)

    console.log(`-- Total Tables: ${tables.length}`)
    console.log(`-- Total Rows: ${totalRows.toLocaleString()}`)
    console.log()

    if (tables.length > 0) {
      console.log('Tables:')
      console.log()

      // Find the longest table name for padding
      const maxNameLength = Math.max(...tables.map(t => t.name.length))

      // Header
      const header = 'Table'.padEnd(maxNameLength + 2) + 'Rows'.padStart(12) + 'Columns'.padStart(10) + 'Indexes'.padStart(10)
      console.log(header)
      console.log('-'.repeat(header.length))

      // Table rows
      for (const table of tables) {
        const name = table.name.padEnd(maxNameLength + 2)
        const rows = table.rowCount.toLocaleString().padStart(12)
        const cols = (table.columns || 0).toString().padStart(10)
        const idxs = (table.indexes || 0).toString().padStart(10)
        console.log(`${name}${rows}${cols}${idxs}`)
      }
    }
    else {
      console.log('-- No tables found')
    }

    return {
      dialect,
      database,
      tables,
      totalTables: tables.length,
      totalRows,
    }
  }
  catch (err) {
    console.error('-- Failed to get database info:', err)
    throw err
  }
}

/**
 * Get database statistics (alias for dbInfo)
 */
export async function dbStats(): Promise<DatabaseInfo> {
  return dbInfo()
}
