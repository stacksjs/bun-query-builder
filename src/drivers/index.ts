import type { DialectDriver } from './postgres'
import type { SupportedDialect } from '../types'
import { PostgresDriver } from './postgres'
import { MySQLDriver } from './mysql'

export function getDialectDriver(dialect: SupportedDialect): DialectDriver {
  switch (dialect) {
    case 'postgres':
      return new PostgresDriver()
    case 'mysql':
      return new MySQLDriver()
    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

export type { DialectDriver } from './postgres'
export { PostgresDriver } from './postgres'
export { MySQLDriver } from './mysql'
