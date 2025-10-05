import { faker } from 'ts-mocker'
import { Seeder } from '../../../src/seeder'

export default class PostSeeder extends Seeder {
  /**
   * Run the database seeds.
   */
  async run(qb: any): Promise<void> {
    console.log('Seeding posts...')

    // Get all user IDs to assign posts to them
    const users = await qb.selectFrom('users').execute()

    if (users.length === 0) {
      console.log('⚠ No users found, skipping post seeding')
      return
    }

    // Generate 3-5 posts per user
    const posts = []
    for (const user of users) {
      const postCount = faker.number.int({ min: 1, max: 5 })

      for (let i = 0; i < postCount; i++) {
        posts.push({
          user_id: user.id,
          title: faker.lorem.sentence(5),
          body: faker.lorem.paragraphs(3),
          published: faker.number.int({ min: 0, max: 1 }) === 1, // 50% published
          created_at: faker.date.past(),
          updated_at: new Date(),
        })
      }
    }

    // Insert posts in batches to avoid overwhelming the database
    const batchSize = 100
    for (let i = 0; i < posts.length; i += batchSize) {
      const batch = posts.slice(i, i + batchSize)
      await qb.insertInto('posts').values(batch).execute()
    }

    console.log(`✓ Seeded ${posts.length} posts`)
  }

  /**
   * This seeder should run after UserSeeder but before CommentSeeder
   */
  get order(): number {
    return 20
  }
}
