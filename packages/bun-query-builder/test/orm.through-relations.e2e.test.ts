/**
 * hasManyThrough / hasOneThrough eager loading on the ORM model layer, against
 * a REAL sqlite database.
 *
 * Regression guard: resolveRelation() only handled hasMany/hasOne/belongsTo/
 * belongsToMany, so `Model.with('<throughRelation>')` silently loaded NOTHING
 * (getRelation() returned undefined) — even though the typed relation names
 * include the through relations, so the API type-checked but lied at runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, config, configureOrm, createModel, createTableFromModel, registerModel, type ModelDefinition } from '../src'

const CountryDef = {
  name: 'ThCountry',
  table: 'th_countries',
  primaryKey: 'id',
  autoIncrement: true,
  hasMany: { residents: 'ThUser' },
  hasManyThrough: { posts: { through: 'ThUser', target: 'ThPost' } },
  hasOneThrough: { topProfile: { through: 'ThUser', target: 'ThProfile' } },
  attributes: { code: { type: 'string' as const, fillable: true as const } },
} as const satisfies ModelDefinition

const UserDef = {
  name: 'ThUser',
  table: 'th_users',
  primaryKey: 'id',
  autoIncrement: true,
  belongsTo: { country: 'ThCountry' },
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    th_country_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const PostDef = {
  name: 'ThPost',
  table: 'th_posts',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    title: { type: 'string' as const, fillable: true as const },
    th_user_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const ProfileDef = {
  name: 'ThProfile',
  table: 'th_profiles',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    bio: { type: 'string' as const, fillable: true as const },
    th_user_id: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

describe('through-relation eager loading (real sqlite)', () => {
  let prevDialect: typeof config.dialect
  const Country = createModel(CountryDef)
  const User = createModel(UserDef)
  const Post = createModel(PostDef)
  const Profile = createModel(ProfileDef)

  beforeAll(async () => {
    prevDialect = config.dialect
    config.dialect = 'sqlite'
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:') })
    registerModel('ThCountry', Country)
    registerModel('ThUser', User)
    registerModel('ThPost', Post)
    registerModel('ThProfile', Profile)
    await createTableFromModel(CountryDef)
    await createTableFromModel(UserDef)
    await createTableFromModel(PostDef)
    await createTableFromModel(ProfileDef)

    const us = await Country.create({ code: 'US' })
    const ca = await Country.create({ code: 'CA' })
    const ada = await User.create({ name: 'Ada', th_country_id: us.id })
    const bob = await User.create({ name: 'Bob', th_country_id: us.id })
    const cy = await User.create({ name: 'Cy', th_country_id: ca.id })
    await Post.create({ title: 'p1', th_user_id: ada.id })
    await Post.create({ title: 'p2', th_user_id: ada.id })
    await Post.create({ title: 'p3', th_user_id: bob.id })
    await Post.create({ title: 'p4', th_user_id: cy.id })
    await Profile.create({ bio: 'ada-bio', th_user_id: ada.id })
  })

  afterAll(() => {
    config.dialect = prevDialect
    clearModelRegistry()
  })

  it('hasManyThrough loads target rows as an array, grouped per parent', async () => {
    const countries = await Country.with('posts').orderBy('id', 'asc').get()
    expect(countries.length).toBe(2)
    const us = countries.find(c => c.get('code') === 'US')!
    const ca = countries.find(c => c.get('code') === 'CA')!
    const usPosts = us.getRelation('posts') as any[]
    const caPosts = ca.getRelation('posts') as any[]
    expect(Array.isArray(usPosts)).toBe(true)
    expect(usPosts.map(p => p.get('title')).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(caPosts.map(p => p.get('title'))).toEqual(['p4'])
  })

  it('hasOneThrough loads a single target instance (or null)', async () => {
    const us = await Country.where('code', 'US').with('topProfile').first()
    const prof = us!.getRelation('topProfile') as any
    expect(Array.isArray(prof)).toBe(false)
    expect(prof?.get('bio')).toBe('ada-bio')

    // CA has a user (Cy) but no profile → null
    const ca = await Country.where('code', 'CA').with('topProfile').first()
    expect(ca!.getRelation('topProfile')).toBeNull()
  })

  it('a parent with no through rows gets [] (many) without N+1 errors', async () => {
    const empty = await Country.create({ code: 'ZZ' })
    const loaded = await Country.where('id', empty.id).with('posts').first()
    expect(loaded!.getRelation('posts')).toEqual([])
  })
})
