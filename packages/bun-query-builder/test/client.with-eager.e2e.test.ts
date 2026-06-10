/**
 * `.with()` eager loading against a REAL database (sqlite via Bun.SQL).
 *
 * Regression guards for two bugs that only surfaced on a real driver — the
 * existing relation tests all use a mock `sql` whose `String(query)` returns
 * the SQL text, so neither was ever exercised end to end:
 *
 * 1. `.with()` synced its text via `computeSqlText(builtQuery)`, i.e.
 *    `String(query)`. Bun's native query object is a Promise-like with no
 *    text accessor, so that returned "[object Promise]" and corrupted the
 *    SQL — every `.with()` on a real Postgres/MySQL/SQLite-via-Bun.SQL
 *    connection executed garbage. Joins now maintain `text` directly.
 *
 * 2. Constraint callbacks (`.with({ posts: qb => qb.where(...) })`) were
 *    collected but never applied — the only consumer was dead code. They are
 *    documented ("load only published posts") and now filter the JOIN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder, defineModels } from '../src'
import { defineModel } from '../src/schema'

const User = defineModel({
  name: 'EUser',
  table: 'e_users',
  primaryKey: 'id',
  hasMany: { posts: 'EPost' },
  attributes: {
    id: { validation: { rule: {} as any } },
    name: { validation: { rule: {} as any } },
  },
})
const Post = defineModel({
  name: 'EPost',
  table: 'e_posts',
  primaryKey: 'id',
  belongsTo: { user: 'EUser' },
  attributes: {
    id: { validation: { rule: {} as any } },
    e_user_id: { validation: { rule: {} as any } },
    title: { validation: { rule: {} as any } },
    published: { validation: { rule: {} as any } },
  },
})

const models = defineModels({ EUser: User, EPost: Post })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

let sql: SQL
let db: ReturnType<typeof createQueryBuilder<typeof schema>>
let prevSoftDeletes: typeof config.softDeletes

describe('.with() eager loading (real sqlite)', () => {
  beforeAll(async () => {
    // `config` is a shared module global; other test files toggle soft-deletes
    // and the mutation leaks across files. Pin it off so our join doesn't get
    // an `AND e_posts.deleted_at IS NULL` for tables without that column.
    prevSoftDeletes = config.softDeletes
    config.softDeletes = { enabled: false, column: 'deleted_at', defaultFilter: false }
    sql = new SQL('sqlite://:memory:')
    await sql`CREATE TABLE e_users (id INTEGER PRIMARY KEY, name TEXT)`
    await sql`CREATE TABLE e_posts (id INTEGER PRIMARY KEY, e_user_id INTEGER, title TEXT, published INTEGER)`
    await sql`INSERT INTO e_users (id, name) VALUES (1, 'Ada'), (2, 'Bob')`
    await sql`INSERT INTO e_posts (e_user_id, title, published) VALUES
      (1, 'a-pub', 1), (1, 'a-draft', 0), (2, 'b-pub', 1)`
    db = createQueryBuilder<typeof schema>({ schema, meta, sql })
  })

  afterAll(async () => {
    config.softDeletes = prevSoftDeletes
    await sql.close()
  })

  it('produces real SQL text (not "[object Promise]")', () => {
    const text = String(db.selectFrom('e_users').with('posts').toSQL())
    expect(text).not.toContain('[object Promise]')
    expect(text).toContain('LEFT JOIN e_posts ON e_posts.e_user_id = e_users.id')
  })

  it('executes a hasMany eager join on a real connection', async () => {
    const rows = await db.selectFrom('e_users').with('posts').get() as any[]
    // Flattening join: 3 posts → 3 rows, each carrying its user
    expect(rows.length).toBe(3)
    expect(rows.every(r => r.name && r.title)).toBe(true)
  })

  it('applies a constraint callback to the JOIN (load only published)', async () => {
    const text = String(db.selectFrom('e_users').with({ posts: (qb: any) => qb.where('published', '=', 1) }).toSQL())
    expect(text).toContain('AND e_posts.published = 1')

    const rows = await db.selectFrom('e_users').with({ posts: (qb: any) => qb.where('published', '=', 1) }).get() as any[]
    // Both users kept (LEFT join), only published posts joined
    const titles = rows.map(r => r.title).filter(Boolean).sort()
    expect(titles).toEqual(['a-pub', 'b-pub'])
  })

  it('constraint values are escaped, not concatenated', async () => {
    const text = String(db.selectFrom('e_users').with({ posts: (qb: any) => qb.where('title', '=', "x' OR '1'='1") }).toSQL())
    // Single quote doubled → literal stays inside the string, no break-out
    expect(text).toContain("AND e_posts.title = 'x'' OR ''1''=''1'")
  })

  it('keeps the constraint correct when .with() is chained AFTER .where()', async () => {
    // The JOIN precedes the WHERE in SQL; inline-escaped constraint values
    // avoid the positional-param ordering trap.
    const rows = await db.selectFrom('e_users')
      .where({ name: 'Ada' })
      .with({ posts: (qb: any) => qb.where('published', '=', 1) })
      .get() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].title).toBe('a-pub')
  })

  it('rejects orderBy/limit inside a constraint callback instead of silently dropping', () => {
    expect(() => db.selectFrom('e_users').with({ posts: (qb: any) => qb.orderBy('id') }).toSQL())
      .toThrow(/orderBy\(\) is not supported/)
    expect(() => db.selectFrom('e_users').with({ posts: (qb: any) => qb.limit(5) }).toSQL())
      .toThrow(/limit\(\) is not supported/)
  })

  it('rejects an injection-shaped constraint operator', () => {
    expect(() => db.selectFrom('e_users').with({ posts: (qb: any) => qb.where('published', '= 1 OR 1=1 --', 1) }).toSQL())
      .toThrow(/not in the allowed set/)
  })
})
