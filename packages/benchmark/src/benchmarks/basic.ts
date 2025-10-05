import { bench, run, group } from 'mitata'
import { eq } from 'drizzle-orm'
import {
  createBunQBClient,
  createKyselyClient,
  createDrizzleClient,
  createTypeORMClient,
  createPrismaClient,
  closeAll,
} from '../lib/db-clients'
import { users, posts } from '../schemas/drizzle'
import { User as TypeORMUser, Post as TypeORMPost } from '../schemas/typeorm'

console.log('Initializing clients...')
const bunQB = createBunQBClient()
const kysely = createKyselyClient()
const drizzle = createDrizzleClient()
const typeorm = await createTypeORMClient()
const prisma = createPrismaClient()

const hasTypeORM = typeorm !== null
console.log('Starting basic query benchmarks...\n')

group('SELECT: Find user by ID', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').where({ id: 500 }).first()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users').where('id', '=', 500).executeTakeFirst()
  })

  bench('Drizzle', async () => {
    await drizzle.select().from(users).where(eq(users.id, 500)).limit(1)
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).findOne({ where: { id: 500 } })
    })
  }

  bench('Prisma', async () => {
    await prisma.user.findUnique({ where: { id: 500 } })
  })
})

group('SELECT: Get all active users', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').where({ active: true }).get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users').where('active', '=', 1).execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select().from(users).where(eq(users.active, true))
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).find({ where: { active: true } })
    })
  }

  bench('Prisma', async () => {
    await prisma.user.findMany({ where: { active: true } })
  })
})

group('SELECT: Get users with limit', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').limit(10).get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users').limit(10).execute()
  })

  bench('Drizzle', async () => {
    await drizzle.select().from(users).limit(10)
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).find({ take: 10 })
    })
  }

  bench('Prisma', async () => {
    await prisma.user.findMany({ take: 10 })
  })
})

group('SELECT: Count users', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').count()
  })

  bench('Kysely', async () => {
    const result = await kysely.selectFrom('users')
      .select(({ fn }) => fn.count('id').as('count'))
      .executeTakeFirst()
    return result?.count
  })

  bench('Drizzle', async () => {
    await drizzle.select({ count: users.id }).from(users)
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).count()
    })
  }

  bench('Prisma', async () => {
    await prisma.user.count()
  })
})

group('INSERT: Single user', () => {
  let counter = 10000

  bench('bun-query-builder', async () => {
    counter++
    await bunQB.insert('users', {
      name: `Benchmark User ${counter}`,
      email: `bench${counter}@example.com`,
      age: 25,
      active: true,
    })
  })

  bench('Kysely', async () => {
    counter++
    await kysely.insertInto('users').values({
      name: `Benchmark User ${counter}`,
      email: `bench${counter}@example.com`,
      age: 25,
      active: true,
    }).execute()
  })

  bench('Drizzle', async () => {
    counter++
    await drizzle.insert(users).values({
      name: `Benchmark User ${counter}`,
      email: `bench${counter}@example.com`,
      age: 25,
      active: true,
    })
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      counter++
      await typeorm!.getRepository(TypeORMUser).save({
        name: `Benchmark User ${counter}`,
        email: `bench${counter}@example.com`,
        age: 25,
        active: true,
      })
    })
  }

  bench('Prisma', async () => {
    counter++
    await prisma.user.create({
      data: {
        name: `Benchmark User ${counter}`,
        email: `bench${counter}@example.com`,
        age: 25,
        active: true,
      },
    })
  })
})

group('UPDATE: Single user', () => {
  bench('bun-query-builder', async () => {
    await bunQB.update('users', { age: 30 }).where({ id: 100 })
  })

  bench('Kysely', async () => {
    await kysely.updateTable('users').set({ age: 30 }).where('id', '=', 100).execute()
  })

  bench('Drizzle', async () => {
    await drizzle.update(users).set({ age: 30 }).where(eq(users.id, 100))
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).update({ id: 100 }, { age: 30 })
    })
  }

  bench('Prisma', async () => {
    await prisma.user.update({
      where: { id: 100 },
      data: { age: 30 },
    })
  })
})

group('DELETE: Single user', () => {
  bench('bun-query-builder', async () => {
    await bunQB.delete('users').where({ id: 999 })
  })

  bench('Kysely', async () => {
    await kysely.deleteFrom('users').where('id', '=', 999).execute()
  })

  bench('Drizzle', async () => {
    await drizzle.delete(users).where(eq(users.id, 999))
  })

  if (hasTypeORM) {
    bench('TypeORM', async () => {
      await typeorm!.getRepository(TypeORMUser).delete({ id: 999 })
    })
  }

  bench('Prisma', async () => {
    await prisma.user.delete({ where: { id: 999 } }).catch(() => {})
  })
})

await run()

closeAll([bunQB, kysely, drizzle, typeorm, prisma])
console.log('\nBenchmark complete!')
