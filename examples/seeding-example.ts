/**
 * Seeding Example
 *
 * This file demonstrates how to use the seeding functionality
 * in bun-query-builder.
 */

import { createQueryBuilder } from '../src'
import { runSeeders } from '../src/actions/seed'

// Example 1: Run all seeders programmatically
async function seedDatabase() {
  await runSeeders({
    seedersDir: './examples/database/seeders',
    verbose: true,
  })
}

// Example 2: Seed with custom query builder usage
async function manualSeed() {
  const qb = createQueryBuilder()

  // Import faker
  const { faker } = await import('ts-mocker')

  // Create users
  const users = Array.from({ length: 10 }, () => ({
    name: faker.person.fullName(),
    email: faker.internet.email(),
    age: faker.number.int(18, 80),
    role: faker.helpers.arrayElement(['admin', 'user', 'moderator']),
    created_at: new Date(),
    updated_at: new Date(),
  }))

  await qb.table('users').insert(users).execute()
  console.log(`✓ Created ${users.length} users`)

  // Get user IDs
  const createdUsers = await qb.table('users').select(['id']).execute()

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

  await qb.table('posts').insert(posts).execute()
  console.log(`✓ Created ${posts.length} posts`)
}

// Run the example
if (import.meta.main) {
  console.log('Running seeding example...\n')

  // Choose which example to run:
  // await seedDatabase()
  // await manualSeed()

  console.log('\n✓ Seeding example completed')
}
