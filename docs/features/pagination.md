# Pagination

High-level helpers for paging large result sets.

## Methods

- paginate(perPage, page?) => { data, meta: { perPage, page, total, lastPage } }
- simplePaginate(perPage, page?) => { data, meta: { perPage, page, hasMore } }
- cursorPaginate(perPage, cursor?, column?, direction?) => { data, meta: { perPage, nextCursor } }
- chunk(size, handler), chunkById(size, column?, handler), eachById(size, column?, handler)

## Best Practices

- Prefer cursorPaginate for stable infinite scrolls
- Use chunkById for large offline processing tasks

## Examples

```ts
const page = await db.selectFrom('users').where({ active: true }).paginate(20, 1)

await db.selectFrom('users').cursorPaginate(50, undefined, 'id', 'asc')

await db.selectFrom('users').chunkById(1000, 'id', async rows => {
  // process batch
})
```
