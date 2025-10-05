import type { RunSeederOptions, Seeder, SeederConfig } from '@/seeder'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createQueryBuilder } from '../index'

/**
 * Find workspace root by looking for package.json
 */
function findWorkspaceRoot(startPath: string): string {
  let currentPath = startPath

  // Traverse up until we find package.json or reach root
  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath
    }
    currentPath = dirname(currentPath)
  }

  // Fallback to process.cwd() if package.json not found
  return process.cwd()
}

/**
 * Load all seeder files from a directory
 */
async function loadSeeders(seedersDir: string): Promise<Array<{ name: string, instance: Seeder }>> {
  if (!existsSync(seedersDir)) {
    console.log(`-- Seeders directory not found: ${seedersDir}`)
    return []
  }

  const files = readdirSync(seedersDir)
  const seederFiles = files.filter(file =>
    (file.endsWith('.ts') || file.endsWith('.js')) && file !== 'index.ts' && file !== 'index.js',
  )

  const seeders: Array<{ name: string, instance: Seeder }> = []

  for (const file of seederFiles) {
    const filePath = join(seedersDir, file)

    try {
      const module = await import(filePath)
      const SeederClass = module.default || module[Object.keys(module)[0]]

      if (SeederClass && typeof SeederClass === 'function') {
        const instance = new SeederClass()
        if (instance && typeof instance.run === 'function') {
          seeders.push({
            name: file.replace(/\.(ts|js)$/, ''),
            instance,
          })
        }
      }
    }
    catch (err) {
      console.error(`-- Failed to load seeder ${file}:`, err)
    }
  }

  // Sort seeders by order
  seeders.sort((a, b) => a.instance.order - b.instance.order)

  return seeders
}

/**
 * Run all seeders from a directory
 */
export async function runSeeders(config: SeederConfig = {}): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const seedersDir = config.seedersDir || join(workspaceRoot, 'database/seeders')
  const verbose = config.verbose ?? true

  if (verbose) {
    console.log('-- Running seeders...')
    console.log(`-- Seeders directory: ${seedersDir}`)
  }

  const seeders = await loadSeeders(seedersDir)

  if (seeders.length === 0) {
    console.log('-- No seeders found')
    return
  }

  if (verbose) {
    console.log(`-- Found ${seeders.length} seeder(s)`)
  }

  const qb = createQueryBuilder()

  for (const { name, instance } of seeders) {
    try {
      if (verbose) {
        console.log(`-- Seeding: ${name}`)
      }

      await instance.run(qb)

      if (verbose) {
        console.log(`-- ✓ Seeded: ${name}`)
      }
    }
    catch (err) {
      console.error(`-- ✗ Failed to seed ${name}:`, err)
      throw err
    }
  }

  if (verbose) {
    console.log('-- All seeders completed successfully')
  }
}

/**
 * Run a specific seeder by class name
 */
export async function runSeeder(className: string, options: RunSeederOptions = {}): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const seedersDir = join(workspaceRoot, 'database/seeders')
  const verbose = options.verbose ?? true

  if (verbose) {
    console.log(`-- Running seeder: ${className}`)
  }

  const seeders = await loadSeeders(seedersDir)
  const seeder = seeders.find(s => s.name === className)

  if (!seeder) {
    console.error(`-- Seeder not found: ${className}`)
    throw new Error(`Seeder not found: ${className}`)
  }

  const qb = createQueryBuilder()

  try {
    await seeder.instance.run(qb)

    if (verbose) {
      console.log(`-- ✓ Seeder completed: ${className}`)
    }
  }
  catch (err) {
    console.error(`-- ✗ Seeder failed: ${className}`, err)
    throw err
  }
}

/**
 * Generate a new seeder file
 */
export async function makeSeeder(name: string): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const seedersDir = join(workspaceRoot, 'database/seeders')

  // Ensure seeders directory exists
  if (!existsSync(seedersDir)) {
    mkdirSync(seedersDir, { recursive: true })
    console.log(`-- Created seeders directory: ${seedersDir}`)
  }

  // Normalize the seeder name (remove "Seeder" suffix if present, we'll add it)
  const baseName = name.replace(/Seeder$/i, '')
  const className = `${baseName}Seeder`
  const fileName = `${className}.ts`
  const filePath = join(seedersDir, fileName)

  if (existsSync(filePath)) {
    console.error(`-- Seeder already exists: ${filePath}`)
    throw new Error(`Seeder already exists: ${filePath}`)
  }

  const template = `import type { QueryBuilder } from 'bun-query-builder'
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class ${className} extends Seeder {
  /**
   * Run the database seeds.
   */
  async run(qb: QueryBuilder): Promise<void> {
    // Example: Create 10 records
    // const records = Array.from({ length: 10 }, () => ({
    //   name: faker.person.fullName(),
    //   email: faker.internet.email(),
    //   created_at: new Date(),
    //   updated_at: new Date(),
    // }))
    //
    // await qb.table('table_name').insert(records).execute()

    console.log('Seeder: ${className}')
  }

  /**
   * Specify the order in which this seeder should run.
   * Lower numbers run first. Default is 100.
   */
  get order(): number {
    return 100
  }
}
`

  writeFileSync(filePath, template)
  console.log(`-- ✓ Created seeder: ${filePath}`)
}

/**
 * Refresh database and run all seeders
 * This will drop all tables and re-run migrations and seeders
 */
export async function freshDatabase(options: { seedersDir?: string, modelsDir?: string, verbose?: boolean } = {}): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const modelsDir = options.modelsDir || join(workspaceRoot, 'app/Models')
  const seedersDir = options.seedersDir || join(workspaceRoot, 'database/seeders')
  const verbose = options.verbose ?? true

  try {
    // Import migration functions
    const { resetDatabase, generateMigration, executeMigration } = await import('./migrate')

    if (verbose) {
      console.log('-- Refreshing database...')
    }

    // Reset database (drop all tables)
    await resetDatabase(modelsDir)

    // Generate and run migrations
    if (verbose) {
      console.log('-- Running migrations...')
    }
    await generateMigration(modelsDir, { full: true })
    await executeMigration()

    // Run seeders
    if (verbose) {
      console.log('-- Running seeders...')
    }
    await runSeeders({ seedersDir, verbose })

    if (verbose) {
      console.log('-- ✓ Database refreshed successfully')
    }
  }
  catch (err) {
    console.error('-- ✗ Database refresh failed:', err)
    throw err
  }
}
