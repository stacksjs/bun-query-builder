/**
 * `simplePaginate()` and `cursorPaginate()` on the model builder.
 *
 * Models were built on a builder that only had `paginate()`, so
 * `Post.simplePaginate(15)` and `Post.where(...).cursorPaginate(15)` threw
 * "is not a function" even though the guides promised both. See
 * stacksjs/stacks#3119.
 *
 * The cursor tests walk whole result sets in both directions, because the
 * failures this feature can have are all boundary failures: a row skipped or
 * repeated where two pages meet, and a "previous page" that is really this page
 * less one row.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel } from '../src'
import { decodeCursor, encodeCursor } from '../src/orm'

let db: Database
let Post: any

const ids = (rows: any[]): number[] => rows.map(row => row.get('id'))

beforeEach(async () => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })

  Post = createModel({
    name: 'PgPost',
    table: 'pg_posts',
    primaryKey: 'id',
    autoIncrement: true,
    traits: { useSoftDeletes: true },
    attributes: {
      title: { type: 'string', fillable: true },
      kind: { type: 'string', fillable: true },
      // Several rows share a day, so the id has to break the tie.
      day: { type: 'string', fillable: true },
    },
  } as any)
  await createTableFromModel(Post.getDefinition())
  for (let n = 1; n <= 25; n++)
    await Post.create({ title: `post ${n}`, kind: n % 2 === 0 ? 'even' : 'odd', day: `2026-01-${String(Math.ceil(n / 4)).padStart(2, '0')}` })
})

afterEach(() => db.close())

describe('simplePaginate', () => {
  it('returns a page and whether another follows, without counting', async () => {
    const first = await Post.simplePaginate(10)
    expect(ids(first.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(first.hasMorePages).toBe(true)
    expect(first.meta).toEqual({ perPage: 10, page: 1, hasMore: true })
    expect(first.from).toBe(1)
    expect(first.to).toBe(10)

    const last = await Post.simplePaginate(10, 3)
    expect(ids(last.data)).toEqual([21, 22, 23, 24, 25])
    expect(last.hasMorePages).toBe(false)
    expect(last.from).toBe(21)
    expect(last.to).toBe(25)
  })

  it('does not report a next page when the last page is exactly full', async () => {
    const page = await Post.simplePaginate(5, 5)
    expect(ids(page.data)).toEqual([21, 22, 23, 24, 25])
    expect(page.hasMorePages).toBe(false)
  })

  it('takes named options so perPage and page cannot be transposed', async () => {
    const named = await Post.query().simplePaginate({ perPage: 4, page: 3 })
    expect(ids(named.data)).toEqual([9, 10, 11, 12])
  })

  it('applies filters and the soft-delete scope, and leaves the builder reusable', async () => {
    await (await Post.find(2)).delete()
    const query = Post.where('kind', 'even')
    const page = await query.simplePaginate(3)
    expect(ids(page.data)).toEqual([4, 6, 8])
    // The builder was not narrowed to one page by the call.
    expect(await query.count()).toBe(11)
    expect(ids((await query.simplePaginate(3, 2)).data)).toEqual([10, 12, 14])
  })

  it('reports an empty page past the end', async () => {
    const page = await Post.simplePaginate(10, 9)
    expect(page.isEmpty).toBe(true)
    expect(page.from).toBeNull()
    expect(page.hasMorePages).toBe(false)
  })

  it('refuses nonsense arguments', async () => {
    await expect(Post.simplePaginate(0)).rejects.toThrow(/perPage/)
    await expect(Post.simplePaginate(10, 0)).rejects.toThrow(/page/)
  })
})

describe('cursorPaginate', () => {
  it('walks every row exactly once going forwards', async () => {
    const seen: number[] = []
    let cursor: string | null | undefined
    let pages = 0
    do {
      const page = await Post.cursorPaginate(7, cursor)
      seen.push(...ids(page.data))
      cursor = page.meta.nextCursor
      pages++
    } while (cursor)
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(pages).toBe(4)
  })

  it('has no previous page on the first page and no next page on the last', async () => {
    const first = await Post.cursorPaginate(10)
    expect(first.meta.prevCursor).toBeNull()
    expect(first.meta.nextCursor).toBeTruthy()
    expect(first.hasMorePages).toBe(true)

    const second = await Post.cursorPaginate(10, first.meta.nextCursor)
    const third = await Post.cursorPaginate(10, second.meta.nextCursor)
    expect(ids(third.data)).toEqual([21, 22, 23, 24, 25])
    expect(third.meta.nextCursor).toBeNull()
    expect(third.hasMorePages).toBe(false)
    expect(third.meta.prevCursor).toBeTruthy()
  })

  it('goes back to the page before, not to this page less a row', async () => {
    const first = await Post.cursorPaginate(10)
    const second = await Post.cursorPaginate(10, first.meta.nextCursor)
    const third = await Post.cursorPaginate(10, second.meta.nextCursor)

    const back = await Post.cursorPaginate(10, third.meta.prevCursor)
    expect(ids(back.data)).toEqual(ids(second.data))
    expect(ids(back.data)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    // A page reached by going back knows there is still a page before it, and
    // still knows how to go forwards again.
    expect(back.meta.prevCursor).toBeTruthy()
    expect(ids((await Post.cursorPaginate(10, back.meta.nextCursor)).data)).toEqual(ids(third.data))

    const start = await Post.cursorPaginate(10, back.meta.prevCursor)
    expect(ids(start.data)).toEqual(ids(first.data))
    expect(start.meta.prevCursor).toBeNull()
    expect(start.meta.nextCursor).toBeTruthy()
  })

  it('walks the whole set backwards from the end', async () => {
    let page = await Post.cursorPaginate(25)
    expect(page.meta.nextCursor).toBeNull()
    // Take the last page of a smaller size, then walk back to the start.
    let cursor: string | null | undefined
    do {
      page = await Post.cursorPaginate(6, cursor)
      cursor = page.meta.nextCursor
    } while (cursor)
    expect(ids(page.data)).toEqual([25])

    const backwards: number[][] = []
    cursor = page.meta.prevCursor
    while (cursor) {
      page = await Post.cursorPaginate(6, cursor)
      backwards.push(ids(page.data))
      cursor = page.meta.prevCursor
    }
    expect(backwards).toEqual([
      [19, 20, 21, 22, 23, 24],
      [13, 14, 15, 16, 17, 18],
      [7, 8, 9, 10, 11, 12],
      [1, 2, 3, 4, 5, 6],
    ])
  })

  it('does not report a next page when the last page is exactly full', async () => {
    const first = await Post.cursorPaginate(5)
    let page = first
    for (let n = 0; n < 4; n++) page = await Post.cursorPaginate(5, page.meta.nextCursor)
    expect(ids(page.data)).toEqual([21, 22, 23, 24, 25])
    expect(page.meta.nextCursor).toBeNull()
  })

  it('orders descending, in both directions', async () => {
    const first = await Post.cursorPaginate(10, undefined, 'id', 'desc')
    expect(ids(first.data)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16])
    const second = await Post.cursorPaginate(10, first.meta.nextCursor, 'id', 'desc')
    expect(ids(second.data)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6])
    const back = await Post.cursorPaginate(10, second.meta.prevCursor, 'id', 'desc')
    expect(ids(back.data)).toEqual(ids(first.data))
    expect(back.meta.prevCursor).toBeNull()
  })

  it('keeps ties together with a composite order and never splits or repeats them', async () => {
    // Four posts per day, so `day` alone cannot place a cursor; `id` does.
    const seen: number[] = []
    let cursor: string | null | undefined
    do {
      const page = await Post.cursorPaginate(3, cursor, ['day', 'id'], 'desc')
      seen.push(...ids(page.data))
      cursor = page.meta.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    // Descending by day, then by id within the day.
    expect(seen.slice(0, 4)).toEqual([25, 24, 23, 22].slice(0, 4).sort((a, b) => b - a))
    const expected = [...Array.from({ length: 25 }, (_, i) => i + 1)].sort((a, b) => {
      const dayA = Math.ceil(a / 4)
      const dayB = Math.ceil(b / 4)
      return dayB - dayA || b - a
    })
    expect(seen).toEqual(expected)

    // And back again over the same boundaries.
    const last = await Post.cursorPaginate(3, undefined, ['day', 'id'], 'desc')
    const second = await Post.cursorPaginate(3, last.meta.nextCursor, ['day', 'id'], 'desc')
    const back = await Post.cursorPaginate(3, second.meta.prevCursor, ['day', 'id'], 'desc')
    expect(ids(back.data)).toEqual(ids(last.data))
  })

  it('keeps the filters and the soft-delete scope on every page', async () => {
    await (await Post.find(4)).delete()
    const query = () => Post.where('kind', 'even')
    const first = await query().cursorPaginate(4)
    expect(ids(first.data)).toEqual([2, 6, 8, 10])
    const second = await query().cursorPaginate(4, first.meta.nextCursor)
    expect(ids(second.data)).toEqual([12, 14, 16, 18])
    expect(ids((await query().cursorPaginate(4, second.meta.prevCursor)).data)).toEqual([2, 6, 8, 10])
  })

  it('does not let an OR in the query escape the cursor predicate', async () => {
    const query = () => Post.where('id', 'in', [2, 3]).orWhere('id', 24)
    const first = await query().cursorPaginate(2)
    expect(ids(first.data)).toEqual([2, 3])
    const second = await query().cursorPaginate(2, first.meta.nextCursor)
    // Without grouping this would be `id = 2 OR (id = 24 AND id > 3)` and
    // repeat 2.
    expect(ids(second.data)).toEqual([24])
  })

  it('still accepts a raw value as a forward cursor', async () => {
    const page = await Post.cursorPaginate(3, 10)
    expect(ids(page.data)).toEqual([11, 12, 13])
    const tuple = await Post.cursorPaginate(3, ['2026-01-02', 5], ['day', 'id'])
    expect(ids(tuple.data)).toEqual([6, 7, 8])
  })

  it('refuses a cursor issued for a different ordering', async () => {
    const first = await Post.cursorPaginate(5, undefined, 'id', 'asc')
    await expect(Post.cursorPaginate(5, first.meta.nextCursor, 'id', 'desc')).rejects.toThrow(/issued for id asc/)
    await expect(Post.cursorPaginate(5, first.meta.nextCursor, ['day', 'id'])).rejects.toThrow(/issued for id asc/)
  })

  it('refuses orderBy, which a cursor cannot honour', async () => {
    await expect(Post.query().orderBy('title').cursorPaginate(5)).rejects.toThrow(/orderBy/)
  })

  it('refuses a selection that leaves out the cursor column', async () => {
    await expect(Post.query().select('title').cursorPaginate(5)).rejects.toThrow(/select cursor column id/)
  })

  it('refuses nonsense arguments', async () => {
    await expect(Post.cursorPaginate(0)).rejects.toThrow(/perPage/)
    await expect(Post.cursorPaginate(5, undefined, 'id; drop table pg_posts')).rejects.toThrow()
    await expect(Post.cursorPaginate(5, undefined, 'id', 'sideways' as any)).rejects.toThrow(/direction/)
    await expect(Post.cursorPaginate(5, 1, ['day', 'id'])).rejects.toThrow(/cursor value/)
  })

  it('treats a string that merely looks like a token as a plain value', async () => {
    const page = await Post.cursorPaginate(2, undefined, 'title')
    expect(page.data).toHaveLength(2)
    const looksLikeOne = await Post.cursorPaginate(2, 'c1.not-a-real-token', 'title')
    // 'c1.not-a-real-token' sorts before every title, so this is page one.
    expect(looksLikeOne.data).toHaveLength(2)
  })
})

describe('cursor tokens', () => {
  it('carry dates and bigints back as what they were, not as quoted strings', () => {
    // Postgres hands a timestamp column back as a Date. JSON.stringify would
    // have kept its quotes and the next page would have compared the column with
    // a quoted string.
    const when = new Date('2026-03-04T05:06:07.890Z')
    const token = encodeCursor({ values: [when, 9007199254740993n, 'text', 7, null], direction: 'prev', columns: ['at', 'big', 's', 'n', 'z'], order: 'desc' })
    expect(token.startsWith('c1.')).toBe(true)
    const back = decodeCursor(token)!
    expect(back.direction).toBe('prev')
    expect(back.order).toBe('desc')
    expect(back.columns).toEqual(['at', 'big', 's', 'n', 'z'])
    expect(back.values[0]).toBeInstanceOf(Date)
    expect((back.values[0] as Date).getTime()).toBe(when.getTime())
    expect(back.values[1]).toBe(9007199254740993n)
    expect(back.values.slice(2)).toEqual(['text', 7, null])
  })

  it('is URL-safe and rejects anything that is not a token', () => {
    const token = encodeCursor({ values: ['a/b+c=', '?&#'], direction: 'next', columns: ['x', 'y'], order: 'asc' })
    expect(token).toMatch(/^c1\.[\w-]+$/)
    expect(decodeCursor(token)!.values).toEqual(['a/b+c=', '?&#'])
    for (const bad of [undefined, null, 5, [1], 'plain', 'c1.', 'c1.@@@', 'c1.e30', `c1.${Buffer.from('{"v":[1],"d":"sideways","c":["id"],"o":"asc"}').toString('base64url')}`])
      expect(decodeCursor(bad)).toBeNull()
  })
})
