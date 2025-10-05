import { Database as BunDatabase } from 'bun:sqlite'
import { SQL } from 'bun'
import { Kysely, SqliteDialect } from 'kysely'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { DataSource } from 'typeorm'
import { PrismaClient } from '@prisma/client'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../../../bun-query-builder/src/index'
import type { Database } from '../schemas/kysely'
import * as drizzleSchema from '../schemas/drizzle'
import { User as TypeORMUser, Post as TypeORMPost } from '../schemas/typeorm'
import { models } from '../schemas/bun-qb'

const DB_PATH = './benchmark.db'

export function createBunQBClient() {
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  const sql = new SQL(`sqlite://${DB_PATH}`)
  return createQueryBuilder<typeof schema>({
    schema,
    meta,
    sql,
  })
}

export function createKyselyClient() {
  const dialect = new SqliteDialect({
    database: new BunDatabase(DB_PATH),
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
  catch (error) {
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
      if (client?.destroy) client.destroy()
      if (client?.$disconnect) client.$disconnect()
      if (client?.close) client.close()
    }
    catch {
      // ignore
    }
  }
}
