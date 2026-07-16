import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import { config, createQueryBuilder } from '../src'

// SQLite supports RETURNING, but the raw exec path (`sql\`...\`` and
// `db.unsafe(...)`) decided whether to return rows purely by the leading
// keyword: SELECT/PRAGMA returned rows, everything else went through `.run()`
// and surfaced only { changes, lastInsertRowid }. An INSERT/UPDATE/DELETE with
// a RETURNING clause therefore silently dropped the rows it was written to
// return. These tests pin the fix: a RETURNING clause routes through the
// row-returning path regardless of the leading verb.
const DB_PATH = '/private/tmp/bqb-returning-clause.sqlite'

let db: any

describe('raw exec honors RETURNING', () => {
  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(`${DB_PATH}${suffix}`))
        unlinkSync(`${DB_PATH}${suffix}`)

    config.dialect = 'sqlite'
    db = createQueryBuilder({ dialect: 'sqlite', database: DB_PATH } as any)
    // Connections are cached by config signature, so a prior run may have left
    // the table behind; drop it first to keep the test hermetic.
    await db.unsafe('DROP TABLE IF EXISTS r')
    await db.unsafe('CREATE TABLE r (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
  })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(`${DB_PATH}${suffix}`))
        unlinkSync(`${DB_PATH}${suffix}`)
  })

  test('unsafe INSERT ... RETURNING returns the row, not insert metadata', async () => {
    const rows = await db.unsafe('INSERT INTO r (name) VALUES (\'ada\') RETURNING *')

    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0]?.name).toBe('ada')
    expect(typeof rows[0]?.id).toBe('number')
    // The old bug returned { changes, lastInsertRowid } here.
    expect(rows[0]?.changes).toBeUndefined()
  })

  test('unsafe UPDATE ... RETURNING returns the updated row', async () => {
    await db.unsafe('INSERT INTO r (name) VALUES (\'bob\') RETURNING *')
    const rows = await db.unsafe('UPDATE r SET name = \'bobby\' WHERE name = \'bob\' RETURNING *')

    expect(rows[0]?.name).toBe('bobby')
  })

  test('unsafe DELETE ... RETURNING returns the deleted row', async () => {
    await db.unsafe('INSERT INTO r (name) VALUES (\'dee\') RETURNING *')
    const rows = await db.unsafe('DELETE FROM r WHERE name = \'dee\' RETURNING *')

    expect(rows[0]?.name).toBe('dee')
  })
})
