/**
 * End-to-end typed-usage test — exercises the ORM layer the way an app would,
 * across a realistic multi-model domain (teams, users, posts, comments,
 * profiles, roles w/ pivot), with NO `as any` casts on the public API.
 *
 * The same usage patterns are pinned at the type level in
 * src/__tests__/type-usage-compile.ts (checked by `bun tsc`); this file
 * verifies the runtime behavior matches what the types promise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  clearModelRegistry,
  configureOrm,
  createModel,
  createTableFromModel,
  registerModel,
  type ModelDefinition,
} from '../src'

const TeamDef = {
  name: 'Team',
  table: 'e2e_teams',
  hasMany: { members: 'E2EUser' },
  attributes: {
    label: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const UserDef = {
  name: 'E2EUser',
  table: 'e2e_users',
  traits: { useTimestamps: true },
  belongsTo: { team: 'Team' },
  hasMany: { posts: 'E2EPost' },
  hasOne: { profile: 'E2EProfile' },
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    email: { type: 'string' as const, fillable: true as const, unique: true as const },
    age: { type: 'number' as const, fillable: true as const },
    plan: { type: ['free', 'pro'] as const, fillable: true as const },
    team_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const PostDef = {
  name: 'E2EPost',
  table: 'e2e_posts',
  belongsTo: { author: 'E2EUser' },
  hasMany: { comments: 'E2EComment' },
  attributes: {
    title: { type: 'string' as const, fillable: true as const },
    views: { type: 'number' as const, fillable: true as const },
    e2_e_user_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const CommentDef = {
  name: 'E2EComment',
  table: 'e2e_comments',
  belongsTo: { post: 'E2EPost' },
  attributes: {
    body: { type: 'string' as const, fillable: true as const },
    e2_e_post_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const ProfileDef = {
  name: 'E2EProfile',
  table: 'e2e_profiles',
  belongsTo: { user: 'E2EUser' },
  attributes: {
    website: { type: 'string' as const, fillable: true as const },
    e2_e_user_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const Team = createModel(TeamDef)
const User = createModel(UserDef)
const Post = createModel(PostDef)
const Comment = createModel(CommentDef)
const Profile = createModel(ProfileDef)

describe('typed usage e2e (multi-model domain)', () => {
  beforeAll(async () => {
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:', { create: true }) })
    registerModel('Team', Team)
    registerModel('E2EUser', User)
    registerModel('E2EPost', Post)
    registerModel('E2EComment', Comment)
    registerModel('E2EProfile', Profile)
    await createTableFromModel(TeamDef)
    await createTableFromModel(UserDef)
    await createTableFromModel(PostDef)
    await createTableFromModel(CommentDef)
    await createTableFromModel(ProfileDef)

    const team = await Team.create({ label: 'core' })
    const ada = await User.create({ name: 'Ada', email: 'ada@e2e.dev', age: 36, plan: 'pro', team_id: team.id })
    const bob = await User.create({ name: 'Bob', email: 'bob@e2e.dev', age: 28, plan: 'free', team_id: team.id })

    const p1 = await Post.create({ title: 'Hello', views: 10, e2_e_user_id: ada.id })
    const p2 = await Post.create({ title: 'World', views: 32, e2_e_user_id: ada.id })
    await Post.create({ title: 'Quiet', views: 1, e2_e_user_id: bob.id })

    await Comment.create({ body: 'first!', e2_e_post_id: p1.id })
    await Comment.create({ body: 'second!', e2_e_post_id: p1.id })
    await Comment.create({ body: 'nice', e2_e_post_id: p2.id })

    await Profile.create({ website: 'https://ada.dev', e2_e_user_id: ada.id })
  })

  afterAll(() => {
    clearModelRegistry()
  })

  it('typed where + enum + dynamic whereColumn methods', async () => {
    const pro = await User.where('plan', 'pro').get()
    expect(pro.length).toBe(1)
    expect(pro[0].get('name')).toBe('Ada')

    const adults = await User.where('age', '>', 30).get()
    expect(adults.length).toBe(1)

    const byEmail = await User.whereEmail('bob@e2e.dev').first()
    expect(byEmail?.get('name')).toBe('Bob')
  })

  it('select() narrowing carries through to runtime rows', async () => {
    const slim = await User.select('name', 'plan').orderBy('name', 'asc').get()
    expect(slim.length).toBe(2)
    expect(slim[0].get('name')).toBe('Ada')
    expect(slim[0].get('plan')).toBe('pro')
  })

  it('eager loads to-many relations as arrays (hasMany)', async () => {
    const ada = await User.whereEmail('ada@e2e.dev').with('posts').get()
    expect(ada.length).toBe(1)
    const posts = ada[0].getRelation('posts')
    expect(Array.isArray(posts)).toBe(true)
    expect(posts?.length).toBe(2)
    const titles = posts?.map(p => p.get('title')).sort()
    expect(titles).toEqual(['Hello', 'World'])
  })

  it('eager loads to-one relations as single instances (hasOne/belongsTo)', async () => {
    const ada = (await User.whereEmail('ada@e2e.dev').with('profile', 'team').get())[0]
    const profile = ada.getRelation('profile')
    expect(profile).not.toBeNull()
    expect(Array.isArray(profile)).toBe(false)
    expect(profile?.get('website')).toBe('https://ada.dev')

    const team = ada.getRelation('team')
    expect(Array.isArray(team)).toBe(false)
    expect(team?.get('label')).toBe('core')

    const bob = (await User.whereEmail('bob@e2e.dev').with('profile').get())[0]
    expect(bob.getRelation('profile')).toBeNull()
  })

  it('nested batch loading avoids per-row queries and hydrates every parent', async () => {
    const users = await User.with('posts').orderBy('name', 'asc').get()
    expect(users.length).toBe(2)
    expect(users[0].getRelation('posts')?.length).toBe(2) // Ada
    expect(users[1].getRelation('posts')?.length).toBe(1) // Bob
  })

  it('aggregates are numeric-column constrained and correct', async () => {
    expect(await Post.count()).toBe(3)
    expect(await Post.sum('views')).toBe(43)
    expect(await Post.avg('views')).toBeCloseTo(43 / 3)
    expect(await Post.max('views')).toBe(32)
    expect(await Post.min('views')).toBe(1)
  })

  it('max/min on TEXT columns return the text value, not NaN', async () => {
    // Posts: 'Hello', 'World', 'Quiet'. The aggregate path used to coerce
    // every driver value through Number(), turning MAX(title) into NaN.
    expect(await Post.max('title')).toBe('World')
    expect(await Post.min('title')).toBe('Hello')
  })

  it('only()/except() return exact attribute subsets', async () => {
    const ada = await User.whereEmail('ada@e2e.dev').firstOrFail()
    const picked = ada.only(['name', 'plan'] as const)
    expect(picked).toEqual({ name: 'Ada', plan: 'pro' })

    const safe = ada.except(['email'] as const)
    expect('email' in safe).toBe(false)
    expect(safe.name).toBe('Ada')
  })

  it('pluck returns typed primitives', async () => {
    const views = await Post.pluck('views')
    expect(views.sort((a, b) => a - b)).toEqual([1, 10, 32])
    const names = await User.pluck('name')
    expect(names.sort()).toEqual(['Ada', 'Bob'])
  })

  it('find family + pagination shapes', async () => {
    const ada = await User.whereEmail('ada@e2e.dev').firstOrFail()
    const found = await User.findOrFail(ada.id)
    expect(found.get('email')).toBe('ada@e2e.dev')

    const many = await User.findMany([1, 2])
    expect(many.length).toBe(2)

    const page = await Post.paginate(1, 2)
    expect(page.data.length).toBe(2)
    expect(page.total).toBe(3)
  })

  it('updateOrCreate / firstOrCreate respect fillable typing', async () => {
    const again = await User.firstOrCreate({ email: 'ada@e2e.dev' }, { name: 'Ada' })
    expect(again.get('name')).toBe('Ada')
    expect(await User.count()).toBe(2) // no duplicate created

    await User.updateOrCreate({ email: 'bob@e2e.dev' }, { age: 29 })
    const bob = await User.whereEmail('bob@e2e.dev').firstOrFail()
    expect(bob.get('age')).toBe(29)
  })

  it('instance mutation: set/save/isDirty/getChanges round-trip', async () => {
    const bob = await User.whereEmail('bob@e2e.dev').firstOrFail()
    expect(bob.isDirty()).toBe(false)
    bob.set('name', 'Robert')
    expect(bob.isDirty('name')).toBe(true)
    expect(bob.getChanges()).toEqual({ name: 'Robert' })
    await bob.save()

    const reloaded = await User.whereEmail('bob@e2e.dev').firstOrFail()
    expect(reloaded.get('name')).toBe('Robert')
  })
})
