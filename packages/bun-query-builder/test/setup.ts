import { executeMigration, generateMigration } from '../src/actions/migrate'
import { config } from '../src/config'

export async function setupDatabase() {
  try {
    await generateMigration('./examples/models', { dialect: config.dialect, full: true })

    await executeMigration()
  }
  catch (error) {
    console.error('Migration failed:', error)
  }
}
