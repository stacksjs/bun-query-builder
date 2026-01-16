# bun-query-builder TODO

## Architecture Decision: SQL vs DynamoDB Separation

**Rationale:** SQL and DynamoDB are fundamentally different paradigms. Forcing them into a unified "driver" abstraction fights against DynamoDB's nature.

| SQL | DynamoDB |
|-----|----------|
| Table-centric | Entity-centric |
| Normalized (multiple tables) | Single-table design |
| JOINs for relationships | Denormalization / multiple queries |
| WHERE clauses | pk/sk key conditions |
| GROUP BY, HAVING | GSI/LSI for access patterns |

**Solution:** Separate entry points with paradigm-appropriate APIs.

---

## Package Structure

```
bun-query-builder/
├── src/
│   ├── sql/                    # SQL-specific
│   │   ├── drivers/
│   │   │   ├── mysql.ts
│   │   │   ├── postgres.ts
│   │   │   └── sqlite.ts
│   │   ├── query-builder.ts    # JOINs, WHERE, GROUP BY, etc.
│   │   └── index.ts
│   │
│   ├── dynamodb/               # DynamoDB-specific (extends dynamodb-tooling)
│   │   ├── driver.ts           # Wraps dynamodb-tooling
│   │   ├── query-builder.ts    # pk(), sk(), index(), entity patterns
│   │   ├── adapter.ts          # DynamoDBToolingAdapter
│   │   └── index.ts
│   │
│   ├── core/                   # Shared concepts only
│   │   ├── connection.ts
│   │   ├── types.ts
│   │   └── base-builder.ts
│   │
│   └── index.ts                # Main exports
```

---

## Usage Examples

### SQL (Table-Centric)

```typescript
import { db } from 'bun-query-builder'

// Configure SQL connection
db.connection({
  driver: 'mysql', // or 'postgres', 'sqlite'
  host: 'localhost',
  database: 'myapp',
})

// Table-centric queries with JOINs
const users = await db.table('users')
  .select('users.id', 'users.name', 'posts.title')
  .join('posts', 'users.id', '=', 'posts.user_id')
  .where('users.name', 'like', '%John%')
  .whereIn('users.status', ['active', 'pending'])
  .groupBy('users.id')
  .having('count(posts.id)', '>', 5)
  .orderBy('users.created_at', 'desc')
  .limit(10)
  .get()

// Transactions
await db.transaction(async (trx) => {
  await trx.table('users').insert({ name: 'John' })
  await trx.table('profiles').insert({ user_id: 1, bio: '...' })
})
```

### DynamoDB (Entity-Centric) - Extends dynamodb-tooling

```typescript
import { dynamo } from 'bun-query-builder/dynamodb'

// Configure DynamoDB connection
dynamo.connection({
  region: 'us-east-1',
  table: 'MyApp',  // Single table!
})

// Entity-centric queries (NO JOINs - different paradigm)
const users = await dynamo.entity('User')
  .pk('USER#123')
  .sk.beginsWith('PROFILE#')
  .index('GSI1')
  .project('name', 'email')
  .get()

// Query by access pattern
const userPosts = await dynamo.entity('Post')
  .pk('USER#123')
  .sk.between('POST#2024-01', 'POST#2024-12')
  .get()

// Batch operations
await dynamo.batchWrite([
  { put: { entity: 'User', item: { id: '123', name: 'John' } } },
  { delete: { entity: 'User', pk: 'USER#456', sk: 'USER#456' } },
])

// Transactions (DynamoDB style)
await dynamo.transactWrite([
  { put: { entity: 'User', item: { id: '123', name: 'John' } } },
  { update: { entity: 'Counter', pk: 'COUNTER#users', add: { count: 1 } } },
])
```

---

## SQL Driver Status

### MySQL Driver
**Status:** Complete
- [x] Connection management
- [x] Query building (SELECT, INSERT, UPDATE, DELETE)
- [x] JOINs (INNER, LEFT, RIGHT, CROSS)
- [x] WHERE conditions (=, !=, <, >, LIKE, IN, BETWEEN, NULL)
- [x] GROUP BY, HAVING
- [x] ORDER BY, LIMIT, OFFSET
- [x] Transactions
- [x] Raw queries

### PostgreSQL Driver
**Status:** Complete
- [x] All MySQL features
- [x] RETURNING clause
- [x] JSON/JSONB operations
- [x] Array operations

### SQLite Driver
**Status:** Complete
- [x] All core features
- [x] File-based and in-memory modes

---

## DynamoDB Module Status

### DynamoDB Query Builder
**Status:** Complete
**Description:** Entity-centric query builder that extends dynamodb-tooling.

- [x] Design entity-centric API (not table-centric)
- [x] Implement pk/sk key condition builders
- [x] Support GSI/LSI index selection
- [x] Integrate with dynamodb-tooling single-table patterns
- [x] Add DynamoDBToolingAdapter for Stacks models
- [x] Comprehensive test suite (84 tests)

### Integration with dynamodb-tooling
**Status:** Complete
**Description:** bun-query-builder/dynamodb extends dynamodb-tooling for:

- Single-table design patterns
- Stacks model transformation
- Key pattern generation (pk/sk)
- GSI/LSI derivation
- Entity transformation
- Relationship resolution

```typescript
// Under the hood, bun-query-builder/dynamodb uses:
import {
  EntityTransformer,
  KeyPatternGenerator,
  AccessPatternGenerator,
  DynamoDBModel
} from 'dynamodb-tooling'
```

---

## Key Differences: SQL vs DynamoDB API

| Operation | SQL (`db.table()`) | DynamoDB (`dynamo.entity()`) |
|-----------|--------------------|-----------------------------|
| Select | `.select('col1', 'col2')` | `.project('attr1', 'attr2')` |
| Filter | `.where('col', '=', val)` | `.pk(val)` / `.filter('attr', '=', val)` |
| Join | `.join('table', ...)` | N/A (use denormalization) |
| Group | `.groupBy('col')` | N/A (aggregate client-side) |
| Index | N/A (auto) | `.index('GSI1')` |
| Sort | `.orderBy('col')` | `.sk.between(a, b)` (sort key) |

---

## Notes

- **Don't unify what shouldn't be unified** - SQL and DynamoDB have different mental models
- **SQL is table-centric**: `db.table('users')` - multiple tables, JOINs
- **DynamoDB is entity-centric**: `dynamo.entity('User')` - single table, multiple entity types
- **dynamodb-tooling provides the foundation** - bun-query-builder/dynamodb is a fluent wrapper
- **Stacks models work with both** - SQL uses migrations, DynamoDB uses single-table transformation
