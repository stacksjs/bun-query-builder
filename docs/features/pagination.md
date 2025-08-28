# Pagination

High-level helpers for paging and processing large result sets efficiently. Choose between offset-based pagination, simple “has more” pagination, and cursor-based pagination depending on your use case. For background processing, use `chunk`, `chunkById`, and `eachById`.

## Overview of Pagination Strategies

- paginate: Accurate total count, good for UIs with page numbers. Heavier due to COUNT(*) subquery.
- simplePaginate: No total count, returns `hasMore`. Faster for infinite scroll with page numbers less important.
- cursorPaginate: Uses a cursor column for stable sequential retrieval. Best for real-time/infinite scrolling.

## paginate(): Classic Offset Pagination

Returns `{ data, meta: { perPage, page, total, lastPage } }`.

```ts
const { data, meta } = await db
  .selectFrom('users')
  .where({ active: true })
  .paginate(20, 1)

// meta.total, meta.lastPage available
```

Implementation details:

- Executes a `COUNT(*)` on the subquery to compute `total`
- Applies `LIMIT` and `OFFSET` for the requested page

## simplePaginate(): Lightweight Pagination

Returns `{ data, meta: { perPage, page, hasMore } }`.

```ts
const { data, meta } = await db
  .selectFrom('users')
  .simplePaginate(50, 2)

// meta.hasMore indicates more pages beyond current
```

Implementation details:

- Fetches `perPage + 1` rows and trims to `perPage`
- `hasMore` is computed from the extra fetched row

## cursorPaginate(): Stable Cursor Pagination

Returns `{ data, meta: { perPage, nextCursor, prevCursor? } }`.

```ts
const page1 = await db
  .selectFrom('users')
  .cursorPaginate(25, undefined, 'id', 'asc')

const page2 = await db
  .selectFrom('users')
  .cursorPaginate(25, page1.meta.nextCursor, 'id', 'asc')
```

Implementation details:

- Adds `WHERE column > cursor` (or `<` for desc) to fetch the next window
- Orders by the cursor column to ensure deterministic order

### Composite cursors

You can pass multiple columns for deterministic ordering, e.g. `['created_at', 'id']`.

```ts
const page = await db
  .selectFrom('users')
  .cursorPaginate(50, undefined, ['created_at', 'id'], 'asc')

// use page.meta.nextCursor to fetch the next window
```

### Choosing a cursor column

- Default is `id`. Use a monotonically increasing column (e.g., timestamps or numeric ids)
- Avoid volatile columns that can reorder between requests

## Chunking: chunk, chunkById, eachById

### chunk(size, handler)

Paginates using `paginate()` internally and invokes `handler(rows)` per page until exhausted.

```ts
await db.selectFrom('users').chunk(1000, async (rows) => {
  // process each page of 1000
})
```

### chunkById(size, column?, handler?)

Paginates using `cursorPaginate()` for memory-friendly processing.

```ts
await db.selectFrom('users').chunkById(1000, 'id', async (rows) => {
  // process 1000 rows at a time
})
```

### eachById(size, column?, handler?)

Iterates row-by-row using `chunkById`.

```ts
await db.selectFrom('users').eachById(500, 'id', async (row) => {
  // process row
})
```

## Choosing a Strategy

- Need total pages? Use `paginate`.
- Infinite scroll where counts don’t matter? Use `simplePaginate` or `cursorPaginate`.
- Large background processing? Use `chunkById` or `eachById`.

## Examples

### User Interface Pagination

```ts
// Admin dashboard with page numbers
async function getUsersPage(page: number = 1, perPage: number = 20) {
  const { data, meta } = await db
    .selectFrom('users')
    .select('users', 'id', 'name', 'email', 'role', 'created_at')
    .where({ active: true })
    .orderBy('created_at', 'desc')
    .paginate(perPage, page)

  return {
    users: data,
    pagination: {
      currentPage: meta.page,
      totalPages: meta.lastPage,
      totalUsers: meta.total,
      perPage: meta.perPage,
      hasNextPage: meta.page < meta.lastPage,
      hasPrevPage: meta.page > 1
    }
  }
}

// Chris's project dashboard
const chrisProjects = await db
  .selectFrom('projects')
  .where({ owner: 'Chris' })
  .orderBy('updated_at', 'desc')
  .paginate(10, 1)
```

### Infinite Scroll Implementation

```ts
// Feed or timeline with infinite scroll
async function getInfinitePosts(cursor?: string) {
  const page = await db
    .selectFrom('posts')
    .select('posts', 'id', 'title', 'content', 'author_id', 'created_at')
    .with('Author')
    .where({ published: true })
    .cursorPaginate(20, cursor, 'created_at', 'desc')

  return {
    posts: page.data,
    nextCursor: page.meta.nextCursor,
    hasMore: !!page.meta.nextCursor
  }
}

// Client-side infinite scroll usage
const allPosts: any[] = []
let cursor: string | undefined

async function loadMorePosts() {
  const { posts, nextCursor, hasMore } = await getInfinitePosts(cursor)
  allPosts.push(...posts)
  cursor = nextCursor
  return hasMore
}

// Load initial posts
await loadMorePosts()

// Load more when user scrolls
while (await loadMorePosts()) {
  // Continue loading until no more posts
}
```

### Background Processing

```ts
// Bulk email processing with chunking
async function sendNewsletterToAllUsers() {
  let processedCount = 0

  await db
    .selectFrom('users')
    .where({ email_verified: true, newsletter_subscribed: true })
    .chunkById(100, 'id', async (userBatch) => {
      // Process batch of users
      for (const user of userBatch) {
        await sendNewsletterEmail(user.email, user.name)
        processedCount++
      }

      console.log(`Processed ${processedCount} users so far...`)
    })

  console.log(`Newsletter sent to ${processedCount} users total`)
}

// Data export with progress tracking
async function exportUserData() {
  const exportFile = createWriteStream('users-export.csv')
  let exportedCount = 0

  // Write CSV header
  exportFile.write('id,name,email,created_at\n')

  await db
    .selectFrom('users')
    .select('users', 'id', 'name', 'email', 'created_at')
    .orderBy('id', 'asc')
    .chunk(500, async (userBatch) => {
      for (const user of userBatch) {
        exportFile.write(`${user.id},"${user.name}","${user.email}","${user.created_at}"\n`)
        exportedCount++
      }

      // Update progress every 500 records
      console.log(`Exported ${exportedCount} users...`)
    })

  exportFile.end()
  console.log(`Export completed: ${exportedCount} users`)
}
```

### Advanced Pagination Patterns

```ts
// Search results with pagination
async function searchUsersWithPagination(query: string, page: number = 1) {
  const { data, meta } = await db
    .selectFrom('users')
    .select('users', 'id', 'name', 'email', 'bio')
    .where(['name', 'like', `%${query}%`])
    .orWhere(['email', 'like', `%${query}%`])
    .orWhere(['bio', 'like', `%${query}%`])
    .orderBy('name', 'asc')
    .paginate(15, page)

  return {
    results: data,
    searchTerm: query,
    pagination: meta
  }
}

// Time-based cursor pagination for real-time feeds
async function getRealtimeFeed(cursor?: string, userId?: number) {
  let query = db
    .selectFrom('feed_items')
    .select('feed_items', 'id', 'content', 'created_at', 'user_id')
    .with('User')
    .orderBy('created_at', 'desc')

  if (userId) {
    query = query.where({ user_id: userId })
  }

  const page = await query.cursorPaginate(25, cursor, 'created_at', 'desc')

  return {
    items: page.data,
    nextCursor: page.meta.nextCursor,
    hasMore: !!page.meta.nextCursor,
    timestamp: new Date().toISOString()
  }
}

// Buddy's activity feed with cursor pagination
const buddyFeed = await getRealtimeFeed(undefined, buddyUserId)
```

## Edge Cases

- Deletions/insertions between pages may shift offsets in `paginate`. Prefer `cursorPaginate` for stability.
- If `nextCursor` is null, you’ve reached the end.
- Ensure sort direction matches cursor comparison (`>` for asc, `<` for desc).

## Best Practices

### Performance Optimization

- **Index Cursor Columns**: Always create indexes on columns used for cursor pagination
- **Avoid Large Offsets**: Switch to cursor-based pagination for deep pages (offset > 10,000)
- **Consistent Ordering**: Use deterministic sort orders to ensure stable pagination
- **Limit Result Sizes**: Cap the maximum page size to prevent memory issues

```ts
// Good: Indexed cursor column with reasonable page size
const page = await db
  .selectFrom('posts')
  .where({ published: true })
  .cursorPaginate(50, cursor, 'created_at', 'desc') // created_at should be indexed

// Good: Composite cursor for stable ordering
const page = await db
  .selectFrom('events')
  .cursorPaginate(25, cursor, ['created_at', 'id'], 'desc') // Both columns indexed

// Avoid: Large offset pagination
const badPage = await db
  .selectFrom('posts')
  .paginate(50, 1000) // Page 1000 = OFFSET 49,950 - very slow!
```

### Data Integrity

- **Handle Concurrent Changes**: Use cursor pagination when data changes frequently
- **Consistent Timestamps**: Ensure timestamp columns are set consistently for cursor stability
- **Deleted Records**: Consider how soft deletes affect pagination results
- **Duplicate Prevention**: Use composite cursors (e.g., timestamp + ID) to handle duplicate timestamps

```ts
// Handle data that changes frequently
async function getLatestNotifications(userId: number, cursor?: string) {
  // Cursor pagination is stable even if new notifications are added
  return await db
    .selectFrom('notifications')
    .where({ user_id: userId, deleted_at: null })
    .cursorPaginate(20, cursor, ['created_at', 'id'], 'desc')
}

// Composite cursor for handling duplicate timestamps
async function getOrderHistory(customerId: number, cursor?: string) {
  return await db
    .selectFrom('orders')
    .where({ customer_id: customerId })
    .cursorPaginate(25, cursor, ['created_at', 'id'], 'desc')
}
```

### API Design

- **Consistent Response Format**: Standardize pagination metadata across your API
- **Reasonable Defaults**: Set sensible default page sizes for different content types
- **Error Handling**: Handle invalid cursors and page parameters gracefully
- **Rate Limiting**: Consider rate limiting for expensive pagination operations

```ts
// Standardized pagination response format
interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    currentPage?: number
    totalPages?: number
    totalItems?: number
    perPage: number
    hasNextPage: boolean
    hasPreviousPage: boolean
    nextCursor?: string
    previousCursor?: string
  }
}

// API endpoint with error handling
async function getUsersAPI(req: Request): Promise<PaginatedResponse<User>> {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page as string) || 1)
    const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.per_page as string) || 20))

    const result = await db
      .selectFrom('users')
      .where({ active: true })
      .orderBy('created_at', 'desc')
      .paginate(perPage, page)

    return {
      data: result.data,
      pagination: {
        currentPage: result.meta.page,
        totalPages: result.meta.lastPage,
        totalItems: result.meta.total,
        perPage: result.meta.perPage,
        hasNextPage: result.meta.page < result.meta.lastPage,
        hasPreviousPage: result.meta.page > 1
      }
    }
  }
  catch (error) {
    throw new Error('Invalid pagination parameters')
  }
}
```

### Memory Management

- **Stream Large Datasets**: Use chunking for processing large datasets
- **Batch Size Optimization**: Test different batch sizes for optimal memory/performance balance
- **Progress Tracking**: Provide progress feedback for long-running operations
- **Resource Cleanup**: Ensure proper cleanup of resources in batch operations

```ts
// Memory-efficient data processing
async function processLargeDataset(batchSize: number = 1000) {
  let processedCount = 0
  let lastProcessedId = 0

  try {
    await db
      .selectFrom('large_table')
      .where(['id', '>', lastProcessedId])
      .orderBy('id', 'asc')
      .chunkById(batchSize, 'id', async (batch) => {
        // Process batch with memory-efficient operations
        await processBatch(batch)

        processedCount += batch.length
        lastProcessedId = batch[batch.length - 1].id

        // Progress tracking
        if (processedCount % (batchSize * 10) === 0) {
          console.log(`Processed ${processedCount} records...`)

          // Optional: Allow garbage collection between large batches
          if (global.gc)
            global.gc()
        }
      })

    console.log(`Processing completed: ${processedCount} total records`)
  }
  catch (error) {
    console.error(`Processing failed at record ${lastProcessedId}:`, error)
    throw error
  }
}
```

### Frontend Integration

- **URL State Management**: Sync pagination state with URL parameters
- **Loading States**: Show appropriate loading indicators during pagination
- **Error Recovery**: Handle network errors gracefully in pagination
- **Prefetching**: Consider prefetching the next page for better UX

```ts
// Frontend pagination hook example
const usePagination = (fetchFn: Function, options = {}) => {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(true)

  const loadMore = async () => {
    if (loading || !hasMore) return

    setLoading(true)
    try {
      const result = await fetchFn(cursor)
      setData(prev => [...prev, ...result.data])
      setCursor(result.nextCursor)
      setHasMore(!!result.nextCursor)
    } catch (error) {
      console.error('Pagination error:', error)
      // Handle error appropriately
    } finally {
      setLoading(false)
    }
  }

  return { data, loading, hasMore, loadMore }
}

// Usage in React component
const UsersList = () => {
  const { data: users, loading, hasMore, loadMore } = usePagination(
    (cursor) => api.getUsers({ cursor, limit: 20 })
  )

  return (
    <div>
      {users.map(user => <UserCard key={user.id} user={user} />)}
      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  )
}
```

### Monitoring and Analytics

- **Performance Metrics**: Track query execution times for different pagination strategies
- **Usage Patterns**: Monitor which pages users access most frequently
- **Error Rates**: Track pagination-related errors and timeouts
- **Resource Usage**: Monitor memory and CPU usage during batch operations

## FAQ

### Why is my total count expensive?

`COUNT(*)` over large joins can be costly. Consider `simplePaginate` or caching counts.

### Can I use composite cursors?

Yes. Provide an array of columns like `['created_at', 'id']`. The cursor will carry a tuple of values in order.

### How do I resume a chunked job?

Persist the last processed cursor (e.g., last `id`) and restart `chunkById` with that cursor.

---

## Additional Examples and Variants

### Cursor pagination descending

```ts
let cursor: number | undefined
do {
  const { data, meta } = await db
    .selectFrom('events')
    .cursorPaginate(100, cursor, 'created_at', 'desc')
  // process new slice
  cursor = meta.nextCursor as number | undefined
} while (cursor)
```

### Mixed filters with paginate

```ts
const { data, meta } = await db
  .selectFrom('orders')
  .where(['status', 'in', ['paid', 'refunded']])
  .whereBetween('total', 100, 500)
  .paginate(25, 3)
```

### Paginate with custom order

```ts
await db
  .selectFrom('posts')
  .orderBy('published_at', 'desc')
  .paginate(10, 1)
```

### Chunk with transformation

```ts
await db.selectFrom('audit_logs').chunk(5000, async (rows) => {
  const normalized = rows.map(r => ({ ...r, ts: new Date(r.created_at) }))
  await writeLogs(normalized)
})
```

### eachById with backpressure

```ts
await db.selectFrom('images').eachById(200, 'id', async (row) => {
  await processImage(row)
})
```

### Guarding against missing index

Ensure the cursor column has an index; otherwise, performance degrades.

```sql
CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);
```
