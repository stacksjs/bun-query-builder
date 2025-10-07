import type { Database } from '../schemas/kysely'
import { Database as BunDatabase } from 'bun:sqlite'
import { PrismaClient } from '@prisma/client'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Kysely, SqliteDialect } from 'kysely'
import { DataSource } from 'typeorm'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../../../bun-query-builder/src/index'
import { models } from '../schemas/bun-qb'
import * as drizzleSchema from '../schemas/drizzle'
import { Post as TypeORMPost, User as TypeORMUser } from '../schemas/typeorm'

const DB_PATH = './benchmark.db'

export function createBunQBClient() {
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  // Use BunDatabase directly for better performance (same as Kysely)
  const db = new BunDatabase(DB_PATH)

  // Cache prepared statements for better performance
  const statementCache = new Map<string, any>()

  // Convert $1, $2, $3 placeholders to ? for SQLite
  // Optimized to avoid regex for better performance on queries with many placeholders
  function convertPlaceholders(query: string): string {
    // Quick check - if no $, return as-is
    if (!query.includes('$'))
      return query

    // Use manual replacement for better performance
    let result = ''
    let i = 0
    while (i < query.length) {
      if (query[i] === '$' && i + 1 < query.length) {
        // Check if next char is a digit
        const charCode = query.charCodeAt(i + 1)
        if (charCode >= 48 && charCode <= 57) { // '0' to '9'
          // Skip $ and all following digits
          i++ // skip $
          while (i < query.length && query.charCodeAt(i) >= 48 && query.charCodeAt(i) <= 57) {
            i++
          }
          result += '?'
          continue
        }
      }
      result += query[i]
      i++
    }
    return result
  }

  // Check if this is a complete SQL statement (vs a fragment like "id = ?")
  function isCompleteStatement(query: string): boolean {
    const trimmed = query.trim().toUpperCase()
    return trimmed.startsWith('SELECT') || trimmed.startsWith('INSERT')
      || trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE')
  }

  // Check if query is SELECT (returns rows) vs mutation (INSERT/UPDATE/DELETE)
  function isSelectQuery(query: string): boolean {
    return query.trim().toUpperCase().startsWith('SELECT')
  }

  // Marker for SQL identifiers/fragments
  const SQL_FRAGMENT = Symbol('SQL_FRAGMENT')

  // Wrap BunDatabase to provide SQL template tag API
  const sql: any = (strings: any, ...values: any[]) => {
    // Handle single string argument (e.g., sql('column_name')) - return as identifier/fragment
    const str = strings as any

    if (!Array.isArray(strings) || !str.raw) {
      if (Array.isArray(strings)) {
        return { [SQL_FRAGMENT]: true, value: strings.join(', ') }
      }
      return { [SQL_FRAGMENT]: true, value: String(strings) }
    }
    // Handle template tag - use for loop instead of reduce for better performance
    const params: any[] = []
    let query = strings[0]
    for (let i = 0; i < values.length; i++) {
      const val = values[i]
      // Check if it's a SQL fragment (identifier)
      if (val && typeof val === 'object' && val[SQL_FRAGMENT]) {
        query += val.value
      }
      // Check if it's a query object (result of unsafe() or another template tag)
      else if (val && typeof val === 'object' && (typeof val.toString === 'function' || typeof val.raw === 'function') && typeof val.values === 'function') {
        // Use raw() if available, otherwise toString()
        const subQuery = typeof val.raw === 'function' ? val.raw() : String(val.toString())
        const subParams = val.values()
        // Renumber the placeholders in the subquery
        let renumberedQuery = subQuery
        if (subParams && subParams.length > 0) {
          // Replace placeholders from highest to lowest to avoid issues with $10 vs $1
          for (let j = subParams.length; j >= 1; j--) {
            const oldPlaceholder = `$${j}`
            const newPlaceholder = `$${params.length + j}`
            renumberedQuery = renumberedQuery.replaceAll(oldPlaceholder, newPlaceholder)
          }
          params.push(...subParams)
        }
        query += renumberedQuery
      }
      else {
        params.push(val)
        query += `$${params.length}`
      }
      query += strings[i + 1]
    }
    const sqliteQuery = convertPlaceholders(query)
    // Only prepare complete statements, not fragments
    let stmt: any = null
    if (isCompleteStatement(query)) {
      // Check cache first
      stmt = statementCache.get(sqliteQuery)
      if (!stmt) {
        stmt = db.query(sqliteQuery)
        statementCache.set(sqliteQuery, stmt)
      }
    }

    // Use .run() for mutations (INSERT/UPDATE/DELETE), .all() for SELECT
    // This is much faster for mutations since .run() doesn't try to return rows
    const isSelect = isSelectQuery(query)
    const executeFunc = stmt
      ? (isSelect
          ? (params.length > 0 ? () => stmt.all(...params) : () => stmt.all())
          : (params.length > 0 ? () => stmt.run(...params) : () => stmt.run()))
      : (isSelect
          ? (params.length > 0
              ? () => db.query(sqliteQuery).all(...params)
              : () => db.query(sqliteQuery).all())
          : (params.length > 0
              ? () => db.query(sqliteQuery).run(...params)
              : () => db.query(sqliteQuery).run()))

    return {
      execute: executeFunc,
      values: () => params,
      raw: () => query,
      toString: () => query,
      // Direct statement access for ultra-fast path (bypasses execute function overhead)
      _stmt: stmt,
      _params: params,
      _sqliteQuery: sqliteQuery,
    }
  }
  sql.unsafe = (query: string, params?: any[]) => {
    const sqliteQuery = convertPlaceholders(query)
    // Only prepare complete statements, not fragments
    let stmt: any = null
    if (isCompleteStatement(query)) {
      // Check cache first
      stmt = statementCache.get(sqliteQuery)
      if (!stmt) {
        stmt = db.query(sqliteQuery)
        statementCache.set(sqliteQuery, stmt)
      }
    }

    const hasParams = params && params.length > 0
    // Use .run() for mutations (INSERT/UPDATE/DELETE), .all() for SELECT
    const isSelect = isSelectQuery(query)
    const executeFunc = stmt
      ? (isSelect
          ? (hasParams ? () => stmt.all(...params!) : () => stmt.all())
          : (hasParams ? () => stmt.run(...params!) : () => stmt.run()))
      : (isSelect
          ? (hasParams
              ? () => db.query(sqliteQuery).all(...params!)
              : () => db.query(sqliteQuery).all())
          : (hasParams
              ? () => db.query(sqliteQuery).run(...params!)
              : () => db.query(sqliteQuery).run()))

    return {
      execute: executeFunc,
      values: () => params || [],
      raw: () => query,
      toString: () => query,
      // Direct statement access for ultra-fast path (bypasses execute function overhead)
      _stmt: stmt,
      _params: params || [],
      _sqliteQuery: sqliteQuery,
    }
  }
  return createQueryBuilder<typeof schema>({
    schema,
    meta,
    sql,
  })
}

export function createKyselyClient() {
  const dialect = new SqliteDialect({
    database: new BunDatabase(DB_PATH) as any,
  })

  return new Kysely<Database>({
    dialect,
  })
}

export function createDrizzleClient() {
  const sqlite = new BunDatabase(DB_PATH)
  return drizzle(sqlite, { schema: drizzleSchema })
}

export async function createTypeORMClient() {
  try {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: DB_PATH,
      entities: [TypeORMUser, TypeORMPost],
      synchronize: false,
    })

    await dataSource.initialize()
    return dataSource
  }
  catch {
    console.warn('⚠️  TypeORM skipped (better-sqlite3 native module not available)')
    return null
  }
}

export function createPrismaClient() {
  return new PrismaClient()
}

export function closeAll(clients: any[]) {
  for (const client of clients) {
    try {
      if (client?.destroy)
        client.destroy()
      if (client?.$disconnect)
        client.$disconnect()
      if (client?.close)
        client.close()
    }
    catch {
      // ignore
    }
  }
}
