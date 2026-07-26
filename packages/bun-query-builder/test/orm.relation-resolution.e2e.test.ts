/**
 * ORM relation-resolution and attribute-casing regressions, against a REAL
 * sqlite database.
 *
 * Covers:
 *  - `belongsTo` declared with a custom `foreignKey`. The migration generator
 *    has always honored it (`normalizeRelationEntry`), but `resolveRelation`
 *    derived the column from the MODEL NAME, so eager loading queried a column
 *    that was never created.
 *  - `.with()` replacing rather than accumulating, which silently dropped an
 *    earlier eager-load (e.g. one applied by a shared base query).
 *  - `only()` / `except()` / `isDirty()` / `getOriginal()` reading raw keys
 *    while `_attributes` is always snake_case, so every camelCase column
 *    answered undefined / false.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, config, configureOrm, createModel, createTableFromModel, registerModel, type ModelDefinition } from '../src'

const OwnerDef = {
  name: 'RrOwner',
  table: 'rr_owners',
  primaryKey: 'id',
  autoIncrement: true,
  hasMany: { tickets: 'RrTicket' },
  attributes: { label: { type: 'string' as const, fillable: true as const } },
} as const satisfies ModelDefinition

const TeamDef = {
  name: 'RrTeam',
  table: 'rr_teams',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: { label: { type: 'string' as const, fillable: true as const } },
} as const satisfies ModelDefinition

const TicketDef = {
  name: 'RrTicket',
  table: 'rr_tickets',
  primaryKey: 'id',
  autoIncrement: true,
  // `reporter` uses an explicit FK that does NOT match `${snake(model)}_id`;
  // `team` uses the derived default. Both must resolve.
  belongsTo: {
    reporter: { model: 'RrOwner', foreignKey: 'reported_by' },
    team: 'RrTeam',
  },
  attributes: {
    subject: { type: 'string' as const, fillable: true as const },
    reported_by: { type: 'number' as const, fillable: true as const },
    rr_team_id: { type: 'number' as const, fillable: true as const },
    // camelCase declaration -> stored as `escalation_count`
    escalationCount: { type: 'number' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

describe('ORM relation resolution + attribute casing (real sqlite)', () => {
  let prevDialect: typeof config.dialect
  const Owner = createModel(OwnerDef)
  const Team = createModel(TeamDef)
  const Ticket = createModel(TicketDef)

  beforeAll(async () => {
    prevDialect = config.dialect
    config.dialect = 'sqlite'
    clearModelRegistry()
    configureOrm({ database: new Database(':memory:') })
    registerModel('RrOwner', Owner)
    registerModel('RrTeam', Team)
    registerModel('RrTicket', Ticket)
    await createTableFromModel(OwnerDef)
    await createTableFromModel(TeamDef)
    await createTableFromModel(TicketDef)

    const ada = await Owner.create({ label: 'ada' })
    const bob = await Owner.create({ label: 'bob' })
    const core = await Team.create({ label: 'core' })
    await Ticket.create({ subject: 't1', reported_by: ada.id, rr_team_id: core.id, escalationCount: 1 })
    await Ticket.create({ subject: 't2', reported_by: bob.id, rr_team_id: core.id, escalationCount: 0 })
  })

  afterAll(() => {
    config.dialect = prevDialect
    clearModelRegistry()
  })

  it('resolves a belongsTo through its explicit foreignKey', async () => {
    const t = await Ticket.where('subject', 't1').with('reporter').first()
    const reporter = t!.getRelation('reporter') as any
    expect(reporter).not.toBeNull()
    expect(reporter.get('label')).toBe('ada')
  })

  it('still derives the FK from the model name when none is declared', async () => {
    const t = await Ticket.where('subject', 't1').with('team').first()
    expect((t!.getRelation('team') as any)?.get('label')).toBe('core')
  })

  it('accumulates relations across chained .with() calls', async () => {
    const t = await Ticket.where('subject', 't2').with('reporter').with('team').first()
    expect((t!.getRelation('reporter') as any)?.get('label')).toBe('bob')
    expect((t!.getRelation('team') as any)?.get('label')).toBe('core')
  })

  it('collapses a relation named more than once', async () => {
    const q = Ticket.with('reporter').with('reporter', 'team')
    expect(q.getWithRelations()).toEqual(['reporter', 'team'])
  })

  it('only()/except() accept camelCase column names', async () => {
    const t = await Ticket.where('subject', 't1').first()
    expect(t!.only(['subject', 'escalationCount'])).toEqual({ subject: 't1', escalationCount: 1 })
    expect(Object.keys(t!.except(['escalationCount']))).not.toContain('escalation_count')
  })

  it('queries a camelCase attribute by either casing', async () => {
    // `ColumnName` admits both spellings, and the migration generator (and
    // createTableFromModel) create the snake_case column — so both must reach
    // the same column instead of failing with "no such column".
    expect((await Ticket.where('escalationCount', 1).get()).map(t => t.get('subject'))).toEqual(['t1'])
    expect((await Ticket.where('escalation_count', 1).get()).map(t => t.get('subject'))).toEqual(['t1'])
    expect(await Ticket.where('escalationCount', 0).count()).toBe(1)
    expect(await Ticket.sum('escalationCount')).toBe(1)
    expect(await Ticket.query().orderBy('escalationCount', 'desc').pluck('escalationCount')).toEqual([1, 0])
  })

  it('updates and increments a camelCase attribute', async () => {
    const created = await Ticket.create({ subject: 'camel', reported_by: 1, rr_team_id: 1, escalationCount: 2 })
    await Ticket.where('id', created.id).increment('escalationCount', 3)
    expect((await Ticket.find(created.id))!.get('escalationCount')).toBe(5)
    await Ticket.where('id', created.id).update({ escalationCount: 7 })
    expect((await Ticket.find(created.id))!.get('escalationCount')).toBe(7)
  })

  it('isDirty()/getOriginal() track a camelCase column', async () => {
    const t = await Ticket.where('subject', 't1').first()
    expect(t!.isDirty('escalationCount')).toBe(false)
    t!.set('escalationCount', 9)
    expect(t!.isDirty('escalationCount')).toBe(true)
    expect(t!.getOriginal('escalationCount')).toBe(1)
    expect(t!.get('escalationCount')).toBe(9)
  })
})
