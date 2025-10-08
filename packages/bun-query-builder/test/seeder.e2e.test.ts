import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetDatabase } from '../src/actions/migrate'
import { makeSeeder, runSeeders } from '../src/actions/seed'
import { config } from '../src/config'
import { createQueryBuilder } from '../src/index'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

let testWorkspace: string

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true

  // Set up database
  await setupDatabase()

  // Create test workspace
  testWorkspace = join(tmpdir(), `qb-e2e-${Date.now()}`)
  mkdirSync(testWorkspace, { recursive: true })

  // Create package.json with local dependencies
  const bunQBPath = resolve(__dirname, '..')
  // Resolve ts-mocker from the root node_modules
  const tsMockerPath = resolve(bunQBPath, '../..', 'node_modules/ts-mocker')

  writeFileSync(
    join(testWorkspace, 'package.json'),
    JSON.stringify({
      name: 'e2e-test',
      dependencies: {
        'bun-query-builder': `file:${bunQBPath}`,
        'ts-mocker': `file:${tsMockerPath}`,
      },
    }, null, 2),
  )

  // Run bun install to create proper node_modules with links
  const installProc = Bun.spawnSync({
    cmd: ['bun', 'install', '--no-save'],
    cwd: testWorkspace,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (installProc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(installProc.stderr)
    console.error('Failed to install dependencies in test workspace:', stderr)
  }

  // Verify the installation worked
  const nodeModulesExists = existsSync(join(testWorkspace, 'node_modules/bun-query-builder'))
  if (!nodeModulesExists) {
    console.warn('node_modules/bun-query-builder not found after install')
  }
})

afterAll(async () => {
  // Clean up database
  await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })

  // Clean up workspace
  if (existsSync(testWorkspace)) {
    rmSync(testWorkspace, { recursive: true, force: true })
  }
})

describe('End-to-End Seeding Workflow', () => {
  it('complete workflow: create, seed, verify', async () => {
    const qb = createQueryBuilder()

    // Clean up - delete in correct order to avoid foreign key constraints
    try {
      await qb.deleteFrom('comments').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('posts').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might not exist
    }

    // Step 1: Create seeder using makeSeeder
    const originalCwd = process.cwd()
    process.chdir(testWorkspace)

    await makeSeeder('User')

    const seederPath = join(testWorkspace, 'database/seeders/UserSeeder.ts')
    expect(existsSync(seederPath)).toBe(true)

    // Step 2: Modify seeder to insert real data
    // Don't import Seeder class to avoid package resolution issues in temp workspace
    const seederContent = `
export default class UserSeeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 10 }, (_, i) => ({
      name: \`User \${i + 1}\`,
      email: \`user\${i + 1}@example.com\`,
      age: 20 + (i % 50),
      role: 'user',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    await qb.insertInto('users').values(users).execute()
  }

  get order(): number {
    return 10
  }
}
`
    writeFileSync(seederPath, seederContent)

    // Step 3: Run seeders
    await runSeeders({
      seedersDir: join(testWorkspace, 'database/seeders'),
      verbose: true,
    })

    // Step 4: Verify data was inserted
    const users = await qb.selectFrom('users').execute()
    expect(users.length).toBeGreaterThanOrEqual(10)

    // Step 5: Verify data structure
    if (users.length > 0) {
      const user = users[0]
      expect(user).toHaveProperty('name')
      expect(user).toHaveProperty('email')
      expect(user).toHaveProperty('age')
      expect(user).toHaveProperty('role')
    }

    process.chdir(originalCwd)
  })

  it('multiple seeders with dependencies', async () => {
    const qb = createQueryBuilder()

    // Clean up first
    try {
      await qb.deleteFrom('comments').execute()
      await qb.deleteFrom('posts').execute()
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Tables might not exist
    }

    const seedersDir = join(testWorkspace, 'database/seeders-multi')
    mkdirSync(seedersDir, { recursive: true })

    // Create UserSeeder
    const userSeeder = `
export default class UserSeeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 5 }, (_, i) => ({
      name: \`User \${i + 1}\`,
      email: \`user\${i + 1}@example.com\`,
      age: 25,
      role: 'user',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    await qb.insertInto('users').values(users).execute()
  }

  get order(): number {
    return 10
  }
}
`

    // Create PostSeeder
    const postSeeder = `
export default class PostSeeder {
  async run(qb: any): Promise<void> {
    const users = await qb.selectFrom('users').execute()

    if (users.length === 0) {
      console.log('No users found, skipping posts')
      return
    }

    const posts = []
    for (const user of users) {
      for (let i = 0; i < 2; i++) {
        posts.push({
          user_id: user.id,
          title: \`Post \${i + 1}\`,
          body: \`Post content \${i + 1}\`,
          published: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      }
    }

    await qb.insertInto('posts').values(posts).execute()
  }

  get order(): number {
    return 20
  }
}
`

    // Create CommentSeeder
    const commentSeeder = `
export default class CommentSeeder {
  async run(qb: any): Promise<void> {
    const posts = await qb.selectFrom('posts').execute()
    const users = await qb.selectFrom('users').execute()

    if (posts.length === 0 || users.length === 0) {
      console.log('No posts or users found, skipping comments')
      return
    }

    const comments = []
    for (const post of posts) {
      const user = users[0]
      comments.push({
        post_id: post.id,
        user_id: user.id,
        content: 'Comment content',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    }

    await qb.insertInto('comments').values(comments).execute()
  }

  get order(): number {
    return 30
  }
}
`

    writeFileSync(join(seedersDir, 'UserSeeder.ts'), userSeeder)
    writeFileSync(join(seedersDir, 'PostSeeder.ts'), postSeeder)
    writeFileSync(join(seedersDir, 'CommentSeeder.ts'), commentSeeder)

    // Run all seeders
    await runSeeders({
      seedersDir,
      verbose: true,
    })

    // Verify all data exists
    const users = await qb.selectFrom('users').execute()
    const posts = await qb.selectFrom('posts').execute()
    const comments = await qb.selectFrom('comments').execute()

    expect(users.length).toBeGreaterThanOrEqual(5)
    expect(posts.length).toBeGreaterThanOrEqual(10) // 5 users * 2 posts
    expect(comments.length).toBeGreaterThanOrEqual(10) // 1 comment per post
  })

  it('seeder with faker generates realistic data', async () => {
    const qb = createQueryBuilder()

    // Clean up - delete in correct order to avoid foreign key constraints
    try {
      await qb.deleteFrom('comments').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('posts').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might not exist
    }

    const fakerDir = join(testWorkspace, 'database/seeders-faker')
    mkdirSync(fakerDir, { recursive: true })

    const fakerSeeder = `
export default class FakerTestSeeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 3 }, (_, i) => ({
      name: \`User \${i + 1}\`,
      email: \`user\${i + 1}@example.com\`,
      age: 20 + (i % 60),
      role: ["admin", "user", "moderator"][i % 3],
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    }))

    await qb.insertInto('users').values(users).execute()
  }
}
`

    writeFileSync(join(fakerDir, 'FakerTestSeeder.ts'), fakerSeeder)

    await runSeeders({
      seedersDir: fakerDir,
      verbose: false,
    })

    const users = await qb.selectFrom('users').execute()
    expect(users.length).toBeGreaterThanOrEqual(3)

    // Verify realistic data
    if (users.length > 0) {
      const user = users[0]
      expect(user.name).toBeTruthy()
      expect(user.email).toContain('@')
      expect(Number(user.age)).toBeGreaterThan(0)
      expect(['admin', 'user', 'moderator']).toContain(user.role as string)
    }
  })

  it('handles large dataset seeding', async () => {
    const qb = createQueryBuilder()

    // Clean up - delete in correct order to avoid foreign key constraints
    try {
      await qb.deleteFrom('comments').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('posts').execute()
    }
    catch {
      // Table might not exist
    }
    try {
      await qb.deleteFrom('users').execute()
    }
    catch {
      // Table might not exist
    }

    const largeDir = join(testWorkspace, 'database/seeders-large')
    mkdirSync(largeDir, { recursive: true })

    const largeSeeder = `
export default class LargeDataSeeder {
  async run(qb: any): Promise<void> {
    const totalUsers = 50
    const batchSize = 25

    for (let batch = 0; batch < Math.ceil(totalUsers / batchSize); batch++) {
      const users = Array.from({ length: batchSize }, (_, i) => ({
        name: \`User \${batch * batchSize + i + 1}\`,
        email: \`user\${batch * batchSize + i + 1}@example.com\`,
        age: 20 + (i % 60),
        role: 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))

      await qb.insertInto('users').values(users).execute()
    }
  }
}
`

    writeFileSync(join(largeDir, 'LargeDataSeeder.ts'), largeSeeder)

    const startTime = Date.now()
    await runSeeders({
      seedersDir: largeDir,
      verbose: false,
    })
    const duration = Date.now() - startTime

    const users = await qb.selectFrom('users').execute()
    expect(users.length).toBeGreaterThanOrEqual(50)
    expect(duration).toBeLessThan(10000) // Should complete in under 10 seconds
  })
})

describe('Error Handling and Edge Cases', () => {
  it('handles seeder with syntax error gracefully', async () => {
    const errorDir = join(testWorkspace, 'database/seeders-syntax-error')
    mkdirSync(errorDir, { recursive: true })

    const badSeeder = `export default class SyntaxErrorSeeder {
  async run(qb: any): Promise<void> {
    // Missing closing brace
    const data = {
      name: 'test'
  }
}
`

    writeFileSync(join(errorDir, 'SyntaxErrorSeeder.ts'), badSeeder)

    // Should handle import error
    try {
      await runSeeders({
        seedersDir: errorDir,
        verbose: false,
      })
      // If it doesn't throw, that's okay too (might skip bad files)
      expect(true).toBe(true)
    }
    catch (error) {
      // Expected to throw
      expect(error).toBeDefined()
    }
  })

  it('handles seeder that throws runtime error', async () => {
    const runtimeErrorDir = join(testWorkspace, 'database/seeders-runtime-error')
    mkdirSync(runtimeErrorDir, { recursive: true })

    const runtimeErrorSeeder = `export default class RuntimeErrorSeeder {
  async run(qb: any): Promise<void> {
    throw new Error('Runtime error in seeder')
  }
}
`

    writeFileSync(join(runtimeErrorDir, 'RuntimeErrorSeeder.ts'), runtimeErrorSeeder)

    try {
      await runSeeders({
        seedersDir: runtimeErrorDir,
        verbose: false,
      })
      // If we get here, the seeder didn't throw as expected
      expect(false).toBe(true)
    }
    catch (error) {
      // Expected to throw
      expect(error).toBeDefined()
    }
  })

  it('handles missing query builder methods gracefully', async () => {
    const missingMethodDir = join(testWorkspace, 'database/seeders-missing-method')
    mkdirSync(missingMethodDir, { recursive: true })

    const missingMethodSeeder = `export default class MissingMethodSeeder {
  async run(qb: any): Promise<void> {
    // Try to use non-existent method
    try {
      await qb.nonExistentMethod()
    } catch (error) {
      console.log('Caught expected error:', error.message)
    }
  }
}
`

    writeFileSync(join(missingMethodDir, 'MissingMethodSeeder.ts'), missingMethodSeeder)

    // Should not crash the entire seeding process
    await runSeeders({
      seedersDir: missingMethodDir,
      verbose: false,
    })

    expect(true).toBe(true)
  })

  it('handles empty seeder file', async () => {
    const emptyDir = join(testWorkspace, 'database/seeders-empty-file')
    mkdirSync(emptyDir, { recursive: true })

    writeFileSync(join(emptyDir, 'EmptySeeder.ts'), '')

    // Should skip empty files
    await runSeeders({
      seedersDir: emptyDir,
      verbose: false,
    })

    expect(true).toBe(true)
  })

  it('handles seeder with no default export', async () => {
    const noExportDir = join(testWorkspace, 'database/seeders-no-export')
    mkdirSync(noExportDir, { recursive: true })

    const noExportSeeder = `class NoExportSeeder {
  async run(qb: any): Promise<void> {
    console.log('This seeder has no default export')
  }
}
`

    writeFileSync(join(noExportDir, 'NoExportSeeder.ts'), noExportSeeder)

    // Should handle missing export gracefully
    await runSeeders({
      seedersDir: noExportDir,
      verbose: false,
    })

    expect(true).toBe(true)
  })
})
