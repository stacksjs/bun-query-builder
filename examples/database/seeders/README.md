# Database Seeders

This directory contains database seeders for populating your database with test data.

## Overview

Seeders use the [ts-mocker](https://github.com/stacksjs/ts-mocker) library (a TypeScript-first faker alternative) to generate realistic fake data for testing and development.

## Creating a Seeder

You can create a new seeder using the CLI:

```bash
bun qb make:seeder User
# or
bun qb make:seeder UserSeeder
```

This will create a new seeder file in `database/seeders/UserSeeder.ts`.

## Writing a Seeder

Each seeder extends the `Seeder` base class and implements a `run` method:

```typescript
import type { QueryBuilder } from 'bun-query-builder'
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  async run(qb: QueryBuilder): Promise<void> {
    const users = Array.from({ length: 10 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }

  // Optional: Control execution order (lower runs first)
  get order(): number {
    return 10 // Default is 100
  }
}
```

## Running Seeders

### Run All Seeders

```bash
bun qb seed
# or
bun qb db:seed
```

### Run a Specific Seeder

```bash
bun qb seed --class UserSeeder
# or
bun qb db:seed --class UserSeeder
```

### Custom Seeders Directory

```bash
bun qb seed --dir ./custom/path/to/seeders
```

## Seeder Execution Order

Seeders are executed in order based on their `order` property. The default order is 100.

In this example:
- **UserSeeder** (order: 10) - Runs first, creates users
- **PostSeeder** (order: 20) - Runs second, creates posts for users
- **CommentSeeder** (order: 30) - Runs last, creates comments on posts

This ensures that foreign key relationships are respected.

## Fresh Database

To drop all tables, re-run migrations, and seed the database:

```bash
bun qb db:fresh
```

This is useful when you want to completely reset your database to a clean state.

## Using ts-mocker (Faker)

ts-mocker provides a wide range of fake data generators:

```typescript
// People
faker.person.fullName()
faker.person.firstName()
faker.person.lastName()

// Internet
faker.internet.email()
faker.internet.url()
faker.internet.userName()
faker.internet.password()

// Numbers
faker.number.int({ min: 1, max: 100 })
faker.number.float({ min: 0, max: 1 })

// Text
faker.lorem.sentence()
faker.lorem.paragraph()
faker.lorem.paragraphs({ min: 2, max: 5 })
faker.lorem.word()

// Dates
faker.date.past()
faker.date.future()
faker.date.recent({ days: 30 })

// Helpers
faker.helpers.arrayElement(['admin', 'user', 'guest'])
faker.helpers.shuffle([1, 2, 3])
faker.datatype.boolean()

// Company
faker.company.name()
faker.company.catchPhrase()

// Address
faker.location.city()
faker.location.country()
faker.location.streetAddress()
```

For more information, see the [ts-mocker documentation](https://github.com/stacksjs/ts-mocker).

## Best Practices

1. **Order Matters**: Use the `order` property to ensure seeders run in the correct order
2. **Batch Inserts**: Insert records in batches to improve performance for large datasets
3. **Check Dependencies**: Verify that required data exists before creating dependent records
4. **Realistic Data**: Use faker to generate realistic data that resembles production data
5. **Idempotency**: Design seeders to be run multiple times safely (consider using `db:fresh`)

## Example Workflow

1. Create your models
2. Generate migrations: `bun qb migrate ./app/Models`
3. Create seeders: `bun qb make:seeder User`
4. Write seeder logic
5. Run seeders: `bun qb seed`

Or do it all at once:

```bash
bun qb db:fresh
```
