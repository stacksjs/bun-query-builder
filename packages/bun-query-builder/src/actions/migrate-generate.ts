import type { GenerateMigrationResult, MigrateOptions } from '@/types'
import { generateMigration as generateMigrationImpl } from './migrate'

/**
 * Generate migration files from model changes (alias for generateMigration)
 */
export async function migrateGenerate(dir?: string, opts: MigrateOptions = {}): Promise<GenerateMigrationResult> {
  return generateMigrationImpl(dir, opts)
}

export { migrateGenerate as generateMigration }
