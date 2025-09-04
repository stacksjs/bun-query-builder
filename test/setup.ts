import { executeMigration, generateMigration } from '../src/actions/migrate'
import { config } from '../src/config'

export async function setupDatabase() {
  try {
    const result = await generateMigration('./examples/models', { dialect: config.dialect, full: true })

    if (result.sqlStatements.length > 0) {
      await executeMigration()
    }
  }
  catch (error) {
    console.error('Migration failed:', error)
  }
}
