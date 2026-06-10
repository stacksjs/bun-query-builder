/**
 * Compile-time USAGE verification — a realistic, many-model exercise of the
 * public API at both layers (ORM models and the schema-driven query builder).
 *
 * This file is NOT executed — it's checked by `bun tsc --noEmit` (the CI
 * typecheck job). Lines marked @ts-expect-error MUST fail to compile; every
 * other line MUST compile. Together with type-narrowing-compile.ts it pins
 * the library's type-level behavior against regressions.
 *
 * Layout:
 *   1. Equal/Expect assertion helpers
 *   2. ORM-layer registry (~12 models, `type:`-style attributes)
 *   3. ORM usage: statics, instances, relations, aggregates, pivot typing
 *   4. Client-layer registry (~8 models, validation-rule attributes)
 *   5. Query-builder usage: columns, joins, relations, inserts, updates
 *   6. Inference-utility assertions (InferAttributes & friends)
 */

import type {
  InferAttributes,
  InferColumnNames,
  InferFillableAttributes,
  InferHiddenKeys,
  InferGuardedKeys,
  InferNumericColumns,
  InferPivotColumns,
  InferPrimaryKey,
  InferRelationNames,
  InferTableName,
  ModelCreateData,
  ModelRow,
  RelationCardinality,
} from '../type-inference'
import type { SelectQueryBuilder, TableRelationName, TypedSelectQueryBuilder } from '../client'
import type { DatabaseSchema } from '../schema'
import { raw } from '../client'
import { createModel, type ModelDefinition } from '../orm'

// ---------------------------------------------------------------------------
// 1. Type-assertion helpers
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// ---------------------------------------------------------------------------
// 2. ORM-layer registry — a realistic SaaS/blog domain
// ---------------------------------------------------------------------------

const TeamDef = {
  name: 'Team',
  table: 'teams',
  hasMany: { members: 'Member' },
  attributes: {
    label: { type: 'string' as const, fillable: true as const },
    seats: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const MemberDef = {
  name: 'Member',
  table: 'members',
  traits: {
    useUuid: true,
    useTimestamps: true,
    useSoftDeletes: true,
  },
  belongsTo: ['Team'] as const,
  hasMany: { posts: 'Post', comments: 'Comment' },
  hasOne: { profile: 'Profile' },
  belongsToMany: {
    roles: {
      model: 'Role',
      pivot: {
        columns: {
          level: { default: 1 },
          label: { default: 'member' },
        },
        timestamps: true,
      },
    },
  },
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    email: { type: 'string' as const, fillable: true as const, unique: true as const },
    password: { type: 'string' as const, fillable: true as const, hidden: true as const },
    age: { type: 'number' as const, fillable: true as const },
    karma: { type: 'number' as const, fillable: false as const },
    plan: { type: ['free', 'pro', 'enterprise'] as const, fillable: true as const },
    bio: { type: 'string' as const, fillable: false as const, guarded: true as const },
    nickname: { type: 'string' as const, fillable: true as const, nullable: true as const },
  },
} as const satisfies ModelDefinition

const ProfileDef = {
  name: 'Profile',
  table: 'profiles',
  belongsTo: { member: 'Member' },
  attributes: {
    website: { type: 'string' as const, fillable: true as const, nullable: true as const },
    avatar_url: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const PostDef = {
  name: 'Post',
  table: 'posts',
  traits: { useTimestamps: true },
  belongsTo: { author: 'Member' },
  hasMany: { comments: 'Comment' },
  belongsToMany: ['Tag'] as const,
  morphMany: { images: 'Image' },
  attributes: {
    title: { type: 'string' as const, fillable: true as const },
    body: { type: 'string' as const, fillable: true as const },
    views: { type: 'number' as const, fillable: false as const },
    rating: { type: 'number' as const, fillable: true as const, nullable: true as const },
    status: { type: ['draft', 'published', 'archived'] as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const CommentDef = {
  name: 'Comment',
  table: 'comments',
  traits: { timestampable: true },
  belongsTo: { post: 'Post', author: 'Member' },
  attributes: {
    body: { type: 'string' as const, fillable: true as const },
    likes: { type: 'number' as const, fillable: false as const },
  },
} as const satisfies ModelDefinition

const TagDef = {
  name: 'Tag',
  table: 'tags',
  belongsToMany: ['Post'] as const,
  attributes: {
    slug: { type: 'string' as const, fillable: true as const, unique: true as const },
  },
} as const satisfies ModelDefinition

const RoleDef = {
  name: 'Role',
  table: 'roles',
  attributes: {
    key: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const ImageDef = {
  name: 'Image',
  table: 'images',
  attributes: {
    url: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

// Custom primary key + auth/billing traits
const AccountDef = {
  name: 'Account',
  table: 'accounts',
  primaryKey: 'account_id',
  traits: {
    useAuth: true,
    billable: true,
  },
  attributes: {
    handle: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

// Through + alias traits
const CountryDef = {
  name: 'Country',
  table: 'countries',
  hasMany: { residents: 'Member' },
  hasManyThrough: { posts: { through: 'Member', target: 'Post' } },
  hasOneThrough: { profile: { through: 'Member', target: 'Profile' } },
  attributes: {
    code: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const InvoiceDef = {
  name: 'Invoice',
  table: 'invoices',
  traits: { timestampable: true, softDeletable: true },
  attributes: {
    total_cents: { type: 'number' as const, fillable: true as const },
    currency: { type: ['usd', 'eur'] as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const AuditLogDef = {
  name: 'AuditLog',
  table: 'audit_logs',
  attributes: {
    action: { type: 'string' as const, fillable: true as const },
    context: { type: 'json' as const, fillable: true as const },
    happened_on: { type: 'date' as const, fillable: true as const },
    succeeded: { type: 'boolean' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const Team = createModel(TeamDef)
const Member = createModel(MemberDef)
const Profile = createModel(ProfileDef)
const Post = createModel(PostDef)
const Comment = createModel(CommentDef)
const Tag = createModel(TagDef)
const Role = createModel(RoleDef)
const Image = createModel(ImageDef)
const Account = createModel(AccountDef)
const Country = createModel(CountryDef)
const Invoice = createModel(InvoiceDef)
const AuditLog = createModel(AuditLogDef)

// ---------------------------------------------------------------------------
// 3. ORM usage — every line below must compile exactly as a user would write it
// ---------------------------------------------------------------------------

// eslint-disable-next-line pickier/no-unused-vars
async function _ormUsage() {
  // --- statics: where family ------------------------------------------------
  Member.where('email', 'a@b.co')
  Member.where('age', '>', 21)
  Member.where('plan', 'pro')
  Member.orWhere('name', 'Ada')
  Member.whereIn('plan', ['free', 'pro'])
  Member.whereNotIn('age', [1, 2, 3])
  Member.whereNull('nickname')
  Member.whereNotNull('email')
  Member.whereLike('name', '%a%')
  Member.whereBetween('age', [18, 99])
  Member.whereNotBetween('karma', [0, 10])

  // @ts-expect-error — unknown column
  Member.where('handle', 'x')
  // @ts-expect-error — value must match the column type (age: number)
  Member.where('age', 'not-a-number')
  // @ts-expect-error — enum-typed column only accepts its members
  Member.whereIn('plan', ['gold'])

  // --- dynamic whereColumn statics -------------------------------------------
  Member.whereName('Ada')
  Member.whereEmail('a@b.co')
  Member.whereAge(30)
  // @ts-expect-error — whereAge takes the column's type (number)
  Member.whereAge('thirty')
  // @ts-expect-error — no such column, no such dynamic method
  Member.whereHandle('x')

  // --- ordering / paging ------------------------------------------------------
  Member.orderBy('age', 'desc')
  Member.orderByDesc('created_at')
  Member.latest()
  Member.oldest('age')
  Member.limit(10)
  Member.skip(5)
  // @ts-expect-error — unknown order column
  Member.orderBy('seats')

  // --- select narrowing -------------------------------------------------------
  const slim = await Member.select('name', 'email', 'plan').first()
  if (slim) {
    slim.get('name')
    slim.get('plan')
    // @ts-expect-error — 'age' was not selected
    slim.get('age')
  }

  // --- relations: name narrowing + cardinality -------------------------------
  Member.with('posts', 'comments', 'profile', 'team', 'roles')
  // @ts-expect-error — 'orders' is not a relation on Member
  Member.with('orders')

  const m = await Member.with('posts', 'profile', 'team').first()
  if (m) {
    const posts = m.getRelation('posts') // hasMany → array
    if (posts) {
      // eslint-disable-next-line pickier/no-unused-vars
      const n: number = posts.length
    }
    const profile = m.getRelation('profile') // hasOne → single
    if (profile) {
      // @ts-expect-error — to-one relations are not arrays
      profile.length
    }
    const team = m.getRelation('team') // belongsTo → single
    if (team) {
      // @ts-expect-error — to-one relations are not arrays
      team.length
    }
    const roles = m.getRelation('roles') // belongsToMany → array
    if (roles) {
      // eslint-disable-next-line pickier/no-unused-vars
      const n2: number = roles.length
    }
    // @ts-expect-error — undeclared relation name
    m.getRelation('invoices')
  }

  // through relations resolve cardinality too
  const c = await Country.first()
  if (c) {
    const posts = c.getRelation('posts') // hasManyThrough → array
    if (posts) {
      // eslint-disable-next-line pickier/no-unused-vars
      const n3: number = posts.length
    }
    const profile = c.getRelation('profile') // hasOneThrough → single
    if (profile) {
      // @ts-expect-error — to-one relations are not arrays
      profile.length
    }
  }

  // --- create / fill: fillable-only ------------------------------------------
  await Member.create({ name: 'Ada', email: 'ada@b.co', age: 36, plan: 'pro' })
  await Member.createMany([{ name: 'A', email: 'a@b.co' }, { name: 'B', email: 'b@b.co' }])
  await Member.firstOrCreate({ email: 'ada@b.co' }, { name: 'Ada' })
  await Member.updateOrCreate({ email: 'ada@b.co' }, { age: 37 })
  // @ts-expect-error — 'karma' is not fillable
  await Member.create({ name: 'X', karma: 9000 })
  // @ts-expect-error — 'plan' only accepts its enum members
  await Member.create({ name: 'X', plan: 'gold' })

  // --- instance reads: typed values ------------------------------------------
  const inst = await Member.firstOrFail()
  const age: number = inst.get('age')
  const plan: 'free' | 'pro' | 'enterprise' = inst.get('plan')
  const nickname: string | null = inst.get('nickname') // nullable: true admits null
  const uuid: string = inst.get('uuid') // useUuid trait
  const createdAt: string = inst.get('created_at') // useTimestamps trait
  const deletedAt: string | null = inst.get('deleted_at') // useSoftDeletes trait
  void [age, plan, nickname, uuid, createdAt, deletedAt]

  // @ts-expect-error — get('age') is a number, not a string
  const wrong: string = inst.get('age')
  void wrong

  // toJSON drops hidden keys
  const json = inst.toJSON()
  json.name
  // @ts-expect-error — 'password' is hidden
  json.password

  // set() respects column value types
  inst.set('age', 40)
  inst.set('nickname', null) // nullable column accepts null
  // @ts-expect-error — age is a number column
  inst.set('age', 'forty')

  // only/except accept column names
  inst.only(['name', 'email'])
  inst.except(['password'])
  // @ts-expect-error — unknown column in only()
  inst.only(['seats'])

  // --- aggregates: numeric-only sum/avg ---------------------------------------
  await Post.sum('views')
  await Post.avg('rating')
  await Post.max('title') // max/min allow any column
  await Post.min('created_at')
  // @ts-expect-error — sum() only accepts numeric columns
  await Post.sum('title')
  // @ts-expect-error — avg() only accepts numeric columns
  await Post.avg('status')

  // --- pluck: typed element ---------------------------------------------------
  const titles: string[] = await Post.pluck('title')
  const views: number[] = await Post.pluck('views')
  void [titles, views]
  // @ts-expect-error — pluck('views') yields numbers
  const wrongPluck: string[] = await Post.pluck('views')
  void wrongPluck

  // --- find family ------------------------------------------------------------
  const found = await Member.find(1)
  if (found) found.get('email')
  await Member.findOrFail(1)
  await Member.findMany([1, 2, 3])
  await Member.count()
  await Member.exists()
  await Member.paginate(1, 25)

  // custom primary key models still expose typed system fields
  const acct = await Account.first()
  if (acct) {
    const id: number = acct.get('account_id')
    const stripe: string | null = acct.get('stripe_id') // billable trait
    const tfa: string | null = acct.get('two_factor_secret') // useAuth trait
    void [id, stripe, tfa]
    // @ts-expect-error — default 'id' column does not exist on a custom-pk model
    acct.get('id')
  }

  // alias traits add the same columns as their canonical forms
  const inv = await Invoice.first()
  if (inv) {
    const created: string = inv.get('created_at') // timestampable
    const deleted: string | null = inv.get('deleted_at') // softDeletable
    void [created, deleted]
  }

  // json/date/boolean primitive mappings
  const log = await AuditLog.first()
  if (log) {
    const ctx: Record<string, unknown> = log.get('context')
    const when: Date = log.get('happened_on')
    const ok: boolean = log.get('succeeded')
    void [ctx, when, ok]
  }

  void [Team, Profile, Comment, Tag, Role, Image]
}

// ---------------------------------------------------------------------------
// 4. Client-layer registry — validation-rule attributes for narrow columns
// ---------------------------------------------------------------------------

/** Typed validation-rule stub: carries the value type for InferAttributes. */
function rule<T>(): { validate: (value: T) => boolean } {
  return { validate: () => true }
}

const QUser = {
  name: 'QUser',
  table: 'users',
  primaryKey: 'id',
  hasMany: { posts: 'QPost', comments: 'QComment' },
  hasOne: { profile: 'QProfile' },
  belongsTo: { team: 'QTeam' },
  belongsToMany: { badges: 'QBadge' },
  attributes: {
    id: { validation: { rule: rule<number>() } },
    name: { validation: { rule: rule<string>() } },
    email: { validation: { rule: rule<string>() }, unique: true },
    active: { validation: { rule: rule<boolean>() } },
    login_count: { validation: { rule: rule<number>() } },
    created_at: { validation: { rule: rule<string>() } },
  },
} as const

const QTeam = {
  name: 'QTeam',
  table: 'teams',
  primaryKey: 'id',
  hasMany: { users: 'QUser' },
  attributes: {
    id: { validation: { rule: rule<number>() } },
    label: { validation: { rule: rule<string>() } },
  },
} as const

const QPost = {
  name: 'QPost',
  table: 'posts',
  primaryKey: 'id',
  belongsTo: { user: 'QUser' },
  hasMany: { comments: 'QComment' },
  belongsToMany: { tags: 'QTag' },
  attributes: {
    id: { validation: { rule: rule<number>() } },
    user_id: { validation: { rule: rule<number>() } },
    title: { validation: { rule: rule<string>() } },
    published: { validation: { rule: rule<boolean>() } },
  },
} as const

const QComment = {
  name: 'QComment',
  table: 'comments',
  primaryKey: 'id',
  belongsTo: { post: 'QPost', user: 'QUser' },
  attributes: {
    id: { validation: { rule: rule<number>() } },
    post_id: { validation: { rule: rule<number>() } },
    body: { validation: { rule: rule<string>() } },
  },
} as const

const QProfile = {
  name: 'QProfile',
  table: 'profiles',
  primaryKey: 'id',
  belongsTo: { user: 'QUser' },
  attributes: {
    id: { validation: { rule: rule<number>() } },
    user_id: { validation: { rule: rule<number>() } },
    website: { validation: { rule: rule<string>() } },
  },
} as const

const QTag = {
  name: 'QTag',
  table: 'tags',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: rule<number>() } },
    slug: { validation: { rule: rule<string>() } },
  },
} as const

const QBadge = {
  name: 'QBadge',
  table: 'badges',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: rule<number>() } },
    icon: { validation: { rule: rule<string>() } },
  },
} as const

const QAudit = {
  name: 'QAudit',
  table: 'audits',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: rule<number>() } },
    action: { validation: { rule: rule<string>() } },
  },
} as const

const qModels = { QUser, QTeam, QPost, QComment, QProfile, QTag, QBadge, QAudit }
type QDB = DatabaseSchema<typeof qModels>

// ---------------------------------------------------------------------------
// 5. Query-builder usage
// ---------------------------------------------------------------------------

// eslint-disable-next-line pickier/no-unused-vars
async function _clientUsage(
  users: TypedSelectQueryBuilder<QDB, 'users', QDB['users']['columns'], 'users', 'SELECT * FROM users'>,
  posts: SelectQueryBuilder<QDB, 'posts', QDB['posts']['columns']>,
  audits: SelectQueryBuilder<QDB, 'audits', QDB['audits']['columns']>,
) {
  // --- typed columns: rows, value(), pluck() ----------------------------------
  const rows = await users.get()
  if (rows.length > 0) {
    const name: string = rows[0].name
    const active: boolean = rows[0].active
    void [name, active]
    // @ts-expect-error — unknown column on the row type
    rows[0].seats
  }

  const email: string = await users.value('email')
  const count: number = await users.value('login_count')
  const names: string[] = await users.pluck('name')
  void [email, count, names]
  // @ts-expect-error — unknown column in value()
  await users.value('seats')

  // --- dynamic where methods narrow value types -------------------------------
  users.whereName('Ada')
  users.whereActive(true)
  users.whereLoginCount(3)
  users.orWhereEmail('a@b.co')
  users.andWhereActive(false)
  // @ts-expect-error — whereLoginCount takes a number
  users.whereLoginCount('3')
  // @ts-expect-error — no column 'seats', no dynamic method
  users.whereSeats(4)

  // --- typed SQL strings (compile-time toSQL hovers) --------------------------
  // eslint-disable-next-line pickier/no-unused-vars
  type Sql0 = Expect<Equal<ReturnType<typeof users.toSQL>, 'SELECT * FROM users'>>
  const limited = users.limit(10)
  // eslint-disable-next-line pickier/no-unused-vars
  type Sql1 = Expect<Equal<ReturnType<typeof limited.toSQL>, 'SELECT * FROM users LIMIT 10'>>
  const ordered = users.orderBy('name', 'desc')
  // eslint-disable-next-line pickier/no-unused-vars
  type Sql2 = Expect<Equal<ReturnType<typeof ordered.toSQL>, 'SELECT * FROM users ORDER BY name desc'>>

  // orderBy column is narrowed
  // @ts-expect-error — unknown order column
  users.orderBy('seats')

  // --- relations: with()/whereHas()/withCount() narrow per table --------------
  posts.with?.('comments', 'user', 'tags')
  posts.with?.('comments.user') // nested path rooted at a declared relation
  posts.with?.({ comments: q => q })
  posts.with?.({ comments: q => q.where('id', '=', 1) }) // constraint callback
  // @ts-expect-error — record-form keys are narrowed to declared relations
  posts.with?.({ subscribers: q => q })
  posts.whereHas?.('comments')
  posts.whereDoesntHave?.('tags')
  posts.has?.('user')
  posts.doesntHave?.('comments')
  posts.withCount?.('comments', 'tags')
  posts.withSum?.('comments', 'id')
  posts.withAvg?.('comments', 'id')

  // @ts-expect-error — 'badges' is a users relation, not a posts relation
  posts.with?.('badges')
  // @ts-expect-error — undeclared relation
  posts.whereHas?.('subscribers')
  // @ts-expect-error — undeclared relation
  posts.withCount?.('subscribers')

  // tables without relations reject every relation name
  // @ts-expect-error — 'audits' declares no relations
  audits.with?.('comments')

  // exact relation-name unions, including through/morph-free tables
  // eslint-disable-next-line pickier/no-unused-vars
  type RelUsers = Expect<Equal<TableRelationName<QDB, 'users'>, 'posts' | 'comments' | 'profile' | 'team' | 'badges'>>
  // eslint-disable-next-line pickier/no-unused-vars
  type RelPosts = Expect<Equal<TableRelationName<QDB, 'posts'>, 'user' | 'comments' | 'tags'>>

  // --- pagination shapes -------------------------------------------------------
  const page = await posts.paginate(25, 1)
  const total: number = page.meta.total
  const data = page.data
  if (data.length > 0) {
    const title: string = data[0].title
    void title
  }
  void total

  const simple = await posts.simplePaginate(25)
  const hasMore: boolean = simple.meta.hasMore
  void hasMore
}

// eslint-disable-next-line pickier/no-unused-vars
function _clientTableNarrowing(db: { selectFrom: <T extends keyof QDB & string>(t: T) => SelectQueryBuilder<QDB, T, QDB[T]['columns']> }) {
  db.selectFrom('users')
  db.selectFrom('posts')
  db.selectFrom('audits')
  // @ts-expect-error — table not in the schema
  db.selectFrom('payments')
}

// ---------------------------------------------------------------------------
// 6. Inference-utility assertions
// ---------------------------------------------------------------------------

type MemberAttrs = InferAttributes<typeof MemberDef>
// eslint-disable-next-line pickier/no-unused-vars
type A1 = Expect<Equal<MemberAttrs['age'], number>>
// eslint-disable-next-line pickier/no-unused-vars
type A2 = Expect<Equal<MemberAttrs['plan'], 'free' | 'pro' | 'enterprise'>>
// eslint-disable-next-line pickier/no-unused-vars
type A3 = Expect<Equal<MemberAttrs['nickname'], string | null>>
// eslint-disable-next-line pickier/no-unused-vars
type A4 = Expect<Equal<MemberAttrs['uuid'], string>>
// eslint-disable-next-line pickier/no-unused-vars
type A5 = Expect<Equal<MemberAttrs['deleted_at'], string | null>>

// Wrapped models (createModel) resolve identically through getDefinition()
// eslint-disable-next-line pickier/no-unused-vars
type A6 = Expect<Equal<InferAttributes<typeof Member>['plan'], 'free' | 'pro' | 'enterprise'>>

// eslint-disable-next-line pickier/no-unused-vars
type F1 = Expect<Equal<keyof InferFillableAttributes<typeof MemberDef>, 'name' | 'email' | 'password' | 'age' | 'plan' | 'nickname'>>

// eslint-disable-next-line pickier/no-unused-vars
type P1 = Expect<Equal<InferPrimaryKey<typeof AccountDef>, 'account_id'>>
// eslint-disable-next-line pickier/no-unused-vars
type P2 = Expect<Equal<InferPrimaryKey<typeof PostDef>, 'id'>>

// eslint-disable-next-line pickier/no-unused-vars
type T1 = Expect<Equal<InferTableName<typeof MemberDef>, 'members'>>

// eslint-disable-next-line pickier/no-unused-vars
type R1 = Expect<Equal<InferRelationNames<typeof MemberDef>, 'team' | 'posts' | 'comments' | 'profile' | 'roles'>>
// eslint-disable-next-line pickier/no-unused-vars
type R2 = Expect<Equal<InferRelationNames<typeof PostDef>, 'author' | 'comments' | 'tag'>>

// eslint-disable-next-line pickier/no-unused-vars
type C1 = Expect<Equal<RelationCardinality<typeof MemberDef, 'posts'>, 'many'>>
// eslint-disable-next-line pickier/no-unused-vars
type C2 = Expect<Equal<RelationCardinality<typeof MemberDef, 'profile'>, 'one'>>
// eslint-disable-next-line pickier/no-unused-vars
type C3 = Expect<Equal<RelationCardinality<typeof MemberDef, 'team'>, 'one'>>
// eslint-disable-next-line pickier/no-unused-vars
type C4 = Expect<Equal<RelationCardinality<typeof MemberDef, 'roles'>, 'many'>>
// eslint-disable-next-line pickier/no-unused-vars
type C5 = Expect<Equal<RelationCardinality<typeof CountryDef, 'posts'>, 'many'>>
// eslint-disable-next-line pickier/no-unused-vars
type C6 = Expect<Equal<RelationCardinality<typeof CountryDef, 'profile'>, 'one'>>
// eslint-disable-next-line pickier/no-unused-vars
type C7 = Expect<Equal<RelationCardinality<typeof PostDef, 'images'>, 'many'>>

// eslint-disable-next-line pickier/no-unused-vars
type N1 = Expect<Equal<InferNumericColumns<typeof PostDef>, 'views' | 'rating'>>
// eslint-disable-next-line pickier/no-unused-vars
type H1 = Expect<Equal<InferHiddenKeys<typeof MemberDef>, 'password'>>
// eslint-disable-next-line pickier/no-unused-vars
type G1 = Expect<Equal<InferGuardedKeys<typeof MemberDef>, 'bio'>>

// Column names include trait-conditional system fields
type MemberCols = InferColumnNames<typeof MemberDef>
// eslint-disable-next-line pickier/no-unused-vars
type CN1 = Expect<Equal<Extract<MemberCols, 'uuid' | 'created_at' | 'deleted_at'>, 'uuid' | 'created_at' | 'deleted_at'>>
type TagCols = InferColumnNames<typeof TagDef>
// eslint-disable-next-line pickier/no-unused-vars
type CN2 = Expect<Equal<Extract<TagCols, 'uuid' | 'created_at'>, never>>

// Pivot column typing (belongsToMany Option A)
type MemberRolePivot = InferPivotColumns<typeof MemberDef, 'roles'>
// eslint-disable-next-line pickier/no-unused-vars
type PV1 = Expect<Equal<MemberRolePivot['level'], 1>>
// eslint-disable-next-line pickier/no-unused-vars
type PV2 = Expect<Equal<MemberRolePivot['label'], 'member'>>
// String-form belongsToMany falls back to an open record
// eslint-disable-next-line pickier/no-unused-vars
type PV3 = Expect<Equal<InferPivotColumns<typeof PostDef, 'tags'>, Record<string, unknown>>>

// ModelRow / ModelCreateData aliases
// eslint-disable-next-line pickier/no-unused-vars
type MR1 = Expect<Equal<ModelRow<typeof PostDef>['status'], 'draft' | 'published' | 'archived'>>
// eslint-disable-next-line pickier/no-unused-vars
type MC1 = Expect<Equal<keyof ModelCreateData<typeof PostDef>, 'title' | 'body' | 'rating' | 'status'>>

// DatabaseSchema-level column typing from validation rules
// eslint-disable-next-line pickier/no-unused-vars
type DB1 = Expect<Equal<QDB['users']['columns']['login_count'], number>>
// eslint-disable-next-line pickier/no-unused-vars
type DB2 = Expect<Equal<QDB['users']['columns']['active'], boolean>>
// eslint-disable-next-line pickier/no-unused-vars
type DB3 = Expect<Equal<QDB['posts']['primaryKey'], 'id'>>

// ---------------------------------------------------------------------------
// 7. Result-shape adjustments — every method whose RETURN type must track its
//    inputs (pluck/value/select/min/max/only/except/paginate/returning/...)
// ---------------------------------------------------------------------------

// eslint-disable-next-line pickier/no-unused-vars
async function _ormResultShapes() {
  // --- pluck: element type follows the column -------------------------------
  const titles = await Post.pluck('title')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS1 = Expect<Equal<typeof titles, string[]>>
  const views = await Post.pluck('views')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS2 = Expect<Equal<typeof views, number[]>>
  const plans = await Member.pluck('plan')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS3 = Expect<Equal<typeof plans, ('free' | 'pro' | 'enterprise')[]>>
  const nicknames = await Member.pluck('nickname')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS4 = Expect<Equal<typeof nicknames, (string | null)[]>>
  const ids = await Member.pluck('id') // system pk column
  // eslint-disable-next-line pickier/no-unused-vars
  type RS5 = Expect<Equal<typeof ids, number[]>>

  // --- aggregates: count/exists fixed; max/min follow the column ------------
  const count = await Post.count()
  // eslint-disable-next-line pickier/no-unused-vars
  type RS6 = Expect<Equal<typeof count, number>>
  const exists = await Post.exists()
  // eslint-disable-next-line pickier/no-unused-vars
  type RS7 = Expect<Equal<typeof exists, boolean>>

  const maxViews = await Post.max('views')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS8 = Expect<Equal<typeof maxViews, number | null>>
  const maxTitle = await Post.max('title') // TEXT column → string, not NaN
  // eslint-disable-next-line pickier/no-unused-vars
  type RS9 = Expect<Equal<typeof maxTitle, string | null>>
  const minStatus = await Post.min('status') // enum column keeps its union
  // eslint-disable-next-line pickier/no-unused-vars
  type RS10 = Expect<Equal<typeof minStatus, 'draft' | 'published' | 'archived' | null>>
  const minCreated = await Post.min('created_at') // trait column → string
  // eslint-disable-next-line pickier/no-unused-vars
  type RS11 = Expect<Equal<typeof minCreated, string | null>>

  const sum = await Post.sum('views')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS12 = Expect<Equal<typeof sum, number>>
  const avg = await Post.avg('rating')
  // eslint-disable-next-line pickier/no-unused-vars
  type RS13 = Expect<Equal<typeof avg, number>>

  // --- paginate: full meta shape ---------------------------------------------
  const page = await Post.paginate(1, 10)
  // eslint-disable-next-line pickier/no-unused-vars
  type RS14 = Expect<Equal<typeof page.total, number>>
  // eslint-disable-next-line pickier/no-unused-vars
  type RS15 = Expect<Equal<typeof page.hasMorePages, boolean>>
  // eslint-disable-next-line pickier/no-unused-vars
  type RS16 = Expect<Equal<typeof page.from, number | null>>
  const pageRow = page.data[0]
  if (pageRow) {
    const t = pageRow.get('title')
    // eslint-disable-next-line pickier/no-unused-vars
    type RS17 = Expect<Equal<typeof t, string>>
  }

  // --- toSql shape -------------------------------------------------------------
  const built = Post.where('status', 'draft').toSql()
  // eslint-disable-next-line pickier/no-unused-vars
  type RS18 = Expect<Equal<typeof built, { sql: string, params: unknown[] }>>

  // --- instance shapes: only/except/getChanges/attributes ----------------------
  const inst = await Member.firstOrFail()

  const picked = inst.only(['name', 'age'] as const)
  // eslint-disable-next-line pickier/no-unused-vars
  type RS19 = Expect<Equal<typeof picked, { name: string, age: number }>>
  picked.name
  picked.age
  // @ts-expect-error — 'email' was not picked
  picked.email

  const safe = inst.except(['password'] as const)
  safe.name // still present
  safe.email
  // @ts-expect-error — 'password' was dropped by except()
  safe.password

  const changes = inst.getChanges()
  // eslint-disable-next-line pickier/no-unused-vars
  type RS20 = Expect<Equal<typeof changes.age, number | undefined>> // Partial of attrs

  // id accessor is the pk value
  // eslint-disable-next-line pickier/no-unused-vars
  type RS21 = Expect<Equal<typeof inst.id, number>>

  // toJSON: hidden keys are absent at the TYPE level (not just optional)
  const json = inst.toJSON()
  // eslint-disable-next-line pickier/no-unused-vars
  type RS22 = Expect<Equal<'password' extends keyof typeof json ? true : false, false>>
  // eslint-disable-next-line pickier/no-unused-vars
  type RS23 = Expect<Equal<typeof json.plan, 'free' | 'pro' | 'enterprise'>>

  // --- select() narrows everything downstream ----------------------------------
  const slim = await Member.select('name', 'plan').firstOrFail()
  const slimAttrs = slim.getAttributes()
  slimAttrs.name
  slimAttrs.plan
  // @ts-expect-error — 'age' was not selected
  slimAttrs.age

  // --- find family ---------------------------------------------------------------
  const maybe = await Member.find(1)
  // eslint-disable-next-line pickier/no-unused-vars
  type RS24 = Expect<Equal<typeof maybe extends undefined ? true : false, false>>
  if (maybe) maybe.get('email')
}

// eslint-disable-next-line pickier/no-unused-vars
async function _clientResultShapes(
  users: SelectQueryBuilder<QDB, 'users', QDB['users']['columns']>,
  typedUsers: TypedSelectQueryBuilder<QDB, 'users', QDB['users']['columns'], 'users', 'SELECT * FROM users'>,
  db: {
    select: {
      <T extends keyof QDB & string, K extends keyof QDB[T]['columns'] & string>(table: T, ...columns: K[]): SelectQueryBuilder<QDB, T, Pick<QDB[T]['columns'], K>>
    }
    insertInto: <T extends keyof QDB & string>(table: T) => import('../client').TypedInsertQueryBuilder<QDB, T>
    updateTable: <T extends keyof QDB & string>(table: T) => import('../client').UpdateQueryBuilder<QDB, T>
    table: <T extends keyof QDB & string>(table: T) => import('../client').TableQueryBuilder<QDB, T>
  },
) {
  // --- value(): exact column type ----------------------------------------------
  const email = await users.value('email')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS1 = Expect<Equal<typeof email, string>>
  const active = await users.value('active')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS2 = Expect<Equal<typeof active, boolean>>

  // --- pluck(): element type, and keyed overload → Record ------------------------
  const counts = await users.pluck('login_count')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS3 = Expect<Equal<typeof counts, number[]>>
  const byId = await users.pluck('email', 'id')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS4 = Expect<Equal<typeof byId, Record<string, string>>>

  // --- aggregates ------------------------------------------------------------------
  const n = await users.count()
  // eslint-disable-next-line pickier/no-unused-vars
  type CS5 = Expect<Equal<typeof n, number>>
  const maxName = await users.max('name') // string column → string | null
  // eslint-disable-next-line pickier/no-unused-vars
  type CS6 = Expect<Equal<typeof maxName, string | null>>
  const minId = await users.min('id')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS7 = Expect<Equal<typeof minId, number | null>>
  // @ts-expect-error — unknown column in max()
  await users.max('seats')

  // --- select([...]) narrows rows for get/first/value/pluck ----------------------
  const slim = users.select?.(['id', 'name'])
  if (slim) {
    const rows = await slim.get()
    if (rows.length > 0) {
      rows[0].id
      rows[0].name
      // @ts-expect-error — 'email' was not selected
      rows[0].email
    }
    const one = await slim.first()
    if (one) {
      one.name
      // @ts-expect-error — 'active' was not selected
      one.active
    }
    const nm = await slim.value('name')
    // eslint-disable-next-line pickier/no-unused-vars
    type CS8 = Expect<Equal<typeof nm, string>>
    // @ts-expect-error — value() only sees selected columns
    await slim.value('email')
  }

  // selectAll() restores the full row type
  const all = users.select?.(['id'])?.selectAll?.()
  if (all) {
    const row = await all.first()
    if (row) row.email // visible again
  }

  // --- db.select(table, ...cols) narrows too -------------------------------------
  const narrow = db.select('users', 'id', 'email')
  const nrows = await narrow.get()
  if (nrows.length > 0) {
    nrows[0].email
    // @ts-expect-error — 'name' was not selected
    nrows[0].name
  }

  // --- table().select(...cols) narrows -------------------------------------------
  const trows = await db.table('posts').select('id', 'title').get()
  if (trows.length > 0) {
    trows[0].title
    // @ts-expect-error — 'published' was not selected
    trows[0].published
  }

  // --- insert: values constrained, returning() narrows ----------------------------
  db.insertInto('users').values({ name: 'A', email: 'a@b.co' })
  // @ts-expect-error — unknown column in values()
  db.insertInto('users').values({ seats: 4 })

  const ret = await db.insertInto('users').values({ name: 'A' }).returning('id', 'email').first()
  if (ret) {
    ret.id
    ret.email
    // @ts-expect-error — 'name' was not in RETURNING
    ret.name
  }
  // @ts-expect-error — unknown column in returning()
  db.insertInto('users').values({ name: 'A' }).returning('seats')

  // --- update: set constrained, returning() narrows --------------------------------
  db.updateTable('users').set({ active: false })
  // @ts-expect-error — unknown column in set()
  db.updateTable('users').set({ seats: 9 })
  const updated = await db.updateTable('users').set({ active: true }).returning('id').first()
  if (updated) {
    updated.id
    // @ts-expect-error — only 'id' was returned
    updated.email
  }

  // --- pagination shapes -------------------------------------------------------------
  const cursor = await users.cursorPaginate(10)
  // eslint-disable-next-line pickier/no-unused-vars
  type CS9 = Expect<Equal<typeof cursor.meta.nextCursor, string | number | null>>
  if (cursor.data.length > 0) {
    cursor.data[0].email // rows are typed, not any
    // @ts-expect-error — unknown column on cursor-paginated rows
    cursor.data[0].seats
  }

  // --- lazy iteration keeps the row type ----------------------------------------------
  for await (const row of users.lazy()) {
    row.email
    // @ts-expect-error — unknown column on lazily-iterated rows
    row.seats
    break
  }

  // --- typed SQL strings compose through result-affecting chains -----------------------
  const q1 = typedUsers.whereId(1)
  // eslint-disable-next-line pickier/no-unused-vars
  type CS10 = Expect<Equal<ReturnType<typeof q1.toSQL>, 'SELECT * FROM users WHERE id = ?'>>
  const q2 = typedUsers.whereActive(true).limit(3)
  // eslint-disable-next-line pickier/no-unused-vars
  type CS11 = Expect<Equal<ReturnType<typeof q2.toSQL>, 'SELECT * FROM users WHERE active = ? LIMIT 3'>>
  const q3 = typedUsers.where({ email: 'a@b.co' }).orderBy('id', 'desc')
  // eslint-disable-next-line pickier/no-unused-vars
  type CS12 = Expect<Equal<ReturnType<typeof q3.toSQL>, 'SELECT * FROM users WHERE email = ? ORDER BY id desc'>>
}

// ---------------------------------------------------------------------------
// 8. raw fragments + returning() result methods
// ---------------------------------------------------------------------------

// eslint-disable-next-line pickier/no-unused-vars
async function _rawAndReturning(
  users: SelectQueryBuilder<QDB, 'users', QDB['users']['columns']>,
  db: {
    insertInto: <T extends keyof QDB & string>(table: T) => import('../client').TypedInsertQueryBuilder<QDB, T>
    updateTable: <T extends keyof QDB & string>(table: T) => import('../client').UpdateQueryBuilder<QDB, T>
    deleteFrom: <T extends keyof QDB & string>(table: T) => import('../client').DeleteQueryBuilder<QDB, T>
  },
) {
  // raw() is a SqlFragment, accepted by every *Raw method and select()
  users.selectRaw(raw`count(*) as c`)
  users.whereRaw(raw('age > 18'))
  users.orderByRaw(raw`created_at desc`)
  users.groupByRaw(raw`team_id`)
  users.havingRaw(raw`count(*) > 1`)
  users.select?.([raw`count(*) as c`])
  // raw tagged-template with an escaped value
  users.whereRaw(raw`name = ${'Ada'}`)

  // @ts-expect-error — a bare string is rejected by the SqlFragment type
  users.whereRaw('age > 18')

  // returning() is a SelectQueryBuilder: row-fetching methods exist and are typed
  const insRow = await db.insertInto('users').values({ name: 'A' }).returning('id', 'email').first()
  if (insRow) {
    insRow.id
    insRow.email
    // @ts-expect-error — 'name' was not in RETURNING
    insRow.name
  }
  const insRows = await db.insertInto('users').values({ name: 'A' }).returning('id').get()
  if (insRows.length > 0) insRows[0].id

  const updRow = await db.updateTable('users').set({ active: true }).returning('id').first()
  if (updRow) updRow.id

  const delRow = await db.deleteFrom('users').returning('id', 'name').first()
  if (delRow) {
    delRow.id
    delRow.name
  }
}
