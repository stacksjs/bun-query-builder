import type { SupportedDialect } from '@/types'
import { bunSql } from '@/db'
import { getDialectDriver } from '@/drivers'

export interface WipeOptions {
  dialect?: SupportedDialect
  force?: boolean
  verbose?: boolean
}

/**
 * Drop all tables in the database
 */
export async function dbWipe(options: WipeOptions = {}): Promise<void> {
  const dialect = options.dialect || (process.env.DB_DIALECT as SupportedDialect) || 'postgres'
  const driver = getDialectDriver(dialect)

  if (options.verbose) {
    console.log(`Wiping all tables from ${dialect} database...`)
  }

  try {
    // Get list of all tables
    let tables: string[] = []

    if (dialect === 'postgres') {
      const result = await bunSql`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `
      tables = result.map((row: any) => row.tablename)
    }
    else if (dialect === 'mysql') {
      const dbName = process.env.DB_NAME || 'test'
      const result = await bunSql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = ${dbName}
      `
      tables = result.map((row: any) => row.table_name || row.TABLE_NAME)
    }
    else if (dialect === 'sqlite') {
      const result = await bunSql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      `
      tables = result.map((row: any) => row.name)
    }

    if (tables.length === 0) {
      console.log('No tables found to drop.')
      return
    }

    if (options.verbose) {
      console.log(`Found ${tables.length} tables: ${tables.join(', ')}`)
    }

    // Drop all tables
    if (dialect === 'postgres') {
      // Use CASCADE to handle foreign key constraints
      for (const table of tables) {
        if (options.verbose) {
          console.log(`Dropping table: ${table}`)
        }
        await bunSql`DROP TABLE IF EXISTS ${bunSql(table)} CASCADE`
      }
    }
    else if (dialect === 'mysql') {
      // Disable foreign key checks temporarily
      await bunSql`SET FOREIGN_KEY_CHECKS = 0`
      for (const table of tables) {
        if (options.verbose) {
          console.log(`Dropping table: ${table}`)
        }
        await bunSql`DROP TABLE IF EXISTS ${bunSql(table)}`
      }
      await bunSql`SET FOREIGN_KEY_CHECKS = 1`
    }
    else if (dialect === 'sqlite') {
      // SQLite doesn't support CASCADE, so we need to disable foreign keys
      await bunSql`PRAGMA foreign_keys = OFF`
      for (const table of tables) {
        if (options.verbose) {
          console.log(`Dropping table: ${table}`)
        }
        await bunSql`DROP TABLE IF EXISTS ${bunSql(table)}`
      }
      await bunSql`PRAGMA foreign_keys = ON`
    }

    console.log(`✓ Dropped ${tables.length} tables`)
  }
  catch (error: any) {
    console.error('Error wiping database:', error.message)
    throw error
  }
}

export { dbWipe as wipeDatabase }
