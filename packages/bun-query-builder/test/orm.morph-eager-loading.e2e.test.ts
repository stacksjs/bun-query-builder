/**
 * Eager loading a polymorphic relation, against a REAL sqlite database.
 *
 * `morphMany` and `morphOne` were declarable and unresolvable: `.with()` threw
 * "which eager loading does not support yet", so a polymorphic child could only
 * be loaded by writing the query by hand. That is the difference between a
 * table being usable through the ORM and not - a token table keyed by
 * `tokenable_type` / `tokenable_id` cannot be related to its owner at all
 * without this.
 *
 * The type column is what the test is really about. A polymorphic child shares
 * its foreign key with every other parent table, so `owner_id = 1` matches rows
 * belonging to a DIFFERENT parent that happens to have id 1 - which is why each
 * case below seeds two parent tables whose ids collide.
 *
 * @see https://github.com/stacksjs/bun-query-builder/issues/1068
 */
import type { ModelDefinition } from '../src'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, config, configureOrm, createModel, createTableFromModel, registerModel } from '../src'

const UserDef = {
  name: 'MpUser',
  table: 'mp_users',
  primaryKey: 'id',
  autoIncrement: true,
  // The record form: the key IS the morph name.
  morphMany: { tokenable: 'MpToken' },
  morphOne: { avatarable: 'MpAvatar' },
  attributes: { label: { type: 'string' as const, fillable: true as const } },
} as const satisfies ModelDefinition

const AuthorDef = {
  name: 'MpAuthor',
  table: 'mp_authors',
  primaryKey: 'id',
  autoIncrement: true,
  morphMany: { tokenable: 'MpToken' },
  attributes: { label: { type: 'string' as const, fillable: true as const } },
} as const satisfies ModelDefinition

const TokenDef = {
  name: 'MpToken',
  table: 'mp_tokens',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    tokenable_id: { type: 'number' as const, fillable: true as const },
    tokenable_type: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const AvatarDef = {
  name: 'MpAvatar',
  table: 'mp_avatars',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    url: { type: 'string' as const, fillable: true as const },
    avatarable_id: { type: 'number' as const, fillable: true as const },
    avatarable_type: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

describe('polymorphic eager loading (real sqlite)', () => {
  let prevDialect: typeof config.dialect
  const User = createModel(UserDef)
  const Author = createModel(AuthorDef)
  const Token = createModel(TokenDef)
  const Avatar = createModel(AvatarDef)

  beforeAll(async () => {
    prevDialect = config.dialect
    config.dialect = 'sqlite'
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:') })
    registerModel('MpUser', User)
    registerModel('MpAuthor', Author)
    registerModel('MpToken', Token)
    registerModel('MpAvatar', Avatar)
    await createTableFromModel(UserDef)
    await createTableFromModel(AuthorDef)
    await createTableFromModel(TokenDef)
    await createTableFromModel(AvatarDef)

    // Deliberately colliding ids across the two parent tables.
    const user = await User.create({ label: 'ada' })
    const author = await Author.create({ label: 'bob' })
    expect(user.id).toBe(author.id)

    await Token.create({ name: 'user-cli', tokenable_id: user.id, tokenable_type: 'mp_users' })
    await Token.create({ name: 'user-ci', tokenable_id: user.id, tokenable_type: 'mp_users' })
    await Token.create({ name: 'author-cli', tokenable_id: author.id, tokenable_type: 'mp_authors' })

    await Avatar.create({ url: '/ada.png', avatarable_id: user.id, avatarable_type: 'mp_users' })
  })

  afterAll(() => {
    config.dialect = prevDialect
    clearModelRegistry()
  })

  it('loads a morphMany', async () => {
    const user = await User.with('tokenable').first()
    const tokens = user!.getRelation('tokenable') as any[]

    expect(tokens.map(t => t.get('name')).sort()).toEqual(['user-ci', 'user-cli'])
  })

  /**
   * The whole point of the type column. Both parents have id 1, so a plain
   * `tokenable_id IN (1)` hands the user's tokens to the author as well.
   */
  it('does not hand one parent the rows of another with the same id', async () => {
    const author = await Author.with('tokenable').first()
    const tokens = author!.getRelation('tokenable') as any[]

    expect(tokens.map(t => t.get('name'))).toEqual(['author-cli'])
  })

  it('loads a morphOne as a single record, not a list', async () => {
    const user = await User.with('avatarable').first()
    const avatar = user!.getRelation('avatarable') as any

    expect(Array.isArray(avatar)).toBe(false)
    expect(avatar.get('url')).toBe('/ada.png')
  })

  it('still refuses a relation that genuinely is not declared', async () => {
    expect(User.with('nonsense').first()).rejects.toThrow(/has no relation/)
  })
})
