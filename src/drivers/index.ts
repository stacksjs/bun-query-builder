import type { SupportedDialect } from '../types'
import type { DialectDriver } from './postgres'
import { MySQLDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SQLiteDriver } from './sqlite'

export function getDialectDriver(dialect: SupportedDialect): DialectDriver {
  switch (dialect) {
    case 'postgres':
      return new PostgresDriver()
    case 'mysql':
      return new MySQLDriver()
    case 'sqlite':
      return new SQLiteDriver()
    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

export { MySQLDriver } from './mysql'
export type { DialectDriver } from './postgres'
export { PostgresDriver } from './postgres'
export { SQLiteDriver } from './sqlite'
