/**
 * libSQL / Turso transport (`src/libsql.ts`).
 *
 * Two halves. The first runs everywhere: it drives the connection against a
 * scripted `fetch` and pins the wire format - the pipeline shapes, value
 * encoding both ways, error mapping, and that a token never reaches a message.
 *
 * The second runs against a REAL libSQL server, because a protocol client
 * proven only against its own fake proves nothing. It uses `LIBSQL_TEST_URL`
 * when set (optionally with `LIBSQL_TEST_AUTH_TOKEN`), and otherwise starts
 * `sqld` itself when one is on PATH (`pantry install @sqld/darwin-arm64`, or
 * any libsql-server build). With neither, it is skipped and says so.
 */

import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  createLibSQLSQL,
  decodeLibSQLValue,
  encodeLibSQLValue,
  isLibSQLConnection,
  isLibSQLUrl,
  LibSQLError,
  resolveLibSQLEndpoint,
  toLibSQLError,
} from '../src/libsql'
import { config, normalizeDialectName, resolveDialect, setConfig } from '../src/config'
import { buildDatabaseSchema, buildSchemaMeta, clearModelRegistry, createModel, createQueryBuilder, releaseOrm } from '../src'
import { generateMigration, resetDatabase } from '../src/actions/migrate'
import { closeConnection, resetConnection } from '../src/db'
import { EXAMPLES_MODELS_PATH } from './setup'

interface Captured { url: string, headers: Record<string, string>, body: any }

/** A fetch that records each request and answers from a script. */
function scriptedFetch(answer: (body: any, call: number) => { status?: number, json?: unknown, text?: string }): { fetch: typeof fetch, calls: Captured[] } {
  const calls: Captured[] = []
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body })
    const reply = answer(body, calls.length - 1)
    const status = reply.status ?? 200
    const payload = reply.text ?? JSON.stringify(reply.json)
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: fake, calls }
}

const ok = (result: Partial<{ cols: any[], rows: any[], affected_row_count: number, last_insert_rowid: string | null }> = {}) => ({
  type: 'ok',
  response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null, ...result } },
})

/** Answer every request in a pipeline with a generic success. */
function echo(body: any, baton: string | null = null): unknown {
  return {
    baton,
    base_url: null,
    results: body.requests.map((r: any) => r.type === 'close'
      ? { type: 'ok', response: { type: 'close' } }
      : r.type === 'get_autocommit'
        ? { type: 'ok', response: { type: 'get_autocommit', is_autocommit: true } }
        : ok()),
  }
}

describe('libSQL URLs', () => {
  it('recognises libSQL URLs and leaves file paths alone', () => {
    expect(isLibSQLUrl('libsql://db-org.turso.io')).toBe(true)
    expect(isLibSQLUrl('https://db-org.turso.io')).toBe(true)
    expect(isLibSQLUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLibSQLUrl('wss://db-org.turso.io')).toBe(true)
    expect(isLibSQLUrl('database/stacks.sqlite')).toBe(false)
    expect(isLibSQLUrl('sqlite://./app.db')).toBe(false)
    expect(isLibSQLUrl(':memory:')).toBe(false)
    expect(isLibSQLUrl(undefined)).toBe(false)
  })

  it('maps libsql:// to TLS, honours ?tls=0, and strips a token from the URL', () => {
    expect(resolveLibSQLEndpoint('libsql://db-org.turso.io')).toEqual({ baseUrl: 'https://db-org.turso.io', authToken: undefined })
    expect(resolveLibSQLEndpoint('libsql://127.0.0.1:8080?tls=0').baseUrl).toBe('http://127.0.0.1:8080')
    expect(resolveLibSQLEndpoint('wss://db.example/').baseUrl).toBe('https://db.example')
    expect(resolveLibSQLEndpoint('ws://127.0.0.1:8080').baseUrl).toBe('http://127.0.0.1:8080')
    const withToken = resolveLibSQLEndpoint('libsql://db.example?authToken=secret-token')
    expect(withToken.baseUrl).toBe('https://db.example')
    expect(withToken.authToken).toBe('secret-token')
  })

  it('refuses credentials embedded in the URL', () => {
    expect(() => resolveLibSQLEndpoint('https://user:pass@db.example')).toThrow(LibSQLError)
  })

  it('treats turso and libsql as the sqlite dialect', () => {
    expect(normalizeDialectName('turso')).toBe('sqlite')
    expect(normalizeDialectName('LibSQL')).toBe('sqlite')
    expect(normalizeDialectName('postgres')).toBe('postgres')
    expect(resolveDialect('turso')).toBe('sqlite')
  })
})

describe('libSQL values', () => {
  it('encodes what bun:sqlite binds', () => {
    expect(encodeLibSQLValue(null)).toEqual({ type: 'null' })
    expect(encodeLibSQLValue(undefined)).toEqual({ type: 'null' })
    expect(encodeLibSQLValue(42)).toEqual({ type: 'integer', value: '42' })
    expect(encodeLibSQLValue(-0)).toEqual({ type: 'integer', value: '0' })
    expect(encodeLibSQLValue(1.5)).toEqual({ type: 'float', value: 1.5 })
    expect(encodeLibSQLValue(2 ** 60)).toEqual({ type: 'float', value: 2 ** 60 })
    expect(encodeLibSQLValue(9223372036854775807n)).toEqual({ type: 'integer', value: '9223372036854775807' })
    expect(encodeLibSQLValue(true)).toEqual({ type: 'integer', value: '1' })
    expect(encodeLibSQLValue('héllo 🚀')).toEqual({ type: 'text', value: 'héllo 🚀' })
    expect(encodeLibSQLValue(new Uint8Array([0, 1, 255]))).toEqual({ type: 'blob', base64: 'AAH/' })
    expect(encodeLibSQLValue(new Date('2026-01-02T03:04:05.000Z'))).toEqual({ type: 'text', value: '2026-01-02T03:04:05.000Z' })
  })

  it('refuses values it would otherwise lose', () => {
    expect(() => encodeLibSQLValue(Number.NaN)).toThrow(RangeError)
    expect(() => encodeLibSQLValue(2n ** 64n)).toThrow(RangeError)
    expect(() => encodeLibSQLValue({ a: 1 })).toThrow(TypeError)
  })

  it('decodes integers beyond 2^53 without rounding them', () => {
    expect(decodeLibSQLValue({ type: 'integer', value: '9007199254740991' })).toBe(9007199254740991)
    expect(decodeLibSQLValue({ type: 'integer', value: '9007199254740993' })).toBe(9007199254740993n)
    expect(decodeLibSQLValue({ type: 'integer', value: '-9223372036854775808' })).toBe(-9223372036854775808n)
    expect(decodeLibSQLValue({ type: 'integer', value: '9007199254740993' }, 'string')).toBe('9007199254740993')
  })

  it('decodes blobs, including unpadded base64, to Uint8Array', () => {
    const blob = decodeLibSQLValue({ type: 'blob', base64: 'AAEC/w' }) as Uint8Array
    expect(blob).toBeInstanceOf(Uint8Array)
    expect([...blob]).toEqual([0, 1, 2, 255])
  })
})

describe('libSQL errors', () => {
  it('recovers the extended constraint codes bun:sqlite reports', () => {
    const unique = toLibSQLError({ message: 'SQLite error: UNIQUE constraint failed: users.email', code: 'SQLITE_CONSTRAINT' })
    expect(unique.code).toBe('SQLITE_CONSTRAINT_UNIQUE')
    expect(unique.errno).toBe(2067)
    expect(unique.message).toBe('UNIQUE constraint failed: users.email')
    expect(unique.libsqlCode).toBe('SQLITE_CONSTRAINT')

    expect(toLibSQLError({ message: 'SQLite error: FOREIGN KEY constraint failed', code: 'SQLITE_CONSTRAINT' }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
    expect(toLibSQLError({ message: 'SQLite error: NOT NULL constraint failed: t.a', code: 'SQLITE_CONSTRAINT' }).code).toBe('SQLITE_CONSTRAINT_NOTNULL')
    expect(toLibSQLError({ message: 'SQL string could not be parsed: unsupported statement: VACUUM', code: 'SQL_PARSE_ERROR' }).code).toBe('SQLITE_ERROR')
    const input = toLibSQLError({ message: 'SQL input error: no such column: uuid (at offset 260)', code: 'SQL_INPUT_ERROR' })
    expect(input.code).toBe('SQLITE_ERROR')
    expect(input.errno).toBe(1)
    expect(input.message).toContain('no such column: uuid')
  })
})

describe('libSQL connection (scripted server)', () => {
  it('sends a stateless statement as one closed pipeline with a bearer token', async () => {
    const server = scriptedFetch(body => ({ json: echo(body) }))
    const sql: any = createLibSQLSQL({ url: 'libsql://db.example', authToken: 'tok', fetch: server.fetch })
    await sql.unsafe('SELECT $2 AS a, $1 AS b', ['one', 'two'])

    expect(server.calls).toHaveLength(1)
    const [call] = server.calls
    expect(call.url).toBe('https://db.example/v3/pipeline')
    expect(call.headers.authorization).toBe('Bearer tok')
    expect(call.body.baton).toBeNull()
    expect(call.body.requests).toEqual([
      { type: 'execute', stmt: { sql: 'SELECT ? AS a, ? AS b', args: [{ type: 'text', value: 'two' }, { type: 'text', value: 'one' }], want_rows: true } },
      { type: 'close' },
    ])
  })

  it('binds named parameters, adding the prefix SQLite expects', async () => {
    const server = scriptedFetch(body => ({ json: echo(body) }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    await sql.unsafe('SELECT :id, $name', { id: 1, $name: 'x' })
    expect(server.calls[0].body.requests[0].stmt.named_args).toEqual([
      { name: ':id', value: { type: 'integer', value: '1' } },
      { name: '$name', value: { type: 'text', value: 'x' } },
    ])
  })

  it('returns rows with the write metadata the sqlite paths read', async () => {
    const server = scriptedFetch(() => ({
      json: {
        baton: null,
        base_url: null,
        results: [ok({ cols: [{ name: 'id' }, { name: 'big' }], rows: [[{ type: 'integer', value: '7' }, { type: 'integer', value: '9223372036854775807' }]], affected_row_count: 1, last_insert_rowid: '7' }), { type: 'ok', response: { type: 'close' } }],
      },
    }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    const rows = await sql.unsafe('INSERT INTO t (big) VALUES (?) RETURNING id, big', [9223372036854775807n])
    expect(rows).toEqual([{ id: 7, big: 9223372036854775807n }])
    expect(rows.changes).toBe(1)
    expect(rows.count).toBe(1)
    expect(rows.lastInsertRowid).toBe(7)
    expect(Object.keys(rows)).toEqual(['0'])
  })

  it('runs a transaction on one stream, passing the baton along, and commits with the close', async () => {
    const server = scriptedFetch((body, call) => ({ json: echo(body, call < 2 ? `baton-${call}` : null) }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    const result = await sql.begin(async (tx: any) => {
      await tx.unsafe('INSERT INTO t VALUES (1)')
      return 'done'
    })

    expect(result).toBe('done')
    expect(server.calls.map(c => c.body.baton)).toEqual([null, 'baton-0', 'baton-1'])
    expect(server.calls[0].body.requests[0].stmt.sql).toBe('BEGIN')
    expect(server.calls[2].body.requests.map((r: any) => r.type === 'execute' ? r.stmt.sql : r.type)).toEqual(['COMMIT', 'close'])
  })

  it('rolls the stream back when the callback throws', async () => {
    const server = scriptedFetch((body, call) => ({ json: echo(body, call < 1 ? 'b' : null) }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    await expect(sql.begin(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(server.calls.at(-1)!.body.requests.map((r: any) => r.type === 'execute' ? r.stmt.sql : r.type)).toEqual(['ROLLBACK', 'close'])
  })

  it('serializes concurrent queries on one transaction handle', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fake = (async (_input: string, init?: RequestInit) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return new Response(JSON.stringify(echo(JSON.parse(String(init?.body)), 'b')))
    }) as unknown as typeof fetch
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: fake })
    await sql.begin(async (tx: any) => {
      await Promise.all([1, 2, 3, 4].map(i => tx.unsafe(`SELECT ${i}`)))
    })
    expect(maxInFlight).toBe(1)
  })

  it('replays PRAGMA foreign_keys at the start of every later stream', async () => {
    const server = scriptedFetch(body => ({ json: echo(body) }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    await sql.unsafe('PRAGMA foreign_keys = OFF')
    await sql.unsafe('DROP TABLE parent')
    const drop = server.calls[1].body.requests
    expect(drop[0].stmt.sql).toBe('PRAGMA foreign_keys = OFF')
    expect(drop[1].stmt.sql).toBe('DROP TABLE parent')
  })

  it('surfaces a statement error with SQLite codes', async () => {
    const server = scriptedFetch(() => ({
      json: { baton: null, base_url: null, results: [{ type: 'error', error: { message: 'SQLite error: UNIQUE constraint failed: t.u', code: 'SQLITE_CONSTRAINT' } }, { type: 'ok', response: { type: 'close' } }] },
    }))
    const sql: any = createLibSQLSQL({ url: 'http://db.example', fetch: server.fetch })
    const error = await sql.unsafe('INSERT INTO t (u) VALUES (1)').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(LibSQLError)
    expect(error.code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  })

  it('explains a rejected token without ever echoing it', async () => {
    const server = scriptedFetch(() => ({ status: 401, json: { error: 'Unauthorized: `The JWT is invalid`' } }))
    const sql: any = createLibSQLSQL({ url: 'libsql://db.example', authToken: 'super-secret-token', fetch: server.fetch })
    const error = await sql.unsafe('SELECT 1').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(LibSQLError)
    expect(error.code).toBe('LIBSQL_UNAUTHORIZED')
    expect(error.status).toBe(401)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('https://db.example')
    expect(error.message).not.toContain('super-secret-token')
  })

  it('is recognisable as a libSQL connection', () => {
    expect(isLibSQLConnection(createLibSQLSQL({ url: 'http://db.example' }))).toBe(true)
    expect(isLibSQLConnection(() => {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Live server
// ---------------------------------------------------------------------------

let liveUrl = process.env.LIBSQL_TEST_URL ?? ''
const liveToken = process.env.LIBSQL_TEST_AUTH_TOKEN || undefined
let spawned: Subprocess | null = null
let spawnedDir = ''

async function startSqld(): Promise<string> {
  const bin = Bun.which('sqld')
  if (!bin)
    return ''
  spawnedDir = mkdtempSync(join(tmpdir(), 'qb-libsql-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  spawned = Bun.spawn([bin, '--http-listen-addr', `127.0.0.1:${port}`, '--db-path', join(spawnedDir, 'data.sqld'), '--no-welcome'], { stdout: 'ignore', stderr: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok)
        return url
    }
    catch {}
    await Bun.sleep(50)
  }
  return ''
}

if (!liveUrl)
  liveUrl = await startSqld()

if (!liveUrl)
  console.warn('[libsql.test] no LIBSQL_TEST_URL and no sqld on PATH - live libSQL tests skipped')

describe.skipIf(!liveUrl)('libSQL against a real server', () => {
  let sql: any

  beforeAll(async () => {
    sql = createLibSQLSQL({ url: liveUrl, authToken: liveToken })
    await sql.unsafe('DROP TABLE IF EXISTS qb_libsql_child')
    await sql.unsafe('DROP TABLE IF EXISTS qb_libsql_parent')
    await sql.unsafe('CREATE TABLE qb_libsql_parent (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, big INTEGER, data BLOB, note TEXT)')
    await sql.unsafe('CREATE TABLE qb_libsql_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES qb_libsql_parent(id))')
  })

  afterAll(async () => {
    await sql?.unsafe('DROP TABLE IF EXISTS qb_libsql_child').execute().catch(() => {})
    await sql?.unsafe('DROP TABLE IF EXISTS qb_libsql_parent').execute().catch(() => {})
    await sql?.close()
    spawned?.kill()
    if (spawnedDir)
      rmSync(spawnedDir, { recursive: true, force: true })
  })

  it('round-trips integers past 2^53, blobs, NULLs and unicode', async () => {
    const big = 9223372036854775807n
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    const inserted = await sql.unsafe('INSERT INTO qb_libsql_parent (email, big, data, note) VALUES (?, ?, ?, ?)', ['ü@example.com', big, bytes, null])
    expect(inserted.changes).toBe(1)
    expect(typeof inserted.lastInsertRowid).toBe('number')

    const [row] = await sql`SELECT * FROM qb_libsql_parent WHERE email = ${'ü@example.com'}`.execute()
    expect(row.big).toBe(big)
    expect([...row.data]).toEqual([...bytes])
    expect(row.note).toBeNull()
    expect(row.email).toBe('ü@example.com')

    const [emoji] = await sql.unsafe('SELECT ? AS s, length(?) AS n', ['日本語 🚀', '日本語 🚀'])
    expect(emoji).toEqual({ s: '日本語 🚀', n: 5 })
  })

  it('reports a duplicate the way bun:sqlite does', async () => {
    await sql.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['dup@example.com'])
    const error = await sql.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['dup@example.com']).then(() => null, (e: unknown) => e)
    expect(error.code).toBe('SQLITE_CONSTRAINT_UNIQUE')
    expect(error.errno).toBe(2067)
    expect(error.message).toContain('UNIQUE constraint failed: qb_libsql_parent.email')
  })

  it('enforces foreign keys, and honours foreign_keys = OFF across requests', async () => {
    const fk = await sql.unsafe('INSERT INTO qb_libsql_child (parent_id) VALUES (?)', [999999]).then(() => null, (e: unknown) => e)
    expect(fk.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')

    const own: any = createLibSQLSQL({ url: liveUrl, authToken: liveToken })
    await own.unsafe('PRAGMA foreign_keys = OFF')
    const [off] = await own.unsafe('PRAGMA foreign_keys')
    expect(off.foreign_keys).toBe(0)
    await own.unsafe('PRAGMA foreign_keys = ON')
    const [on] = await own.unsafe('PRAGMA foreign_keys')
    expect(on.foreign_keys).toBe(1)
  })

  it('rolls back a transaction whose statement fails half way', async () => {
    const before = (await sql.unsafe('SELECT count(*) AS n FROM qb_libsql_parent'))[0].n
    const error = await sql.begin(async (tx: any) => {
      await tx.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['in-tx@example.com'])
      const [seen] = await tx.unsafe('SELECT count(*) AS n FROM qb_libsql_parent')
      expect(seen.n).toBe(before + 1)
      await tx.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['dup@example.com'])
    }).then(() => null, (e: unknown) => e)
    expect(error.code).toBe('SQLITE_CONSTRAINT_UNIQUE')
    const [after] = await sql.unsafe('SELECT count(*) AS n FROM qb_libsql_parent')
    expect(after.n).toBe(before)
  })

  it('commits, and nests a savepoint that rolls back alone', async () => {
    await sql.begin(async (tx: any) => {
      await tx.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['outer@example.com'])
      await tx.savepoint(async (sp: any) => {
        await sp.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['inner@example.com'])
        throw new Error('undo inner')
      }).catch(() => {})
    })
    const rows = await sql.unsafe('SELECT email FROM qb_libsql_parent WHERE email IN (?, ?) ORDER BY email', ['inner@example.com', 'outer@example.com'])
    expect(rows.map((r: any) => r.email)).toEqual(['outer@example.com'])
  })

  it('pins a raw BEGIN to one stream until the server is back in autocommit', async () => {
    await sql.unsafe('BEGIN')
    await sql.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', ['raw@example.com'])
    await sql.unsafe('ROLLBACK')
    const [row] = await sql.unsafe('SELECT count(*) AS n FROM qb_libsql_parent WHERE email = ?', ['raw@example.com'])
    expect(row.n).toBe(0)
  })

  it('applies a batch atomically', async () => {
    const results = await sql.batch([
      { sql: 'INSERT INTO qb_libsql_parent (email) VALUES (?)', args: ['batch-1@example.com'] },
      { sql: 'SELECT count(*) AS n FROM qb_libsql_parent WHERE email = ?', args: ['batch-1@example.com'] },
    ])
    expect(results[0].changes).toBe(1)
    expect(results[1][0].n).toBe(1)

    const error = await sql.batch([
      { sql: 'INSERT INTO qb_libsql_parent (email) VALUES (?)', args: ['batch-2@example.com'] },
      { sql: 'INSERT INTO qb_libsql_parent (email) VALUES (?)', args: ['dup@example.com'] },
    ]).then(() => null, (e: unknown) => e)
    expect(error.code).toBe('SQLITE_CONSTRAINT_UNIQUE')
    const [none] = await sql.unsafe('SELECT count(*) AS n FROM qb_libsql_parent WHERE email = ?', ['batch-2@example.com'])
    expect(none.n).toBe(0)
  })

  it('handles parallel requests', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => sql.unsafe('INSERT INTO qb_libsql_parent (email) VALUES (?)', [`par-${i}@example.com`])))
    const [row] = await sql.unsafe('SELECT count(*) AS n FROM qb_libsql_parent WHERE email LIKE ?', ['par-%'])
    expect(row.n).toBe(40)
  })

  it('runs a file on one stream, so its own BEGIN ... COMMIT holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qb-libsql-file-'))
    const file = join(dir, 'm.sql')
    await Bun.write(file, [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN;',
      'CREATE TABLE qb_libsql_file (id INTEGER PRIMARY KEY, v TEXT);',
      'INSERT INTO qb_libsql_file (v) VALUES (\'a;b\');',
      'COMMIT;',
      'PRAGMA foreign_keys=ON;',
    ].join('\n'))
    try {
      await sql.file(file)
      const rows = await sql.unsafe('SELECT v FROM qb_libsql_file')
      expect(rows).toEqual([{ v: 'a;b' }])
    }
    finally {
      await sql.unsafe('DROP TABLE IF EXISTS qb_libsql_file')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!liveUrl)('the query builder, migrations and models over libSQL', () => {
  let saved = { dialect: config.dialect, database: { ...config.database }, softDeletes: config.softDeletes }
  const previousCwd = process.cwd()
  let workdir = ''

  const models = {
    User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: {}, email: {}, name: {}, age: {}, role: {} } },
    Post: { name: 'Post', table: 'posts', primaryKey: 'id', attributes: { id: {}, user_id: {}, title: {}, body: {}, published: {} } },
  } as const
  const schema = buildDatabaseSchema(models as any)
  const meta = buildSchemaMeta(models as any)
  const qb = (): any => createQueryBuilder<typeof schema>({ schema, meta })

  beforeAll(async () => {
    // Migrations write their snapshot and files under the working directory.
    saved = { dialect: config.dialect, database: { ...config.database }, softDeletes: config.softDeletes }
    workdir = mkdtempSync(join(tmpdir(), 'qb-libsql-migrate-'))
    process.chdir(workdir)
    await closeConnection()
    setConfig({
      dialect: 'sqlite',
      database: { database: 'libsql', url: liveUrl, authToken: liveToken },
      softDeletes: { enabled: false, column: 'deleted_at', defaultFilter: false },
    })
    resetConnection()
    releaseOrm()
    await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'sqlite' })
    await generateMigration(EXAMPLES_MODELS_PATH, { dialect: 'sqlite', full: true, apply: true })
  })

  afterAll(async () => {
    try {
      await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'sqlite' })
    }
    finally {
      await closeConnection()
      releaseOrm()
      clearModelRegistry()
      setConfig({ dialect: saved.dialect, softDeletes: saved.softDeletes })
      // Assigned, not merged: `setConfig` merges the section, which would keep
      // this suite's `url` and point every later file at the libSQL server.
      config.database = { ...saved.database }
      resetConnection()
      process.chdir(previousCwd)
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('migrates the example models with the sqlite DDL', async () => {
    const tables = await qb().unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'posts', 'comments') ORDER BY name`)
    expect(tables.map((t: any) => t.name)).toEqual(['comments', 'posts', 'users'])
  })

  it('runs builder CRUD, insertGetId and a rollback', async () => {
    const db = qb()
    const id = await db.insertGetId('users', { email: 'ada@example.com', name: 'Ada', age: 36, role: 'admin' })
    expect(typeof id).toBe('number')
    await db.insertInto('posts').values({ user_id: id, title: 'First', body: 'Hi', published: 1 }).execute()

    const user = await db.selectFrom('users').where('email', '=', 'ada@example.com').first()
    expect(user.name).toBe('Ada')

    const updated = await db.updateTable('users').set({ age: 37 }).where('id', '=', id).execute()
    expect(updated.numUpdatedRows ?? updated).toBeTruthy()
    // `age` is declared as a string in the example model, so its column is TEXT.
    expect(String((await db.selectFrom('users').where('id', '=', id).first()).age)).toBe('37')

    const joined = await db.selectFrom('posts').innerJoin('users', 'users.id', '=', 'posts.user_id').where('users.id', '=', id).get()
    expect(joined).toHaveLength(1)

    await expect(db.transaction(async (tx: any) => {
      await tx.insertInto('users').values({ email: 'ghost@example.com', name: 'Ghost', age: 1, role: 'x' }).execute()
      expect(await tx.selectFrom('users').where('email', '=', 'ghost@example.com').first()).toBeTruthy()
      throw new Error('roll it back')
    })).rejects.toThrow('roll it back')
    expect(await db.selectFrom('users').where('email', '=', 'ghost@example.com').first()).toBeFalsy()

    const committed = await db.transaction(async (tx: any) => {
      await tx.insertInto('users').values({ email: 'kept@example.com', name: 'Kept', age: 2, role: 'x' }).execute()
      return 'ok'
    })
    expect(committed).toBe('ok')
    expect(await db.selectFrom('users').where('email', '=', 'kept@example.com').first()).toBeTruthy()

    const deleted = await db.deleteFrom('users').where('email', '=', 'kept@example.com').execute()
    expect(deleted.numDeletedRows ?? deleted).toBeTruthy()
  })

  it('writes through the model layer on the shared connection', async () => {
    const LUser = createModel({
      name: 'LUser',
      table: 'users',
      primaryKey: 'id',
      traits: { useTimestamps: false },
      attributes: { email: { fillable: true }, name: { fillable: true }, age: { fillable: true }, role: { fillable: true } },
    } as any) as any

    const created = await LUser.create({ email: 'model@example.com', name: 'Model', age: 5, role: 'user' })
    expect(typeof created.id).toBe('number')
    const found = await LUser.find(created.id)
    expect(found.get('email')).toBe('model@example.com')
    await found.update({ age: 6 })
    expect(String((await LUser.find(created.id)).get('age'))).toBe('6')
    await found.delete()
    expect(await LUser.find(created.id)).toBeFalsy()
  })
})
