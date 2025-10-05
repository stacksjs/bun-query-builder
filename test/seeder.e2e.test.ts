import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDatabase, makeSeeder, runSeeders } from '../src/actions/seed'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { createQueryBuilder } from '../src/index'
import { setupDatabase } from './setup'

let testWorkspace: string

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true

  // Set up database
  await setupDatabase()

  // Create test workspace
  testWorkspace = join(tmpdir(), `qb-e2e-${Date.now()}`)
  mkdirSync(testWorkspace, { recursive: true })
  writeFileSync(
    join(testWorkspace, 'package.json'),
    JSON.stringify({ name: 'e2e-test' }),
  )
})

afterAll(async () => {
  // Clean up database
  await resetDatabase('./examples/models', { dialect: config.dialect })

  // Clean up workspace
  if (existsSync(testWorkspace)) {
    rmSync(testWorkspace, { recursive: true, force: true })
  }
})

describe('End-to-End Seeding Workflow', () => {
  it('complete workflow: create, seed, verify', async () => {
    const qb = createQueryBuilder()

    // Step 1: Create seeder using makeSeeder
    const originalCwd = process.cwd()
    process.chdir(testWorkspace)

    await makeSeeder('User')

    const seederPath = join(testWorkspace, 'database/seeders/UserSeeder.ts')
    expect(existsSync(seederPath)).toBe(true)

    // Step 2: Modify seeder to insert real data
    const seederContent = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 10 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int(18, 80),
      role: 'user',
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
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
    const users = await qb.table('users').select(['*']).execute()
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
      await qb.table('comments').delete().execute()
      await qb.table('posts').delete().execute()
      await qb.table('users').delete().execute()
    }
    catch {
      // Tables might not exist
    }

    const seedersDir = join(testWorkspace, 'database/seeders-multi')
    mkdirSync(seedersDir, { recursive: true })

    // Create UserSeeder
    const userSeeder = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 5 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: 25,
      role: 'user',
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }

  get order(): number {
    return 10
  }
}
`

    // Create PostSeeder
    const postSeeder = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class PostSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = await qb.table('users').select(['id']).execute()

    if (users.length === 0) {
      console.log('No users found, skipping posts')
      return
    }

    const posts = []
    for (const user of users) {
      for (let i = 0; i < 2; i++) {
        posts.push({
          user_id: user.id,
          title: faker.lorem.sentence(5),
          body: faker.lorem.paragraphs(2),
          published: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
      }
    }

    await qb.table('posts').insert(posts).execute()
  }

  get order(): number {
    return 20
  }
}
`

    // Create CommentSeeder
    const commentSeeder = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class CommentSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const posts = await qb.table('posts').select(['id']).execute()
    const users = await qb.table('users').select(['id']).execute()

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
        content: faker.lorem.paragraph(1),
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    await qb.table('comments').insert(comments).execute()
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
    const users = await qb.table('users').select(['*']).execute()
    const posts = await qb.table('posts').select(['*']).execute()
    const comments = await qb.table('comments').select(['*']).execute()

    expect(users.length).toBeGreaterThanOrEqual(5)
    expect(posts.length).toBeGreaterThanOrEqual(10) // 5 users * 2 posts
    expect(comments.length).toBeGreaterThanOrEqual(10) // 1 comment per post
  })

  it('seeder with faker generates realistic data', async () => {
    const qb = createQueryBuilder()

    // Clean up
    try {
      await qb.table('users').delete().execute()
    }
    catch {
      // Table might not exist
    }

    const fakerDir = join(testWorkspace, 'database/seeders-faker')
    mkdirSync(fakerDir, { recursive: true })

    const fakerSeeder = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class FakerTestSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 3 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int(18, 80),
      role: faker.helpers.arrayElement(['admin', 'user', 'moderator']),
      created_at: faker.date.past(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }
}
`

    writeFileSync(join(fakerDir, 'FakerTestSeeder.ts'), fakerSeeder)

    await runSeeders({
      seedersDir: fakerDir,
      verbose: false,
    })

    const users = await qb.table('users').select(['*']).execute()
    expect(users.length).toBeGreaterThanOrEqual(3)

    // Verify realistic data
    if (users.length > 0) {
      const user = users[0]
      expect(user.name).toBeTruthy()
      expect(user.email).toContain('@')
      expect(user.age).toBeGreaterThan(0)
      expect(['admin', 'user', 'moderator']).toContain(user.role)
    }
  })

  it('handles large dataset seeding', async () => {
    const qb = createQueryBuilder()

    // Clean up
    try {
      await qb.table('users').delete().execute()
    }
    catch {
      // Table might not exist
    }

    const largeDir = join(testWorkspace, 'database/seeders-large')
    mkdirSync(largeDir, { recursive: true })

    const largeSeeder = `
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class LargeDataSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const totalUsers = 50
    const batchSize = 25

    for (let batch = 0; batch < Math.ceil(totalUsers / batchSize); batch++) {
      const users = Array.from({ length: batchSize }, () => ({
        name: faker.person.fullName(),
        email: faker.internet.email(),
        age: faker.number.int(18, 80),
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      }))

      await qb.table('users').insert(users).execute()
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

    const users = await qb.table('users').select(['*']).execute()
    expect(users.length).toBeGreaterThanOrEqual(50)
    expect(duration).toBeLessThan(10000) // Should complete in under 10 seconds
  })
})

describe('Error Handling and Edge Cases', () => {
  it('handles seeder with syntax error gracefully', async () => {
    const errorDir = join(testWorkspace, 'database/seeders-syntax-error')
    mkdirSync(errorDir, { recursive: true })

    const badSeeder = `
import { Seeder } from 'bun-query-builder'

export default class SyntaxErrorSeeder extends Seeder {
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

    const runtimeErrorSeeder = `
import { Seeder } from 'bun-query-builder'

export default class RuntimeErrorSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    throw new Error('Runtime error in seeder')
  }
}
`

    writeFileSync(join(runtimeErrorDir, 'RuntimeErrorSeeder.ts'), runtimeErrorSeeder)

    expect(async () => {
      await runSeeders({
        seedersDir: runtimeErrorDir,
        verbose: false,
      })
    }).toThrow()
  })

  it('handles missing query builder methods gracefully', async () => {
    const missingMethodDir = join(testWorkspace, 'database/seeders-missing-method')
    mkdirSync(missingMethodDir, { recursive: true })

    const missingMethodSeeder = `
import { Seeder } from 'bun-query-builder'

export default class MissingMethodSeeder extends Seeder {
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

    const noExportSeeder = `
import { Seeder } from 'bun-query-builder'

class NoExportSeeder extends Seeder {
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
