import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  /**
   * Run the database seeds.
   */
  async run(qb: any): Promise<void> {
    console.log('Seeding users...')

    // Generate 50 users with realistic fake data
    const users = Array.from({ length: 50 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email().toLowerCase(),
      age: faker.number.int({ min: 18, max: 80 }),
      role: faker.helpers.arrayElement(['admin', 'user', 'moderator', 'guest']),
      created_at: faker.date.past(),
      updated_at: new Date(),
    }))

    // Insert users into database
    await qb.insertInto('users').values(users).execute()

    console.log(`✓ Seeded ${users.length} users`)
  }

  /**
   * This seeder should run first (before posts and comments)
   */
  get order(): number {
    return 10
  }
}
