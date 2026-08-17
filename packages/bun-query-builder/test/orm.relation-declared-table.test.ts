/**
 * Relations must read the related model's declared `table`.
 * stacksjs/bun-query-builder#1093.
 *
 * `defineModel` publishes into the global model registry; `createModel` did
 * not. Every relation lookup went through that registry, so a `createModel`
 * model was invisible and each caller fell back to its own guess.
 *
 * Two distinct failures came out of that one gap, and the milder one is the
 * only one the issue reported:
 *
 *  1. The table was guessed from the MODEL NAME, ignoring `table`. With no
 *     table at the guessed name that is a loud "no such table" crash. With one
 *     there — and the guess is the *conventional* name, so this is a plausible
 *     accident — the relation silently reads the wrong table and returns wrong
 *     rows.
 *  2. Eager-load hydration fell back to the PARENT's definition, so related
 *     rows were shaped by the wrong model. An attribute marked `hidden: true`
 *     on the related model was serialized into a `with()` payload even though a
 *     direct query on that same model redacts it.
 *
 * The second is worse in one specific way: it does not require an unusual table
 * name. It hits models whose naming is entirely conventional, so nothing ever
 * warns those users that a relation is being resolved by guesswork.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, getAllModels, hasModel } from '../src'

let db: Database

beforeEach(() => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
})

afterEach(() => {
  clearModelRegistry()
})

describe('relations resolve the declared table (#1093)', () => {
  it('reads the declared table, not a table sitting at the guessed name', async () => {
    db.run('CREATE TABLE wg_owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE wg_custom_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, label TEXT)')
    // The decoy: a real table at the name the resolver would guess from
    // `Widget`. Without the fix the relation reads THIS one and returns rows
    // that look perfectly valid.
    db.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, label TEXT)')
    db.run(`INSERT INTO wg_owners (id, name) VALUES (1, 'owner-1')`)
    db.run(`INSERT INTO wg_custom_widgets (id, owner_id, label) VALUES (1, 1, 'REAL')`)
    db.run(`INSERT INTO widgets (id, owner_id, label) VALUES (1, 1, 'DECOY')`)

    createModel({
      name: 'Widget',
      table: 'wg_custom_widgets',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: {
        owner_id: { type: 'integer', fillable: true },
        label: { type: 'string', fillable: true },
      },
    } as any)

    const Owner = createModel({
      name: 'Owner',
      table: 'wg_owners',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
      hasMany: ['Widget'],
    } as any)

    const rows: any = await (Owner as any).query().with('widget').get()
    const row = typeof rows?.[0]?.toJSON === 'function' ? rows[0].toJSON() : rows?.[0]
    const related = row?.widget

    expect(Array.isArray(related)).toBe(true)
    expect(related.map((r: any) => r.label)).toEqual(['REAL'])
  })

  it('hides the RELATED model\'s hidden attributes in a with() payload', async () => {
    // Note the table name here IS the conventional guess for `Hidsecret`, so
    // the table-resolution half of #1093 cannot fire. This isolates hydration:
    // the only thing that can leak the column is being shaped by the parent's
    // definition instead of the related model's.
    db.run('CREATE TABLE hid_owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE hidsecrets (id INTEGER PRIMARY KEY AUTOINCREMENT, hidowner_id INTEGER, label TEXT, token TEXT)')
    db.run(`INSERT INTO hid_owners (id, name) VALUES (1, 'owner-1')`)
    db.run(`INSERT INTO hidsecrets (id, hidowner_id, label, token) VALUES (1, 1, 'ok', 'SUPER-SECRET')`)

    const Secret = createModel({
      name: 'Hidsecret',
      table: 'hidsecrets',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: {
        hidowner_id: { type: 'integer', fillable: true },
        label: { type: 'string', fillable: true },
        token: { type: 'string', fillable: true, hidden: true },
      },
    } as any)

    const Owner = createModel({
      name: 'Hidowner',
      table: 'hid_owners',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
      hasMany: ['Hidsecret'],
    } as any)

    // Baseline: a direct query on the related model redacts it.
    const direct: any = await (Secret as any).query().get()
    const directRow = typeof direct?.[0]?.toJSON === 'function' ? direct[0].toJSON() : direct?.[0]
    expect(directRow).not.toHaveProperty('token')

    // The eager-loaded payload must agree with it.
    const rows: any = await (Owner as any).query().with('hidsecret').get()
    const row = typeof rows?.[0]?.toJSON === 'function' ? rows[0].toJSON() : rows?.[0]
    const related = row?.hidsecret

    expect(Array.isArray(related)).toBe(true)
    expect(related[0]).not.toHaveProperty('token')
    expect(JSON.stringify(related)).not.toContain('SUPER-SECRET')
  })
})

describe('createModel registration is internal (#1093)', () => {
  it('does not add createModel models to the public registry', () => {
    createModel({
      name: 'PrivateOnly',
      table: 'private_only',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
    } as any)

    // The relation resolver can find it, but the public surface is unchanged —
    // `getAllModels()`/`hasModel()` keep reporting exactly what `defineModel`
    // put there, so nothing downstream starts seeing new entries.
    expect(hasModel('PrivateOnly')).toBe(false)
    expect(getAllModels().some((m: any) => m?.getName?.() === 'PrivateOnly')).toBe(false)
  })

  it('clearModelRegistry() drops them, so resolutions do not leak across tests', async () => {
    db.run('CREATE TABLE lk_owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    db.run('CREATE TABLE lk_declared (id INTEGER PRIMARY KEY AUTOINCREMENT, lkowner_id INTEGER)')
    db.run(`INSERT INTO lk_owners (id, name) VALUES (1, 'a')`)

    createModel({
      name: 'Lkchild',
      table: 'lk_declared',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { lkowner_id: { type: 'integer', fillable: true } },
    } as any)

    const Owner = createModel({
      name: 'Lkowner',
      table: 'lk_owners',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
      hasMany: ['Lkchild'],
    } as any)

    // Warms the memoized relation resolution.
    await (Owner as any).query().with('lkchild').get()

    clearModelRegistry()

    // With the registration and the memo both dropped, the child is unknown
    // again and the resolver falls back to the guessed table, which does not
    // exist. A silent success here would mean a stale resolution survived.
    const Owner2 = createModel({
      name: 'Lkowner',
      table: 'lk_owners',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
      hasMany: ['Lkchild'],
    } as any)

    await expect((Owner2 as any).query().with('lkchild').get()).rejects.toThrow(/lkchilds/)
  })
})
