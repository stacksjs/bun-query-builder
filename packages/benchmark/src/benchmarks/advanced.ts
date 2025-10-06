import { eq } from 'drizzle-orm'
import { bench, group, run } from 'mitata'
import {
  closeAll,
  createBunQBClient,
  createDrizzleClient,
  createKyselyClient,
  createPrismaClient,
} from '../lib/db-clients'
import { posts, users } from '../schemas/drizzle'

console.log('Initializing clients...')
const bunQB = createBunQBClient()
const kysely = createKyselyClient()
const drizzle = createDrizzleClient()
const prisma = createPrismaClient()

console.log('Starting advanced query benchmarks...\n')

group('JOIN: Users with their posts', () => {
  bench('bun-query-builder', async () => {
    await (bunQB as any).selectFrom('users').innerJoin('posts', 'users.id', '=', 'posts.user_id').select(['users.id', 'users.name', 'posts.title']).limit(100).get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users')
      .innerJoin('posts', 'users.id', 'posts.user_id')
      .select(['users.id', 'users.name', 'users.email', 'posts.title'])
      .limit(100)
      .execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      postTitle: posts.title,
    })
      .from(users)
      .innerJoin(posts, eq(users.id, posts.userId))
      .limit(100)
  })

  bench('Prisma', async () => {
    await prisma.user.findMany({
      take: 100,
      include: {
        posts: {
          select: {
            title: true,
          },
        },
      },
    })
  })
})

group('AGGREGATE: Average age', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').avg('age')
  })

  bench('Kysely', async () => {
    const result = await kysely.selectFrom('users')
      .select(({ fn }) => fn.avg('age').as('avg'))
      .executeTakeFirst()
    return result?.avg
  })

  bench('Drizzle', async () => {
    await drizzle.select({ avg: users.age }).from(users)
  })

  bench('Prisma', async () => {
    await prisma.user.aggregate({
      _avg: {
        age: true,
      },
    })
  })
})

group('WHERE: Complex conditions', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users')
      .where({ active: true })
      .andWhere(['age', '>', 25])
      .andWhere(['age', '<', 40])
      .get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users')
      .selectAll()
      .where('active', '=', 1 as any)
      .where('age', '>', 25)
      .where('age', '<', 40)
      .execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select()
      .from(users)
      .where(eq(users.active, true))
  })

  bench('Prisma', async () => {
    await prisma.user.findMany({
      where: {
        active: true,
        age: {
          gt: 25,
          lt: 40,
        },
      },
    })
  })
})

group('ORDER BY + LIMIT', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('posts')
      .orderBy('created_at', 'desc')
      .limit(50)
      .get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('posts')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select()
      .from(posts)
      .orderBy(posts.createdAt)
      .limit(50)
  })

  bench('Prisma', async () => {
    await prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })
})

group('GROUP BY + HAVING', () => {
  bench('bun-query-builder', async () => {
    await (bunQB as any).selectFrom('posts').select(['user_id', 'COUNT(id) as post_count']).groupBy('user_id').having(['COUNT(id)', '>', 3]).get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('posts')
      .select(['user_id', ({ fn }) => fn.count('id').as('post_count')])
      .groupBy('user_id')
      .having(({ fn }) => fn.count('id'), '>', 3)
      .execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select({
      userId: posts.userId,
      count: posts.id,
    })
      .from(posts)
      .groupBy(posts.userId)
  })

  bench('Prisma', async () => {
    await prisma.post.groupBy({
      by: ['userId'],
      _count: {
        id: true,
      },
      having: {
        id: {
          _count: {
            gt: 3,
          },
        },
      },
    })
  })
})

// eslint-disable-next-line antfu/no-top-level-await
await run()

closeAll([bunQB, kysely, drizzle, prisma])
console.log('\nBenchmark complete!')
