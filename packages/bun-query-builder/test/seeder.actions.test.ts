import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDatabase } from '../src/actions/migrate'
import { makeSeeder, runSeeder, runSeeders } from '../src/actions/seed'
import { config } from '../src/config'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

let testSeedersDir: string
let testWorkspaceRoot: string

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true

  // Set up database for seeder tests
  await setupDatabase()

  // Create temporary workspace for testing
  testWorkspaceRoot = join(tmpdir(), `qb-seeder-test-${Date.now()}`)
  mkdirSync(testWorkspaceRoot, { recursive: true })

  // Create package.json to mark as workspace root
  writeFileSync(
    join(testWorkspaceRoot, 'package.json'),
    JSON.stringify({ name: 'test-workspace' }),
  )

  testSeedersDir = join(testWorkspaceRoot, 'database/seeders')
  mkdirSync(testSeedersDir, { recursive: true })
})

afterAll(async () => {
  // Clean up database after tests
  await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })

  // Clean up temporary directories
  if (existsSync(testWorkspaceRoot)) {
    rmSync(testWorkspaceRoot, { recursive: true, force: true })
  }
})

describe('makeSeeder', () => {
  it('creates a new seeder file', async () => {
    const originalCwd = process.cwd()
    process.chdir(testWorkspaceRoot)

    await makeSeeder('TestUser')

    const seederPath = join(testSeedersDir, 'TestUserSeeder.ts')
    expect(existsSync(seederPath)).toBe(true)

    const content = readFileSync(seederPath, 'utf-8')
    expect(content).toContain('class TestUserSeeder extends Seeder')
    expect(content).toContain('async run(qb: QueryBuilder)')
    expect(content).toContain('import { faker } from \'ts-mocker\'')

    process.chdir(originalCwd)
  })

  it('strips "Seeder" suffix if provided', async () => {
    const originalCwd = process.cwd()
    process.chdir(testWorkspaceRoot)

    await makeSeeder('ProductSeeder')

    const seederPath = join(testSeedersDir, 'ProductSeeder.ts')
    expect(existsSync(seederPath)).toBe(true)

    const content = readFileSync(seederPath, 'utf-8')
    expect(content).toContain('class ProductSeeder extends Seeder')

    process.chdir(originalCwd)
  })

  it('throws error if seeder already exists', async () => {
    const originalCwd = process.cwd()
    process.chdir(testWorkspaceRoot)

    await makeSeeder('Duplicate')

    expect(async () => {
      await makeSeeder('Duplicate')
    }).toThrow()

    process.chdir(originalCwd)
  })

  it('creates seeders directory if it does not exist', async () => {
    const newWorkspace = join(tmpdir(), `qb-new-workspace-${Date.now()}`)
    mkdirSync(newWorkspace, { recursive: true })
    writeFileSync(
      join(newWorkspace, 'package.json'),
      JSON.stringify({ name: 'new-workspace' }),
    )

    const originalCwd = process.cwd()
    process.chdir(newWorkspace)

    await makeSeeder('NewSeeder')

    const seedersDir = join(newWorkspace, 'database/seeders')
    expect(existsSync(seedersDir)).toBe(true)
    expect(existsSync(join(seedersDir, 'NewSeeder.ts'))).toBe(true)

    process.chdir(originalCwd)
    rmSync(newWorkspace, { recursive: true, force: true })
  })
})

describe('runSeeders', () => {
  it('handles empty seeders directory', async () => {
    const emptyDir = join(tmpdir(), `qb-empty-${Date.now()}`)
    mkdirSync(emptyDir, { recursive: true })

    await runSeeders({
      seedersDir: emptyDir,
      verbose: false,
    })

    // Should complete without errors
    expect(true).toBe(true)

    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('handles non-existent seeders directory', async () => {
    const nonExistentDir = join(tmpdir(), `qb-nonexistent-${Date.now()}`)

    await runSeeders({
      seedersDir: nonExistentDir,
      verbose: false,
    })

    // Should complete without errors
    expect(true).toBe(true)
  })
})

describe('runSeeder', () => {
  it('throws error when seeder not found', async () => {
    expect(async () => {
      await runSeeder('NonExistentSeeder', { verbose: false })
    }).toThrow()
  })
})

describe('Seeder Configuration', () => {
  it('verifies makeSeeder creates properly formatted files', async () => {
    const originalCwd = process.cwd()
    process.chdir(testWorkspaceRoot)

    await makeSeeder('TestConfig')

    const seederPath = join(testSeedersDir, 'TestConfigSeeder.ts')
    expect(existsSync(seederPath)).toBe(true)

    const content = readFileSync(seederPath, 'utf-8')
    expect(content).toContain('export default class')
    expect(content).toContain('extends Seeder')
    expect(content).toContain('async run')
    expect(content).toContain('get order()')

    process.chdir(originalCwd)
  })

  it('makeSeeder generates import statements', async () => {
    const originalCwd = process.cwd()
    process.chdir(testWorkspaceRoot)

    await makeSeeder('ImportTest')

    const seederPath = join(testSeedersDir, 'ImportTestSeeder.ts')
    const content = readFileSync(seederPath, 'utf-8')

    expect(content).toContain('import')
    expect(content).toContain('Seeder')
    expect(content).toContain('faker')

    process.chdir(originalCwd)
  })
})
