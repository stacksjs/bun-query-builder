import { resolve } from 'node:path'
import { executeMigration, generateMigration, resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'

// Absolute path to examples/models directory (relative to this file's location)
export const EXAMPLES_MODELS_PATH = resolve(__dirname, '../../../examples/models')

export async function setupDatabase() {
  try {
    // Reset database first to ensure clean slate
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })

    await generateMigration(EXAMPLES_MODELS_PATH, { dialect: config.dialect, full: true })

    await executeMigration()
  }
  catch (error) {
    console.error('Migration failed:', error)
  }
}
