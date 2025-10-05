/**
 * Seeding Example
 *
 * This file demonstrates how to use the seeding functionality
 * in bun-query-builder.
 */

import { createQueryBuilder } from '../src'
import { runSeeders } from '../src/actions/seed'

// Example 1: Run all seeders programmatically
async function _seedDatabase() {
  await runSeeders({
    seedersDir: './examples/database/seeders',
    verbose: true,
  })
}

// Example 2: Seed with custom query builder usage
async function _manualSeed() {
  const qb = createQueryBuilder()

  // Import faker
  const { faker } = await import('ts-mocker')

  // Create users
  const users = Array.from({ length: 10 }, () => ({
    name: faker.person.fullName(),
    email: faker.internet.email(),
    age: faker.number.int({ min: 18, max: 80 }),
    role: faker.helpers.arrayElement(['admin', 'user', 'moderator']),
    created_at: new Date(),
    updated_at: new Date(),
  }))

  await qb.insertInto('users').values(users).execute()
  console.log(`✓ Created ${users.length} users`)

  // Get user IDs
  const createdUsers = await qb.selectFrom('users').execute()

  // Create posts for each user
  const posts = []
  for (const user of createdUsers) {
    for (let i = 0; i < 3; i++) {
      posts.push({
        user_id: user.id,
        title: faker.lorem.sentence(5),
        body: faker.lorem.paragraphs(3),
        published: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }
  }

  await qb.insertInto('posts').values(posts).execute()
  console.log(`✓ Created ${posts.length} posts`)
}

// Run the example
if (import.meta.main) {
  console.log('Running seeding example...\n')

  // Choose which example to run:
  // await _seedDatabase()
  // await _manualSeed()

  console.log('\n✓ Seeding example completed')
}
