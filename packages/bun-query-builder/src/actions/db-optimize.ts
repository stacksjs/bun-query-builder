import type { SupportedDialect } from '@/types'
import process from 'node:process'
import { bunSql } from '@/db'

export interface OptimizeOptions {
  dialect?: SupportedDialect
  aggressive?: boolean
  tables?: string[]
  verbose?: boolean
}

/**
 * Optimize database tables (VACUUM, ANALYZE, OPTIMIZE)
 */
export async function dbOptimize(options: OptimizeOptions = {}): Promise<void> {
  const dialect = options.dialect || (process.env.DB_DIALECT as SupportedDialect) || 'postgres'
  const aggressive = options.aggressive || false

  if (options.verbose) {
    console.log(`Optimizing ${dialect} database${aggressive ? ' (aggressive mode)' : ''}...`)
  }

  try {
    if (dialect === 'postgres') {
      if (options.tables && options.tables.length > 0) {
        // Optimize specific tables
        for (const table of options.tables) {
          if (options.verbose) {
            console.log(`Analyzing table: ${table}`)
          }

          if (aggressive) {
            await bunSql`VACUUM FULL ANALYZE ${bunSql(table)}`
          }
          else {
            await bunSql`VACUUM ANALYZE ${bunSql(table)}`
          }
        }
      }
      else {
        // Optimize all tables
        if (options.verbose) {
          console.log('Running VACUUM and ANALYZE on all tables...')
        }

        if (aggressive) {
          // VACUUM FULL requires exclusive lock, can take a long time
          await bunSql`VACUUM FULL`
          await bunSql`ANALYZE`
        }
        else {
          await bunSql`VACUUM ANALYZE`
        }
      }

      console.log('✓ PostgreSQL optimization complete')
    }
    else if (dialect === 'mysql') {
      if (options.tables && options.tables.length > 0) {
        // Optimize specific tables
        for (const table of options.tables) {
          if (options.verbose) {
            console.log(`Optimizing table: ${table}`)
          }
          await bunSql`OPTIMIZE TABLE ${bunSql(table)}`
          await bunSql`ANALYZE TABLE ${bunSql(table)}`
        }
      }
      else {
        // Get all tables
        const dbName = process.env.DB_NAME || 'test'
        const tables = await bunSql`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = ${dbName}
        `

        for (const row of tables) {
          const tableName = (row as any).table_name || (row as any).TABLE_NAME
          if (options.verbose) {
            console.log(`Optimizing table: ${tableName}`)
          }
          await bunSql`OPTIMIZE TABLE ${bunSql(tableName)}`
          await bunSql`ANALYZE TABLE ${bunSql(tableName)}`
        }
      }

      console.log('✓ MySQL optimization complete')
    }
    else if (dialect === 'sqlite') {
      if (options.verbose) {
        console.log('Running VACUUM on SQLite database...')
      }

      // SQLite VACUUM
      await bunSql`VACUUM`

      // Analyze
      if (options.tables && options.tables.length > 0) {
        for (const table of options.tables) {
          if (options.verbose) {
            console.log(`Analyzing table: ${table}`)
          }
          await bunSql`ANALYZE ${bunSql(table)}`
        }
      }
      else {
        await bunSql`ANALYZE`
      }

      // Optimize pragma settings (one-time optimizations)
      if (aggressive) {
        if (options.verbose) {
          console.log('Running aggressive SQLite optimizations...')
        }
        await bunSql`PRAGMA optimize`
        await bunSql`PRAGMA wal_checkpoint(TRUNCATE)`
      }

      console.log('✓ SQLite optimization complete')
    }
    else {
      console.error(`Unsupported dialect: ${dialect}`)
    }
  }
  catch (error: any) {
    console.error('Error optimizing database:', error.message)
    throw error
  }
}

export { dbOptimize as optimizeDatabase }
