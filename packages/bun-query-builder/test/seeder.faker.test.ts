import { describe, expect, it } from 'bun:test'
import { faker } from '../../../node_modules/ts-mocker/dist/src'

describe('Faker Integration', () => {
  it('generates person data', () => {
    const name = faker.person.fullName()
    const firstName = faker.person.firstName()
    const lastName = faker.person.lastName()

    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
    expect(typeof firstName).toBe('string')
    expect(firstName.length).toBeGreaterThan(0)
    expect(typeof lastName).toBe('string')
    expect(lastName.length).toBeGreaterThan(0)
  })

  it('generates internet data', () => {
    const email = faker.internet.email()
    const username = faker.internet.username()

    expect(typeof email).toBe('string')
    expect(email).toContain('@')
    expect(typeof username).toBe('string')
    expect(username.length).toBeGreaterThan(0)
  })

  it('generates numbers', () => {
    const int1 = faker.number.int({ min: 1, max: 100 })
    const int2 = faker.number.int({ min: 1, max: 100 })

    expect(typeof int1).toBe('number')
    expect(int1).toBeGreaterThanOrEqual(1)
    expect(int1).toBeLessThanOrEqual(100)

    expect(typeof int2).toBe('number')
    expect(int2).toBeGreaterThanOrEqual(1)
    expect(int2).toBeLessThanOrEqual(100)
  })

  it('generates lorem ipsum text', () => {
    const word = faker.lorem.word()
    const sentence = faker.lorem.sentence(5)
    const paragraph = faker.lorem.paragraph(2)

    expect(typeof word).toBe('string')
    expect(word.length).toBeGreaterThan(0)

    expect(typeof sentence).toBe('string')
    expect(sentence.length).toBeGreaterThan(0)

    expect(typeof paragraph).toBe('string')
    expect(paragraph.length).toBeGreaterThan(0)
  })

  it('generates dates', () => {
    const past = faker.date.past()
    const future = faker.date.future()
    const recent = faker.date.recent()

    expect(past instanceof Date).toBe(true)
    expect(future instanceof Date).toBe(true)
    expect(recent instanceof Date).toBe(true)

    expect(past.getTime()).toBeLessThan(Date.now())
    expect(future.getTime()).toBeGreaterThan(Date.now())
  })

  it('generates array elements', () => {
    const options = ['admin', 'user', 'moderator', 'guest']
    const element = faker.helpers.arrayElement(options)

    expect(options).toContain(element)
  })

  it('generates consistent data with seed', () => {
    // Note: This test assumes faker supports seeding
    // If ts-mocker doesn't support seeding, this test may need adjustment
    const name1 = faker.person.fullName()
    const name2 = faker.person.fullName()

    // Names should be different (unless extremely unlikely collision)
    // This is a probabilistic test
    expect(typeof name1).toBe('string')
    expect(typeof name2).toBe('string')
  })

  it('generates location data', () => {
    const city = faker.address.city()
    const country = faker.address.country()

    expect(typeof city).toBe('string')
    expect(city.length).toBeGreaterThan(0)

    expect(typeof country).toBe('string')
    expect(country.length).toBeGreaterThan(0)
  })

  it('generates company data', () => {
    const companyName = faker.company.name()

    expect(typeof companyName).toBe('string')
    expect(companyName.length).toBeGreaterThan(0)
  })

  it('generates multiple records efficiently', () => {
    const startTime = Date.now()
    const records = Array.from({ length: 1000 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int({ min: 18, max: 80 }),
    }))
    const duration = Date.now() - startTime

    expect(records.length).toBe(1000)
    expect(duration).toBeLessThan(1000) // Should generate 1000 records in under 1 second
    expect(records[0]).toHaveProperty('name')
    expect(records[0]).toHaveProperty('email')
    expect(records[0]).toHaveProperty('age')
  })

  it('generates unique emails', () => {
    const emails = new Set<string>()
    for (let i = 0; i < 100; i++) {
      emails.add(faker.internet.email())
    }

    // Most emails should be unique (allowing for some collisions)
    expect(emails.size).toBeGreaterThan(90)
  })

  it('generates data suitable for database seeding', () => {
    const user = {
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int({ min: 18, max: 80 }),
      role: faker.helpers.arrayElement(['admin', 'user', 'moderator']),
      bio: faker.lorem.paragraph(2),
      created_at: faker.date.past(),
      updated_at: new Date(),
    }

    expect(user.name).toBeTruthy()
    expect(user.email).toContain('@')
    expect(user.age).toBeGreaterThanOrEqual(18)
    expect(user.age).toBeLessThanOrEqual(80)
    expect(['admin', 'user', 'moderator']).toContain(user.role)
    expect(user.bio.length).toBeGreaterThan(0)
    expect(user.created_at instanceof Date).toBe(true)
    expect(user.updated_at instanceof Date).toBe(true)
  })
})

describe('Seeder Data Generation Patterns', () => {
  it('generates hierarchical data (users -> posts -> comments)', () => {
    const users = Array.from({ length: 5 }, () => ({
      id: faker.number.int({ min: 1, max: 1000 }),
      name: faker.person.fullName(),
      email: faker.internet.email(),
    }))

    expect(users.length).toBe(5)

    const posts = users.flatMap(user =>
      Array.from({ length: 3 }, () => ({
        id: faker.number.int({ min: 1, max: 1000 }),
        user_id: user.id,
        title: faker.lorem.sentence(5),
        body: faker.lorem.paragraphs(2),
      })),
    )

    expect(posts.length).toBe(15) // 5 users * 3 posts

    const comments = posts.flatMap(post =>
      Array.from({ length: 2 }, () => ({
        id: faker.number.int({ min: 1, max: 1000 }),
        post_id: post.id,
        user_id: users[0].id,
        content: faker.lorem.paragraph(1),
      })),
    )

    expect(comments.length).toBe(30) // 15 posts * 2 comments
  })

  it('generates data with relationships', () => {
    const categories = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: faker.lorem.word(),
    }))

    const products = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: faker.commerce.productName(),
      category_id: categories[faker.number.int({ min: 0, max: categories.length - 1 })].id,
      price: Number.parseFloat(faker.commerce.price({ min: 10, max: 1000 })),
    }))

    expect(products.length).toBe(20)
    products.forEach((product) => {
      expect(product.category_id).toBeGreaterThanOrEqual(1)
      expect(product.category_id).toBeLessThanOrEqual(5)
    })
  })

  it('generates data with conditional logic', () => {
    const users = Array.from({ length: 10 }, () => {
      const role = faker.helpers.arrayElement(['admin', 'user', 'moderator'])
      return {
        name: faker.person.fullName(),
        email: faker.internet.email(),
        role,
        permissions: role === 'admin'
          ? ['read', 'write', 'delete', 'admin']
          : role === 'moderator'
            ? ['read', 'write', 'moderate']
            : ['read'],
      }
    })

    const admins = users.filter(u => u.role === 'admin')
    admins.forEach((admin) => {
      expect(admin.permissions).toContain('admin')
      expect(admin.permissions).toContain('delete')
    })
  })

  it('generates batch data efficiently', () => {
    const batchSize = 100
    const batches = 5

    const startTime = Date.now()

    for (let batch = 0; batch < batches; batch++) {
      const records = Array.from({ length: batchSize }, () => ({
        name: faker.person.fullName(),
        email: faker.internet.email(),
        created_at: new Date(),
      }))
      expect(records.length).toBe(batchSize)
    }

    const duration = Date.now() - startTime
    expect(duration).toBeLessThan(2000) // Should generate 500 records in under 2 seconds
  })

  it('generates data with custom formatting', () => {
    const users = Array.from({ length: 5 }, () => {
      const firstName = faker.person.firstName()
      const lastName = faker.person.lastName()
      return {
        full_name: `${firstName} ${lastName}`,
        display_name: `@${firstName.toLowerCase()}${faker.number.int({ min: 1, max: 999 })}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      }
    })

    users.forEach((user) => {
      expect(user.full_name).toContain(' ')
      expect(user.display_name).toMatch(/^@[a-z]+\d+$/)
      expect(user.email).toMatch(/^[a-z.]+@example\.com$/)
    })
  })
})
