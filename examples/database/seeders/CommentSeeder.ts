import { Seeder } from '../../../src/seeder'
import { faker } from 'ts-mocker'

export default class CommentSeeder extends Seeder {
  /**
   * Run the database seeds.
   */
  async run(qb: any): Promise<void> {
    console.log('Seeding comments...')

    // Get all post IDs and user IDs
    const posts = await qb.table('posts').select(['id']).execute()
    const users = await qb.table('users').select(['id']).execute()

    if (posts.length === 0 || users.length === 0) {
      console.log('⚠ No posts or users found, skipping comment seeding')
      return
    }

    // Generate 0-10 comments per post
    const comments = []
    for (const post of posts) {
      const commentCount = faker.number.int(0, 10)

      for (let i = 0; i < commentCount; i++) {
        // Pick a random user to be the author
        const randomUser = users[faker.number.int(0, users.length - 1)] as any

        comments.push({
          post_id: post.id,
          user_id: randomUser.id,
          content: faker.lorem.paragraph(2),
          created_at: faker.date.recent(),
          updated_at: new Date(),
        })
      }
    }

    // Insert comments in batches
    const batchSize = 100
    for (let i = 0; i < comments.length; i += batchSize) {
      const batch = comments.slice(i, i + batchSize)
      await qb.table('comments').insert(batch).execute()
    }

    console.log(`✓ Seeded ${comments.length} comments`)
  }

  /**
   * This seeder should run last (after users and posts)
   */
  get order(): number {
    return 30
  }
}
