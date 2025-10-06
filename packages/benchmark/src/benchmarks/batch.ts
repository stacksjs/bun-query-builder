import { bench, run, group } from 'mitata'
import {
  createBunQBClient,
  createKyselyClient,
  createDrizzleClient,
  createPrismaClient,
  closeAll,
} from '../lib/db-clients'
import { users, posts } from '../schemas/drizzle'

console.log('Initializing clients...')
const bunQB = createBunQBClient()
const kysely = createKyselyClient()
const drizzle = createDrizzleClient()
const prisma = createPrismaClient()

console.log('Starting batch operation benchmarks...\n')

group('INSERT MANY: 100 users', () => {
  let counter = 20000

  bench('bun-query-builder', async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      name: `Batch User ${counter + i}`,
      email: `batch${counter + i}@example.com`,
      age: 25 + (i % 30),
      active: true,
    }))
    counter += 100
    await bunQB.insertMany('users', data)
  })

  bench('Kysely', async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      name: `Batch User ${counter + i}`,
      email: `batch${counter + i}@example.com`,
      age: 25 + (i % 30),
      active: true,
    }))
    counter += 100
    await kysely.insertInto('users').values(data).execute()
  })

  bench('Drizzle', async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      name: `Batch User ${counter + i}`,
      email: `batch${counter + i}@example.com`,
      age: 25 + (i % 30),
      active: true,
    }))
    counter += 100
    await drizzle.insert(users).values(data)
  })

  bench('Prisma', async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      name: `Batch User ${counter + i}`,
      email: `batch${counter + i}@example.com`,
      age: 25 + (i % 30),
      active: true,
    }))
    counter += 100
    await prisma.user.createMany({ data })
  })
})

group('UPDATE MANY: Batch update by age range', () => {
  bench('bun-query-builder', async () => {
    await bunQB.updateTable('users')
      .set({ active: false })
      .where(['age', '>', 60])
      .execute()
  })

  bench('Kysely', async () => {
    await kysely.updateTable('users')
      .set({ active: false })
      .where('age', '>', 60)
      .execute()
  })

  bench('Drizzle', async () => {
    await drizzle.update(users)
      .set({ active: false })
  })

  bench('Prisma', async () => {
    await prisma.user.updateMany({
      where: { age: { gt: 60 } },
      data: { active: false },
    })
  })
})

group('DELETE MANY: By IDs', () => {
  bench('bun-query-builder', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 800 + i)
    await bunQB.deleteMany('users', ids)
  })

  bench('Kysely', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 800 + i)
    await kysely.deleteFrom('users').where('id', 'in', ids).execute()
  })

  bench('Drizzle', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 800 + i)
    await drizzle.delete(users)
  })

  bench('Prisma', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 800 + i)
    await prisma.user.deleteMany({
      where: { id: { in: ids } },
    })
  })
})

group('SELECT: Large result set (1000 rows)', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('posts').limit(1000).get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('posts').limit(1000).execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select().from(posts).limit(1000)
  })

  bench('Prisma', async () => {
    await prisma.post.findMany({ take: 1000 })
  })
})

await run()

closeAll([bunQB, kysely, drizzle, prisma])
console.log('\nBenchmark complete!')
