# Database Seeding

Database seeding allows you to populate your database with test data using realistic fake data generation powered by [ts-mocker](https://github.com/stacksjs/ts-mocker), a TypeScript-first faker alternative built for Bun.

## Overview

Seeders are classes that define how to populate your database tables with sample data. They're particularly useful for:

- **Development**: Quickly populate your local database with realistic test data
- **Testing**: Create consistent datasets for automated tests
- **Demos**: Generate realistic data for demonstrations
- **CI/CD**: Seed databases in staging/testing environments

## Installation

Seeding functionality is built-in, but you'll need the `ts-mocker` package for fake data generation:

```bash
bun add ts-mocker
```

## Quick Start

### Creating a Seeder

Use the CLI to generate a new seeder file:

```bash
bun qb make:seeder User
```

This creates `database/seeders/UserSeeder.ts`:

```typescript
import type { QueryBuilder } from 'bun-query-builder'
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  /**
   * Run the database seeds.
   */
  async run(qb: QueryBuilder): Promise<void> {
    // Example: Create 10 records
    const users = Array.from({ length: 10 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()

    console.log('Seeded 10 users')
  }

  /**
   * Specify the order in which this seeder should run.
   * Lower numbers run first. Default is 100.
   */
  get order(): number {
    return 100
  }
}
```

### Running Seeders

```bash
# Run all seeders
bun qb seed

# Or use the db:seed alias
bun qb db:seed

# Run a specific seeder
bun qb seed --class UserSeeder

# Custom seeders directory
bun qb seed --dir ./custom/path/to/seeders
```

## Writing Seeders

### Basic Seeder

```typescript
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class ProductSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const products = Array.from({ length: 50 }, () => ({
      name: faker.commerce.productName(),
      description: faker.commerce.productDescription(),
      price: faker.commerce.price(10, 1000),
      stock: faker.number.int(0, 100),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('products').insert(products).execute()
  }
}
```

### Seeder with Dependencies

When seeding related data, use the `order` property to ensure seeders run in the correct sequence:

```typescript
// UserSeeder.ts - Runs first
export default class UserSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = Array.from({ length: 10 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int(18, 80),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }

  get order(): number {
    return 10 // Run first
  }
}

// PostSeeder.ts - Runs second
export default class PostSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    // Get all user IDs
    const users = await qb.table('users').select(['id']).execute()

    if (users.length === 0) {
      console.log('No users found, skipping posts')
      return
    }

    // Create 3 posts per user
    const posts = []
    for (const user of users) {
      for (let i = 0; i < 3; i++) {
        posts.push({
          user_id: user.id,
          title: faker.lorem.sentence(5),
          body: faker.lorem.paragraphs(3),
          published: faker.datatype.boolean(0.7), // 70% published
          created_at: faker.date.past(),
          updated_at: new Date(),
        })
      }
    }

    await qb.table('posts').insert(posts).execute()
  }

  get order(): number {
    return 20 // Run after users
  }
}
```

### Batch Inserts

For large datasets, use batch inserts to improve performance:

```typescript
export default class LargeDataSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const totalRecords = 1000
    const batchSize = 100

    for (let i = 0; i < totalRecords; i += batchSize) {
      const batch = Array.from({ length: batchSize }, () => ({
        name: faker.person.fullName(),
        email: faker.internet.email(),
        created_at: new Date(),
        updated_at: new Date(),
      }))

      await qb.table('users').insert(batch).execute()
      console.log(`Seeded ${i + batchSize} / ${totalRecords} records`)
    }
  }
}
```

### Conditional Seeding

Check for existing data before seeding:

```typescript
export default class ConditionalSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    // Check if data already exists
    const existingUsers = await qb.table('users').count()

    if (existingUsers > 0) {
      console.log('Users already exist, skipping seeding')
      return
    }

    // Seed data only if none exists
    const users = Array.from({ length: 10 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }
}
```

## Using ts-mocker (Faker)

ts-mocker provides a wide range of fake data generators:

### Person Data

```typescript
faker.person.fullName()          // "John Doe"
faker.person.firstName()         // "John"
faker.person.lastName()          // "Doe"
faker.person.jobTitle()          // "Software Engineer"
```

### Internet Data

```typescript
faker.internet.email()           // "john.doe@example.com"
faker.internet.userName()        // "john_doe123"
faker.internet.url()             // "https://example.com"
faker.internet.password()        // "aB3$dF7!"
```

### Numbers

```typescript
faker.number.int(1, 100)         // Random integer between 1-100
faker.number.float(0, 1)         // Random float between 0-1
```

### Text & Lorem Ipsum

```typescript
faker.lorem.word()               // "lorem"
faker.lorem.sentence(5)          // "Lorem ipsum dolor sit amet"
faker.lorem.paragraph(3)         // Multiple sentences
faker.lorem.paragraphs(2)        // Multiple paragraphs
```

### Dates

```typescript
faker.date.past()                // Random past date
faker.date.future()              // Random future date
faker.date.recent()              // Recent date (last 30 days)
```

### Helpers

```typescript
faker.helpers.arrayElement(['admin', 'user', 'moderator'])  // Random from array
faker.helpers.shuffle([1, 2, 3, 4, 5])                     // Shuffled array
faker.datatype.boolean(0.7)                                 // 70% chance true
```

### Commerce

```typescript
faker.commerce.productName()     // "Handcrafted Steel Shoes"
faker.commerce.price(10, 1000)   // "542.99"
faker.commerce.department()      // "Electronics"
```

### Location

```typescript
faker.location.city()            // "San Francisco"
faker.location.country()         // "United States"
faker.location.streetAddress()   // "123 Main Street"
```

### Company

```typescript
faker.company.name()             // "Acme Corporation"
faker.company.catchPhrase()      // "Innovative solutions"
```

## CLI Commands

### make:seeder

Generate a new seeder file:

```bash
bun qb make:seeder User
bun qb make:seeder UserSeeder  # "Seeder" suffix is optional
```

### seed

Run all seeders:

```bash
bun qb seed                      # Run all seeders
bun qb seed --verbose            # With verbose logging
bun qb seed --dir ./seeders      # Custom directory
```

### db:seed

Alias for `seed` command:

```bash
bun qb db:seed
bun qb db:seed --class UserSeeder  # Run specific seeder
```

### db:fresh

Drop all tables, re-run migrations, and seed the database:

```bash
bun qb db:fresh

# With custom paths
bun qb db:fresh --models ./app/Models --seeders ./database/seeders
```

This is perfect for resetting your database to a clean state with fresh data.

## Programmatic Usage

You can also run seeders programmatically:

```typescript
import { runSeeders, runSeeder, makeSeeder } from 'bun-query-builder'

// Run all seeders
await runSeeders({
  seedersDir: './database/seeders',
  verbose: true
})

// Run specific seeder
await runSeeder('UserSeeder', { verbose: true })

// Create new seeder programmatically
await makeSeeder('Product')
```

## Workflow Example

Complete workflow from models to seeded database:

```bash
# 1. Generate migrations from models
bun qb migrate ./app/Models --dialect postgres

# 2. Create seeders for each model
bun qb make:seeder User
bun qb make:seeder Post
bun qb make:seeder Comment

# 3. Edit seeders to add data generation logic
# (Edit database/seeders/UserSeeder.ts, etc.)

# 4. Run seeders
bun qb seed

# Or do it all at once with db:fresh
bun qb db:fresh
```

## Best Practices

### 1. Use Execution Order

Define clear execution order for dependent data:

```typescript
// Users must exist before posts
class UserSeeder extends Seeder {
  get order(): number { return 10 }
}

class PostSeeder extends Seeder {
  get order(): number { return 20 }
}

class CommentSeeder extends Seeder {
  get order(): number { return 30 }
}
```

### 2. Batch Large Datasets

Insert records in batches for better performance:

```typescript
const batchSize = 100
for (let i = 0; i < total; i += batchSize) {
  const batch = records.slice(i, i + batchSize)
  await qb.table('users').insert(batch).execute()
}
```

### 3. Check for Existing Data

Prevent duplicate seeding:

```typescript
const count = await qb.table('users').count()
if (count > 0) {
  console.log('Data already exists, skipping')
  return
}
```

### 4. Generate Realistic Data

Use appropriate faker methods for each field:

```typescript
{
  email: faker.internet.email(),           // Valid email format
  phone: faker.phone.number(),             // Valid phone number
  age: faker.number.int(18, 80),          // Reasonable age range
  country: faker.location.country(),       // Real country names
  created_at: faker.date.past(),          // Past dates for created_at
}
```

### 5. Make Seeders Idempotent

Design seeders to be safely run multiple times:

```typescript
// Clear existing data first
await qb.table('users').delete().execute()

// Then seed
await qb.table('users').insert(users).execute()
```

### 6. Document Your Seeders

Add comments explaining what data is being created:

```typescript
/**
 * Seeds the database with:
 * - 50 users with various roles
 * - 3-5 posts per user
 * - Comments distributed across posts
 */
export default class UserSeeder extends Seeder {
  // ...
}
```

## File Structure

Recommended project structure:

```
project/
├── app/
│   └── Models/
│       ├── User.ts
│       ├── Post.ts
│       └── Comment.ts
├── database/
│   └── seeders/
│       ├── UserSeeder.ts        # order: 10
│       ├── PostSeeder.ts        # order: 20
│       └── CommentSeeder.ts     # order: 30
└── sql/                         # Generated migrations
    └── *.sql
```

## Advanced Patterns

### Factory Pattern

Create a factory function for reusable data generation:

```typescript
function createUser(overrides = {}) {
  return {
    name: faker.person.fullName(),
    email: faker.internet.email(),
    age: faker.number.int(18, 80),
    role: 'user',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

export default class UserSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = [
      createUser({ role: 'admin', email: 'admin@example.com' }),
      createUser({ role: 'moderator' }),
      ...Array.from({ length: 48 }, () => createUser()),
    ]

    await qb.table('users').insert(users).execute()
  }
}
```

### Relationship Seeding

Seed many-to-many relationships:

```typescript
export default class UserRoleSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const users = await qb.table('users').select(['id']).execute()
    const roles = await qb.table('roles').select(['id']).execute()

    const userRoles = users.flatMap(user =>
      faker.helpers.arrayElements(roles, faker.number.int(1, 3))
        .map(role => ({
          user_id: user.id,
          role_id: role.id,
        }))
    )

    await qb.table('user_roles').insert(userRoles).execute()
  }

  get order(): number {
    return 50 // Run after users and roles
  }
}
```

### Environment-Specific Seeding

```typescript
export default class EnvironmentSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    const env = process.env.NODE_ENV

    if (env === 'production') {
      console.log('Skipping seeding in production')
      return
    }

    const recordCount = env === 'development' ? 100 : 10

    const users = Array.from({ length: recordCount }, () =>
      createUser()
    )

    await qb.table('users').insert(users).execute()
  }
}
```

## Troubleshooting

### Seeder Not Found

If you get "Seeder not found" error:

```bash
# Make sure seeder file exists
ls database/seeders/UserSeeder.ts

# Verify you're using the correct class name
bun qb seed --class UserSeeder
```

### Import Errors

Ensure your seeder imports are correct:

```typescript
// ✅ Correct
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

// ❌ Incorrect
import Seeder from 'bun-query-builder'
```

### Foreign Key Errors

Run seeders in the correct order:

```typescript
// Parent table seeder
class UserSeeder extends Seeder {
  get order(): number { return 10 }
}

// Child table seeder
class PostSeeder extends Seeder {
  get order(): number { return 20 } // Must be > 10
}
```

## Next Steps

- Explore [Migrations](./migrations) to manage your database schema
- Learn about [CLI Commands](./cli) for all available commands
- Check out [Query Builder](./builder) for advanced querying
- Read about [Transactions](./transactions) for data integrity

## Related

- [ts-mocker Documentation](https://github.com/stacksjs/ts-mocker)
- [Migrations](./migrations)
- [CLI Reference](./cli)
