# Pagination

High-level helpers for paging and processing large result sets efficiently. Choose between offset-based pagination, simple “has more” pagination, and cursor-based pagination depending on your use case. For background processing, use `chunk`, `chunkById`, and `eachById`.

## Table of Contents

- Overview of Pagination Strategies
- paginate(): Classic Offset Pagination
- simplePaginate(): Lightweight “Has More” Pagination
- cursorPaginate(): Stable Cursor Pagination
- Chunking: chunk, chunkById, eachById
- Choosing a Strategy
- Examples
- Edge Cases
- Best Practices
- FAQ

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

Returns `{ data, meta: { perPage, nextCursor } }`.

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

### Choosing a cursor column

- Default is `id`. Use a monotonically increasing column (e.g., timestamps or numeric ids)
- Avoid volatile columns that can reorder between requests

## Chunking: chunk, chunkById, eachById

### chunk(size, handler)

Paginates using `paginate()` internally and invokes `handler(rows)` per page until exhausted.

```ts
await db.selectFrom('users').chunk(1000, async rows => {
  // process each page of 1000
})
```

### chunkById(size, column?, handler?)

Paginates using `cursorPaginate()` for memory-friendly processing.

```ts
await db.selectFrom('users').chunkById(1000, 'id', async rows => {
  // process 1000 rows at a time
})
```

### eachById(size, column?, handler?)

Iterates row-by-row using `chunkById`.

```ts
await db.selectFrom('users').eachById(500, 'id', async row => {
  // process row
})
```

## Choosing a Strategy

- Need total pages? Use `paginate`.
- Infinite scroll where counts don’t matter? Use `simplePaginate` or `cursorPaginate`.
- Large background processing? Use `chunkById` or `eachById`.

## Examples

```ts
// marketing UI
const { data, meta } = await db.selectFrom('users').paginate(20, 1)

// infinite scroll
let cursor: number | string | undefined
do {
  const page = await db.selectFrom('posts').cursorPaginate(50, cursor, 'id', 'asc')
  // render page.data
  cursor = page.meta.nextCursor ?? undefined
} while (cursor)

// background export
await db.selectFrom('orders').chunkById(1000, 'id', async batch => {
  // write batch to file
})
```

## Edge Cases

- Deletions/insertions between pages may shift offsets in `paginate`. Prefer `cursorPaginate` for stability.
- If `nextCursor` is null, you’ve reached the end.
- Ensure sort direction matches cursor comparison (`>` for asc, `<` for desc).

## Best Practices

- Index the cursor column for `cursorPaginate`
- Use consistent ordering criteria across requests
- Avoid very large offsets; switch to cursors for deep pagination

## FAQ

### Why is my total count expensive?

`COUNT(*)` over large joins can be costly. Consider `simplePaginate` or caching counts.

### Can I use composite cursors?

Not yet; choose a single stable column. Consider time-uuid or (timestamp, id) columns in schema design.

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
