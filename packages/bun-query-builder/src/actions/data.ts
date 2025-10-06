import type { SupportedDialect } from '@/types'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { config } from '@/config'
import { createQueryBuilder } from '../client'

export interface ExportOptions {
  format?: 'json' | 'csv' | 'sql'
  output?: string
  limit?: number
}

export interface ImportOptions {
  format?: 'json' | 'csv'
  truncate?: boolean
}

export interface DumpOptions {
  tables?: string
  output?: string
}

/**
 * Export data from a table
 */
export async function exportData(tableName: string, options: ExportOptions = {}): Promise<void> {
  const format = options.format || 'json'
  const output = options.output || `${tableName}.${format}`
  const limit = options.limit

  console.log(`-- Exporting data from table: ${tableName}`)
  console.log(`-- Format: ${format}`)
  console.log(`-- Output: ${output}`)
  if (limit) {
    console.log(`-- Limit: ${limit} rows`)
  }
  console.log()

  try {
    const qb = createQueryBuilder()

    // Get data from table
    let query = qb.selectFrom(tableName as any)
    if (limit) {
      query = query.limit(limit)
    }

    const data = await query.execute()

    console.log(`-- Retrieved ${data.length} rows`)

    // Export based on format
    if (format === 'json') {
      writeFileSync(output, JSON.stringify(data, null, 2))
      console.log(`-- ✓ Exported to JSON: ${output}`)
    }
    else if (format === 'csv') {
      if (data.length === 0) {
        writeFileSync(output, '')
        console.log(`-- ✓ Exported to CSV: ${output} (empty)`)
        return
      }

      // Generate CSV
      const headers = Object.keys(data[0])
      const csvLines = [headers.join(',')]

      for (const row of data) {
        const values = headers.map((header) => {
          const value = row[header]
          if (value === null || value === undefined) {
            return ''
          }
          const str = String(value)
          // Escape quotes and wrap in quotes if contains comma or quote
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        csvLines.push(values.join(','))
      }

      writeFileSync(output, csvLines.join('\n'))
      console.log(`-- ✓ Exported to CSV: ${output}`)
    }
    else if (format === 'sql') {
      // Generate SQL INSERT statements
      const sqlLines: string[] = []

      for (const row of data) {
        const columns = Object.keys(row)
        const values = columns.map((col) => {
          const value = row[col]
          if (value === null || value === undefined) {
            return 'NULL'
          }
          if (typeof value === 'number') {
            return String(value)
          }
          return `'${String(value).replace(/'/g, "''")}'`
        })

        sqlLines.push(
          `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`,
        )
      }

      writeFileSync(output, sqlLines.join('\n'))
      console.log(`-- ✓ Exported to SQL: ${output}`)
    }
  }
  catch (err) {
    console.error(`-- Failed to export data from ${tableName}:`, err)
    throw err
  }
}

/**
 * Import data into a table
 */
export async function importData(tableName: string, filePath: string, options: ImportOptions = {}): Promise<void> {
  if (!existsSync(filePath)) {
    console.error(`-- File not found: ${filePath}`)
    throw new Error(`File not found: ${filePath}`)
  }

  const format = options.format || (filePath.endsWith('.json') ? 'json' : 'csv')
  const truncate = options.truncate ?? false

  console.log(`-- Importing data into table: ${tableName}`)
  console.log(`-- Format: ${format}`)
  console.log(`-- File: ${filePath}`)
  console.log(`-- Truncate: ${truncate}`)
  console.log()

  try {
    const qb = createQueryBuilder()

    // Truncate table if requested
    if (truncate) {
      await qb.deleteFrom(tableName as any).execute()
      console.log(`-- Table truncated`)
    }

    const fileContent = readFileSync(filePath, 'utf8')

    let data: any[] = []

    if (format === 'json') {
      data = JSON.parse(fileContent)
      if (!Array.isArray(data)) {
        throw new Error('JSON file must contain an array of objects')
      }
    }
    else if (format === 'csv') {
      const lines = fileContent.split('\n').filter(line => line.trim())
      if (lines.length < 2) {
        console.log('-- No data to import (CSV is empty or has only headers)')
        return
      }

      const headers = lines[0].split(',').map(h => h.trim())

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim())
        const row: any = {}

        for (let j = 0; j < headers.length; j++) {
          let value: any = values[j]

          // Remove quotes if present
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/""/g, '"')
          }

          // Convert empty strings to null
          if (value === '') {
            value = null
          }
          // Try to parse numbers
          else if (!Number.isNaN(Number(value))) {
            value = Number(value)
          }

          row[headers[j]] = value
        }

        data.push(row)
      }
    }

    if (data.length === 0) {
      console.log('-- No data to import')
      return
    }

    // Import data in batches
    const batchSize = 100
    let imported = 0

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize)
      await qb.insertInto(tableName as any).values(batch).execute()
      imported += batch.length
      console.log(`-- Imported ${imported}/${data.length} rows...`)
    }

    console.log(`-- ✓ Successfully imported ${data.length} rows`)
  }
  catch (err) {
    console.error(`-- Failed to import data into ${tableName}:`, err)
    throw err
  }
}

/**
 * Dump database or specific tables to SQL
 */
export async function dumpDatabase(options: DumpOptions = {}): Promise<void> {
  const dialect = config.dialect as SupportedDialect || 'postgres'
  const output = options.output || `dump-${Date.now()}.sql`
  const tablesToDump = options.tables?.split(',').map(t => t.trim())

  console.log('-- Dumping database')
  console.log(`-- Dialect: ${dialect}`)
  console.log(`-- Output: ${output}`)
  if (tablesToDump) {
    console.log(`-- Tables: ${tablesToDump.join(', ')}`)
  }
  console.log()

  try {
    const qb = createQueryBuilder()

    // Get list of tables
    let tables: string[] = []

    if (dialect === 'sqlite') {
      const result = await qb.unsafe(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).execute()
      tables = result.map((r: any) => r.name)
    }
    else if (dialect === 'postgres') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `).execute()
      tables = result.map((r: any) => r.table_name)
    }
    else if (dialect === 'mysql') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `).execute()
      tables = result.map((r: any) => r.table_name)
    }

    // Filter tables if specified
    if (tablesToDump) {
      tables = tables.filter(t => tablesToDump.includes(t))
    }

    if (tables.length === 0) {
      console.log('-- No tables to dump')
      return
    }

    console.log(`-- Dumping ${tables.length} table(s)`)

    const sqlLines: string[] = []
    sqlLines.push('-- Database dump')
    sqlLines.push(`-- Generated at: ${new Date().toISOString()}`)
    sqlLines.push(`-- Dialect: ${dialect}`)
    sqlLines.push('')

    // Dump each table
    for (const tableName of tables) {
      console.log(`-- Dumping table: ${tableName}`)

      const data = await qb.selectFrom(tableName as any).execute()

      sqlLines.push(`-- Table: ${tableName}`)
      sqlLines.push(`-- Rows: ${data.length}`)
      sqlLines.push('')

      for (const row of data) {
        const columns = Object.keys(row)
        const values = columns.map((col) => {
          const value = row[col]
          if (value === null || value === undefined) {
            return 'NULL'
          }
          if (typeof value === 'number') {
            return String(value)
          }
          return `'${String(value).replace(/'/g, "''")}'`
        })

        sqlLines.push(
          `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`,
        )
      }

      sqlLines.push('')
    }

    writeFileSync(output, sqlLines.join('\n'))
    console.log()
    console.log(`-- ✓ Database dump saved to: ${output}`)
  }
  catch (err) {
    console.error('-- Failed to dump database:', err)
    throw err
  }
}
