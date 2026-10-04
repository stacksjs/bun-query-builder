/**
 * libSQL / Turso transport.
 *
 * libSQL speaks SQLite's SQL, so nothing about how a query is RENDERED changes:
 * the dialect stays `sqlite` and every grammar branch in the builder, the DDL
 * driver and the migration generator applies unchanged. What changes is how a
 * statement reaches the database. Instead of an in-process `bun:sqlite` file,
 * it travels to a libSQL server (`sqld`, `turso dev`, or a Turso database) over
 * the Hrana-over-HTTP protocol:
 *
 *   POST {url}/v3/pipeline   { baton, requests: [execute | batch | get_autocommit | close] }
 *
 * The connection this module builds has the same surface as the `bun:sqlite`
 * wrapper in `db.ts` (tagged template, `unsafe`, `query`, `file`, `begin`,
 * `savepoint`, `close`), so the rest of the library cannot tell them apart -
 * except that nothing here is synchronous, which the builder already handles
 * for Bun's network drivers.
 *
 * Three behaviours are what make a stateless HTTP API look like the single
 * SQLite connection the sqlite code paths were written against:
 *
 * 1. A statement outside a transaction is one pipeline with no baton, closed in
 *    the same round trip. Concurrent statements are concurrent requests.
 *
 * 2. `begin(fn)` opens a STREAM - a server-side connection kept alive by the
 *    baton each response hands back - and runs BEGIN, the callback's queries,
 *    and COMMIT or ROLLBACK on it. Requests on a stream are serialized, since a
 *    baton is single-use. A raw `BEGIN`/`SAVEPOINT` issued through `unsafe()`
 *    or a migration file pins the connection to a stream the same way, until
 *    the server reports it is back in autocommit (`get_autocommit`).
 *
 * 3. `PRAGMA foreign_keys` is connection-scoped in SQLite and the only
 *    connection-scoped pragma sqld accepts. Each stream is a fresh server
 *    connection, so a value set on this connection is replayed at the start of
 *    every new stream. Without that, `foreign_keys = OFF` before a DROP would
 *    apply to a connection that no longer exists by the time the DROP runs.
 *
 * Values: integers travel as decimal strings in Hrana, so an integer outside
 * the safe range comes back as a `bigint` rather than a silently rounded
 * number. Blobs travel as base64 and come back as `Uint8Array`, as
 * `bun:sqlite` returns them.
 *
 * No dependency: the protocol is a handful of JSON shapes over `fetch`.
 */

import type { SQL } from 'bun'
import { asEmbeddedValue, bindNumberedPlaceholders, splitSqlStatements } from './db'

/** A Hrana value, as it appears on the wire. */
export type HranaValue =
  | { type: 'null' }
  | { type: 'integer', value: string }
  | { type: 'float', value: number }
  | { type: 'text', value: string }
  | { type: 'blob', base64: string }

/** A statement as Hrana expects it. */
export interface HranaStatement {
  sql: string
  args?: HranaValue[]
  named_args?: Array<{ name: string, value: HranaValue }>
  want_rows?: boolean
}

interface HranaColumn {
  name: string | null
  decltype?: string | null
}

/** The result of one executed statement. */
export interface HranaStatementResult {
  cols: HranaColumn[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
}

interface HranaError {
  message: string
  code?: string | null
}

type HranaRequest =
  | { type: 'execute', stmt: HranaStatement }
  | { type: 'batch', batch: { steps: Array<{ stmt: HranaStatement, condition?: HranaCondition | null }> } }
  | { type: 'get_autocommit' }
  | { type: 'close' }

type HranaCondition =
  | { type: 'ok', step: number }
  | { type: 'error', step: number }
  | { type: 'not', cond: HranaCondition }

type HranaResponse =
  | { type: 'execute', result: HranaStatementResult }
  | { type: 'batch', result: { step_results: Array<HranaStatementResult | null>, step_errors: Array<HranaError | null> } }
  | { type: 'get_autocommit', is_autocommit: boolean }
  | { type: 'close' }

type HranaStreamResult =
  | { type: 'ok', response: HranaResponse }
  | { type: 'error', error: HranaError }

interface HranaPipelineResponse {
  baton: string | null
  base_url: string | null
  results: HranaStreamResult[]
}

/** How integers beyond `Number.MAX_SAFE_INTEGER` are returned. */
export type LibSQLLargeIntegerMode = 'bigint' | 'string'

export interface LibSQLConnectionOptions {
  /**
   * `libsql://host`, `https://host`, `http://host`, or `ws(s)://host`.
   *
   * `libsql://` means TLS, as it does for every libSQL client; append
   * `?tls=0` for a plain-HTTP server such as `turso dev`. An `authToken`
   * query parameter is accepted and stripped from the URL, so it never ends
   * up in an error message.
   */
  url: string
  /** Bearer token (a Turso database token). Sent as `Authorization: Bearer`. */
  authToken?: string
  /** Abort a request that takes longer than this. Unset means no limit. */
  timeoutMs?: number
  /** Integers outside the safe range: `bigint` (default) or decimal `string`. */
  largeIntegers?: LibSQLLargeIntegerMode
  /** Test seam: the `fetch` implementation to use. */
  fetch?: typeof fetch
}

/** True when a URL names a libSQL server rather than a local SQLite file. */
export function isLibSQLUrl(url: unknown): url is string {
  return typeof url === 'string' && /^(?:libsql|https?|wss?):\/\//i.test(url.trim())
}

/**
 * Where the pipeline endpoint is, and the token a URL carried, if any.
 *
 * Exported for tests. The returned `baseUrl` has no credentials and no query
 * string, so it is safe to put in an error message.
 */
export function resolveLibSQLEndpoint(url: string): { baseUrl: string, authToken?: string } {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  }
  catch {
    throw new LibSQLError(`Invalid libSQL URL: expected libsql://, https://, http://, ws:// or wss://`, { code: 'LIBSQL_INVALID_URL' })
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  const tlsParam = parsed.searchParams.get('tls')
  const tlsOff = tlsParam === '0' || tlsParam === 'false'
  const authToken = parsed.searchParams.get('authToken') ?? undefined

  let protocol: 'http' | 'https'
  switch (scheme) {
    case 'libsql':
      protocol = tlsOff ? 'http' : 'https'
      break
    case 'https':
    case 'wss':
      protocol = 'https'
      break
    case 'http':
    case 'ws':
      protocol = 'http'
      break
    default:
      throw new LibSQLError(`Unsupported libSQL URL scheme '${scheme}:'`, { code: 'LIBSQL_INVALID_URL' })
  }

  if (parsed.username || parsed.password)
    throw new LibSQLError('libSQL URLs must not embed credentials; pass the token as authToken', { code: 'LIBSQL_INVALID_URL' })

  const path = parsed.pathname.replace(/\/+$/, '')
  return { baseUrl: `${protocol}://${parsed.host}${path}`, authToken: authToken || undefined }
}

/**
 * Extended SQLite result codes `bun:sqlite` reports for a constraint failure.
 *
 * Hrana hands back the PRIMARY code (`SQLITE_CONSTRAINT`) and SQLite's message.
 * Code across the framework recognises a duplicate by `SQLITE_CONSTRAINT_UNIQUE`
 * (or the bare primary code), so the extended code is recovered from the
 * message - which is SQLite's own and stable - to keep those checks working
 * unchanged on libSQL.
 */
const CONSTRAINT_CODES: Array<[RegExp, string, number]> = [
  [/^UNIQUE constraint failed/i, 'SQLITE_CONSTRAINT_UNIQUE', 2067],
  [/^NOT NULL constraint failed/i, 'SQLITE_CONSTRAINT_NOTNULL', 1299],
  [/^FOREIGN KEY constraint failed/i, 'SQLITE_CONSTRAINT_FOREIGNKEY', 787],
  [/^CHECK constraint failed/i, 'SQLITE_CONSTRAINT_CHECK', 275],
]

const PRIMARY_ERRNO: Record<string, number> = {
  SQLITE_ERROR: 1,
  SQLITE_INTERNAL: 2,
  SQLITE_PERM: 3,
  SQLITE_ABORT: 4,
  SQLITE_BUSY: 5,
  SQLITE_LOCKED: 6,
  SQLITE_NOMEM: 7,
  SQLITE_READONLY: 8,
  SQLITE_INTERRUPT: 9,
  SQLITE_IOERR: 10,
  SQLITE_CORRUPT: 11,
  SQLITE_FULL: 13,
  SQLITE_CANTOPEN: 14,
  SQLITE_SCHEMA: 17,
  SQLITE_TOOBIG: 18,
  SQLITE_CONSTRAINT: 19,
  SQLITE_MISMATCH: 20,
  SQLITE_MISUSE: 21,
  SQLITE_RANGE: 25,
}

export interface LibSQLErrorDetails {
  /** SQLite-style code, extended where it can be recovered (see above). */
  code: string
  /** SQLite's numeric result code, when the code is a SQLite one. */
  errno?: number
  /** The code exactly as the server sent it. */
  libsqlCode?: string
  /** HTTP status, for transport-level failures. */
  status?: number
  cause?: unknown
}

/**
 * An error from a libSQL server or the transport to it.
 *
 * Carries `code`/`errno` in the shape `bun:sqlite`'s `SQLiteError` does, so a
 * unique-violation check written for SQLite matches here too. Never carries
 * the auth token: messages are built from the server's reply and the host.
 */
export class LibSQLError extends Error {
  readonly code: string
  readonly errno?: number
  readonly libsqlCode?: string
  readonly status?: number

  constructor(message: string, details: LibSQLErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'LibSQLError'
    this.code = details.code
    this.errno = details.errno
    this.libsqlCode = details.libsqlCode
    this.status = details.status
  }
}

/** Turn a statement-level Hrana error into a SQLite-shaped `LibSQLError`. */
export function toLibSQLError(error: HranaError): LibSQLError {
  const raw = String(error.message ?? 'libSQL statement failed')
  // sqld prefixes SQLite's own message; bun:sqlite does not.
  const message = raw.replace(/^SQLite error:\s*/i, '')
  const serverCode = error.code ?? undefined

  for (const [pattern, code, errno] of CONSTRAINT_CODES) {
    if (pattern.test(message))
      return new LibSQLError(message, { code, errno, libsqlCode: serverCode })
  }

  if (serverCode && serverCode in PRIMARY_ERRNO)
    return new LibSQLError(message, { code: serverCode, errno: PRIMARY_ERRNO[serverCode], libsqlCode: serverCode })

  // sqld rejects what it cannot parse, or will not run (VACUUM, ATTACH, most
  // PRAGMAs), before SQLite sees it, and reports what SQLite refused while
  // preparing (`no such table`, `no such column`) as an input error. To a
  // caller both are SQLite errors.
  if (serverCode === 'SQL_PARSE_ERROR' || serverCode === 'SQL_INPUT_ERROR')
    return new LibSQLError(message, { code: 'SQLITE_ERROR', errno: 1, libsqlCode: serverCode })

  return new LibSQLError(message, { code: serverCode ?? 'LIBSQL_ERROR', libsqlCode: serverCode })
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * Encode one bound value for Hrana.
 *
 * Matches what `bun:sqlite` binds, with two deliberate differences, both of
 * which turn silent data loss into something visible:
 *  - a `Date` is sent as its ISO-8601 string (`bun:sqlite` binds NULL);
 *  - any other object throws (`bun:sqlite` binds NULL).
 */
export function encodeLibSQLValue(value: unknown): HranaValue {
  if (value === null || value === undefined)
    return { type: 'null' }

  switch (typeof value) {
    case 'string':
      return { type: 'text', value }
    case 'boolean':
      return { type: 'integer', value: value ? '1' : '0' }
    case 'number':
      if (!Number.isFinite(value))
        throw new RangeError(`Cannot bind ${value} to a libSQL statement: only finite numbers are allowed`)
      // Integral numbers bind as INTEGER, as bun:sqlite binds them, so
      // `typeof(?)`, LIMIT and integer-affinity comparisons see an integer.
      return Number.isSafeInteger(value)
        ? { type: 'integer', value: String(value === 0 ? 0 : value) }
        : { type: 'float', value }
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX)
        throw new RangeError(`Cannot bind ${value} to a libSQL statement: it does not fit in a 64-bit integer`)
      return { type: 'integer', value: value.toString() }
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new RangeError('Cannot bind an invalid Date to a libSQL statement')
    return { type: 'text', value: value.toISOString() }
  }
  if (value instanceof Uint8Array)
    return { type: 'blob', base64: toBase64(value) }
  if (value instanceof ArrayBuffer)
    return { type: 'blob', base64: toBase64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value))
    return { type: 'blob', base64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }

  throw new TypeError(`Cannot bind a value of type ${Object.prototype.toString.call(value).slice(8, -1)} to a libSQL statement; serialize it first (e.g. JSON.stringify)`)
}

/** Decode one Hrana value into what `bun:sqlite` would have returned. */
export function decodeLibSQLValue(value: HranaValue, largeIntegers: LibSQLLargeIntegerMode = 'bigint'): unknown {
  switch (value.type) {
    case 'null':
      return null
    case 'integer': {
      const n = Number(value.value)
      if (Number.isSafeInteger(n))
        return n
      return largeIntegers === 'string' ? value.value : BigInt(value.value)
    }
    case 'float':
      return typeof value.value === 'number' ? value.value : Number(value.value)
    case 'text':
      return value.value
    case 'blob': {
      const buf = Buffer.from(value.base64 ?? '', 'base64')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    default:
      throw new LibSQLError(`Unknown libSQL value type '${(value as { type?: unknown }).type}'`, { code: 'LIBSQL_PROTOCOL_ERROR' })
  }
}

/**
 * A query result in the shape the sqlite code paths read.
 *
 * Always an array of rows - empty for a statement that returns none - so a
 * caller that destructures rows never gets a non-iterable. The write metadata
 * rides along under every name a caller looks for it: `changes` and
 * `lastInsertRowid` (bun:sqlite's `run()`), `count` (Bun's network drivers).
 */
export type LibSQLRows = Array<Record<string, unknown>> & {
  changes: number
  count: number
  lastInsertRowid: number | bigint | string | null
  columns: string[]
}

export function toLibSQLRows(result: HranaStatementResult, largeIntegers: LibSQLLargeIntegerMode = 'bigint'): LibSQLRows {
  const names = result.cols.map((col, i) => col.name ?? String(i))
  const rows = result.rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < names.length; i++)
      out[names[i]] = decodeLibSQLValue(row[i] ?? { type: 'null' }, largeIntegers)
    return out
  }) as LibSQLRows

  const affected = Number(result.affected_row_count ?? 0)
  const lastInsertRowid = result.last_insert_rowid == null
    ? null
    : decodeLibSQLValue({ type: 'integer', value: result.last_insert_rowid }, largeIntegers) as number | bigint | string
  // Non-enumerable, so the array still compares, spreads and serializes as
  // just its rows.
  const meta = (value: unknown): PropertyDescriptor => ({ value, enumerable: false, writable: true, configurable: true })
  Object.defineProperties(rows, {
    changes: meta(affected),
    // A SELECT affects nothing but did return rows; Bun's network drivers
    // report the row count there, and a DELETE ... RETURNING reports both.
    count: meta(affected > 0 ? affected : rows.length),
    lastInsertRowid: meta(lastInsertRowid),
    columns: meta(names),
  })
  return rows
}

/** Positional or named parameters, as callers pass them. */
export type LibSQLParams = readonly unknown[] | Record<string, unknown>

/** Build a Hrana statement, rewriting `$n` to SQLite's positional `?`. */
export function toHranaStatement(sql: string, params: LibSQLParams = []): HranaStatement {
  if (!Array.isArray(params)) {
    const named = Object.entries(params as Record<string, unknown>).map(([name, value]) => ({
      // SQLite parameter names carry their prefix; accept `{ id: 1 }` for `:id`.
      name: /^[:@$]/.test(name) ? name : `:${name}`,
      value: encodeLibSQLValue(value),
    }))
    return { sql, named_args: named, want_rows: true }
  }
  const bound = bindNumberedPlaceholders(sql, [...params])
  return { sql: bound.sql, args: bound.params.map(encodeLibSQLValue), want_rows: true }
}

/** Statements that can open or close a transaction on the connection. */
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i

/** `PRAGMA foreign_keys = x` / `PRAGMA foreign_keys(x)`, capturing x. */
const FOREIGN_KEYS_PRAGMA = /^\s*PRAGMA\s+(?:main\.)?foreign_keys\s*(?:=\s*|\(\s*)['"]?(\w+)['"]?\s*\)?\s*;?\s*$/i

function readForeignKeysPragma(sql: string): string | null {
  const match = FOREIGN_KEYS_PRAGMA.exec(sql)
  return match ? match[1].toUpperCase() : null
}

interface PipelineOutcome {
  results: HranaStreamResult[]
}

/** The HTTP side: one POST per pipeline, with transport errors made legible. */
class HranaHttp {
  readonly baseUrl: string
  private readonly authToken?: string
  private readonly timeoutMs?: number
  private readonly fetchImpl: typeof fetch

  constructor(options: LibSQLConnectionOptions) {
    const endpoint = resolveLibSQLEndpoint(options.url)
    this.baseUrl = endpoint.baseUrl
    this.authToken = options.authToken || endpoint.authToken
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetch ?? fetch
  }

  async pipeline(baseUrl: string, baton: string | null, requests: HranaRequest[]): Promise<HranaPipelineResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.authToken)
      headers.authorization = `Bearer ${this.authToken}`

    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}/v3/pipeline`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ baton, requests }),
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      })
    }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new LibSQLError(`Could not reach the libSQL server at ${this.baseUrl}: ${reason}`, { code: 'LIBSQL_CONNECTION_FAILED', cause })
    }

    if (!response.ok) {
      const detail = await readErrorBody(response)
      const suffix = detail ? ` (${detail})` : ''
      if (response.status === 401 || response.status === 403) {
        throw new LibSQLError(
          `The libSQL server at ${this.baseUrl} rejected the request: HTTP ${response.status}${suffix}. `
          + (this.authToken ? 'The auth token was refused - check that it belongs to this database and has not expired.' : 'No auth token was sent - set one (TURSO_AUTH_TOKEN in Stacks).'),
          { code: 'LIBSQL_UNAUTHORIZED', status: response.status },
        )
      }
      if (response.status === 404) {
        throw new LibSQLError(
          `The libSQL server at ${this.baseUrl} has no Hrana v3 pipeline endpoint (HTTP 404). Check the URL, and that the server is sqld 0.21+ or Turso.`,
          { code: 'LIBSQL_NOT_FOUND', status: 404 },
        )
      }
      throw new LibSQLError(`The libSQL server at ${this.baseUrl} answered HTTP ${response.status}${suffix}`, { code: 'LIBSQL_HTTP_ERROR', status: response.status })
    }

    const body = await response.json() as HranaPipelineResponse
    if (!body || !Array.isArray(body.results))
      throw new LibSQLError(`The libSQL server at ${this.baseUrl} sent a reply that is not a Hrana pipeline response`, { code: 'LIBSQL_PROTOCOL_ERROR' })
    return body
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    if (!text)
      return ''
    try {
      const parsed = JSON.parse(text) as { error?: unknown, message?: unknown }
      const message = parsed.error ?? parsed.message
      if (typeof message === 'string')
        return message
    }
    catch {
      // Not JSON; fall through to the text itself.
    }
    return text.slice(0, 300)
  }
  catch {
    return ''
  }
}

/**
 * A server-side connection kept open across requests by its baton.
 *
 * A baton is good for exactly one request, so requests are chained: each waits
 * for the previous reply. That also makes concurrent queries on one transaction
 * handle safe - they queue instead of racing for the baton.
 */
class HranaStream {
  private baton: string | null = null
  private baseUrl: string
  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  closed = false

  constructor(private readonly http: HranaHttp, private readonly prelude: () => HranaRequest[]) {
    this.baseUrl = http.baseUrl
  }

  /** Send requests on this stream; `close` appends a close request. */
  send(requests: HranaRequest[], options: { close?: boolean } = {}): Promise<HranaStreamResult[]> {
    const run = async (): Promise<HranaStreamResult[]> => {
      if (this.closed)
        throw new LibSQLError('This libSQL stream is closed', { code: 'LIBSQL_STREAM_CLOSED' })
      // The first request on a stream carries the connection's session state.
      const prelude = this.opened ? [] : this.prelude()
      this.opened = true
      const all: HranaRequest[] = [...prelude, ...requests]
      if (options.close)
        all.push({ type: 'close' })

      let reply: HranaPipelineResponse
      try {
        reply = await this.http.pipeline(this.baseUrl, this.baton, all)
      }
      catch (error) {
        // A stream whose request failed in transport is unusable: the baton it
        // would have needed never arrived.
        this.closed = true
        throw error
      }
      this.baton = reply.baton
      if (reply.base_url)
        this.baseUrl = reply.base_url.replace(/\/+$/, '')
      if (options.close || reply.baton === null)
        this.closed = true

      for (let i = 0; i < prelude.length; i++) {
        const result = reply.results[i]
        if (result?.type === 'error')
          throw toLibSQLError(result.error)
      }
      return reply.results.slice(prelude.length, prelude.length + requests.length)
    }

    const result = this.tail.then(run, run)
    this.tail = result.catch(() => {})
    return result
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    // A stream never opened has nothing on the server to close.
    if (!this.opened) {
      this.closed = true
      return
    }
    await this.send([], { close: true })
  }
}

function executeResult(result: HranaStreamResult | undefined): HranaStatementResult {
  if (!result)
    throw new LibSQLError('The libSQL server sent fewer results than requests', { code: 'LIBSQL_PROTOCOL_ERROR' })
  if (result.type === 'error')
    throw toLibSQLError(result.error)
  if (result.response.type !== 'execute')
    throw new LibSQLError(`Expected an execute result, got '${result.response.type}'`, { code: 'LIBSQL_PROTOCOL_ERROR' })
  return result.response.result
}

function autocommitResult(result: HranaStreamResult | undefined): boolean {
  if (result?.type === 'ok' && result.response.type === 'get_autocommit')
    return result.response.is_autocommit
  // Unknown: assume a transaction is still open, which keeps the stream.
  return false
}

/** One statement in a `batch()`. */
export interface LibSQLBatchStatement {
  sql: string
  args?: LibSQLParams
}

/**
 * Shared, per-connection state: the HTTP client, the session pragma, and the
 * stream a raw BEGIN pinned the connection to.
 */
class LibSQLSession {
  readonly http: HranaHttp
  readonly largeIntegers: LibSQLLargeIntegerMode
  /** Last `PRAGMA foreign_keys` value set on this connection, if any. */
  foreignKeys: string | null = null
  /** The stream a raw BEGIN / SAVEPOINT opened, until autocommit resumes. */
  pinned: HranaStream | null = null
  closed = false

  constructor(options: LibSQLConnectionOptions) {
    this.http = new HranaHttp(options)
    this.largeIntegers = options.largeIntegers ?? 'bigint'
  }

  prelude = (): HranaRequest[] => this.foreignKeys
    ? [{ type: 'execute', stmt: { sql: `PRAGMA foreign_keys = ${this.foreignKeys}`, want_rows: false } }]
    : []

  openStream(): HranaStream {
    this.assertOpen()
    return new HranaStream(this.http, this.prelude)
  }

  assertOpen(): void {
    if (this.closed)
      throw new LibSQLError('Cannot use a closed libSQL connection', { code: 'LIBSQL_CLOSED' })
  }

  rows(result: HranaStatementResult): LibSQLRows {
    return toLibSQLRows(result, this.largeIntegers)
  }

  notePragma(sql: string): void {
    const value = readForeignKeysPragma(sql)
    if (value)
      this.foreignKeys = value === 'OFF' || value === '0' || value === 'FALSE' || value === 'NO' ? 'OFF' : 'ON'
  }

  /**
   * Run one statement outside any transaction handle.
   *
   * Stateless unless the connection is pinned. A transaction-control
   * statement opens a stream and asks the server whether it left autocommit;
   * if it did, the connection stays on that stream (as a single SQLite
   * connection would) until a later statement returns it to autocommit.
   */
  async execute(stmt: HranaStatement): Promise<LibSQLRows> {
    this.assertOpen()
    const control = TRANSACTION_CONTROL.test(stmt.sql)

    if (this.pinned) {
      const stream = this.pinned
      const requests: HranaRequest[] = [{ type: 'execute', stmt }]
      if (control)
        requests.push({ type: 'get_autocommit' })
      let results: HranaStreamResult[]
      try {
        results = await stream.send(requests)
      }
      catch (error) {
        if (this.pinned === stream)
          this.pinned = null
        throw error
      }
      if (control && autocommitResult(results[1])) {
        if (this.pinned === stream)
          this.pinned = null
        await stream.close().catch(() => {})
      }
      const result = this.rows(executeResult(results[0]))
      this.notePragma(stmt.sql)
      return result
    }

    if (control) {
      const stream = this.openStream()
      let results: HranaStreamResult[]
      try {
        results = await stream.send([{ type: 'execute', stmt }, { type: 'get_autocommit' }])
      }
      catch (error) {
        await stream.close().catch(() => {})
        throw error
      }
      const failed = results[0]?.type === 'error'
      if (!failed && !autocommitResult(results[1]))
        this.pinned = stream
      else
        await stream.close().catch(() => {})
      return this.rows(executeResult(results[0]))
    }

    const stream = this.openStream()
    const [result] = await stream.send([{ type: 'execute', stmt }], { close: true })
    const rows = this.rows(executeResult(result))
    this.notePragma(stmt.sql)
    return rows
  }

  async close(): Promise<void> {
    this.closed = true
    const pinned = this.pinned
    this.pinned = null
    await pinned?.close().catch(() => {})
  }
}

/** Where a connection object sends its statements. */
interface StatementTarget {
  execute: (stmt: HranaStatement) => Promise<LibSQLRows>
  /** Several statements, stopping at the first failure. */
  sequence: (stmts: HranaStatement[]) => Promise<LibSQLRows[]>
}

/** Statements on an open stream (a transaction handle). */
function streamTarget(session: LibSQLSession, stream: HranaStream): StatementTarget {
  return {
    async execute(stmt) {
      const [result] = await stream.send([{ type: 'execute', stmt }])
      const rows = session.rows(executeResult(result))
      session.notePragma(stmt.sql)
      return rows
    },
    async sequence(stmts) {
      const out: LibSQLRows[] = []
      for (const stmt of stmts)
        out.push(await this.execute(stmt))
      return out
    },
  }
}

/** Statements on the connection itself: stateless unless pinned. */
function sessionTarget(session: LibSQLSession): StatementTarget {
  return {
    execute: stmt => session.execute(stmt),
    async sequence(stmts) {
      // One stream for the whole sequence, so a file's own BEGIN ... COMMIT or
      // PRAGMA brackets apply to the statements between them. A pinned
      // connection already has that stream.
      if (session.pinned) {
        const out: LibSQLRows[] = []
        for (const stmt of stmts)
          out.push(await session.execute(stmt))
        return out
      }
      const stream = session.openStream()
      try {
        const out: LibSQLRows[] = []
        for (const stmt of stmts)
          out.push(await streamTarget(session, stream).execute(stmt))
        return out
      }
      finally {
        // Closing the stream rolls back a transaction the sequence left open
        // by failing half way, rather than leaving it to time out.
        await stream.close().catch(() => {})
      }
    },
  }
}

/** A raw-SQL marker, as `sql('identifier')` returns on the sqlite wrapper. */
function rawMarker(value: string): { __raw: true, value: string, toString: () => string } {
  return { __raw: true, value, toString: () => value }
}

/** Compile a tagged template the way the sqlite wrapper does. */
function compileTemplate(strings: TemplateStringsArray, values: unknown[]): { sql: string, params: unknown[] } {
  let sql = strings[0]
  const params: unknown[] = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    const embedded = asEmbeddedValue(value)
    // Nested queries first: they also carry `raw`, see db.ts (#1084).
    if (embedded && typeof embedded.sql === 'string' && Array.isArray(embedded.values)) {
      sql += embedded.sql + (strings[i + 1] || '')
      params.push(...embedded.values)
    }
    else if (embedded && (embedded.__raw || embedded.raw)) {
      const raw = embedded.raw
      const rawValue = embedded.__raw ? embedded.value : (typeof raw === 'string' ? raw : (raw as () => string)())
      sql += rawValue + (strings[i + 1] || '')
    }
    else if (Array.isArray(value)) {
      sql += value.map(() => '?').join(', ') + (strings[i + 1] || '')
      params.push(...value)
    }
    else {
      sql += `?${strings[i + 1] || ''}`
      params.push(value)
    }
  }
  return { sql, params }
}

interface ConnectionScope {
  session: LibSQLSession
  target: StatementTarget
  /** The open stream when this handle is a transaction, else null. */
  stream: HranaStream | null
  depth: number
}

function makeQuery(scope: ConnectionScope, sql: string, params: LibSQLParams, thenable: boolean): Record<string, unknown> {
  const execute = (): Promise<LibSQLRows> => {
    try {
      return scope.target.execute(toHranaStatement(sql, params))
    }
    catch (error) {
      return Promise.reject(error)
    }
  }
  const query: Record<string, unknown> = {
    sql,
    values: params,
    execute,
    raw: () => sql,
    toString: () => sql,
    cancel: () => {},
  }
  // `unsafe()` results are awaitable, matching Bun's SQL and the sqlite
  // wrapper (#1017). Tagged-template queries are not, as on the wrapper.
  if (thenable)
    query.then = (onFulfilled: (rows: LibSQLRows) => unknown, onRejected?: (err: unknown) => unknown) => execute().then(onFulfilled, onRejected)
  return query
}

function makeConnection(scope: ConnectionScope): SQL {
  function sqlFunction(stringsOrValue: TemplateStringsArray | string, ...values: unknown[]): unknown {
    if (Array.isArray(stringsOrValue) && 'raw' in stringsOrValue) {
      const { sql, params } = compileTemplate(stringsOrValue as TemplateStringsArray, values)
      return makeQuery(scope, sql, params, false)
    }
    if (typeof stringsOrValue === 'string')
      return rawMarker(stringsOrValue)
    return makeQuery(scope, '', [], false)
  }

  sqlFunction.raw = (str: string) => rawMarker(str)

  sqlFunction.unsafe = (sql: string, params: LibSQLParams = []) => makeQuery(scope, sql, params ?? [], true)

  sqlFunction.query = (sql: string, params?: LibSQLParams) => {
    try {
      return scope.target.execute(toHranaStatement(sql, params ?? []))
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Run a SQL file. All of it travels on one stream, so a file that brackets
   * its own work with `PRAGMA foreign_keys=OFF` / `BEGIN` ... `COMMIT` (the
   * SQLite table-rebuild recipe) behaves as it does on a local file.
   */
  sqlFunction.file = async (filePath: string) => {
    const { readFileSync } = await import('node:fs')
    const statements = splitSqlStatements(readFileSync(filePath, 'utf-8'))
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'))
    await scope.target.sequence(statements.map(s => toHranaStatement(s)))
    return []
  }

  /**
   * Several statements in ONE round trip, atomically: wrapped in BEGIN/COMMIT
   * on a single stream, each step conditional on the one before, so the first
   * failure skips the rest and rolls everything back.
   */
  sqlFunction.batch = async (statements: LibSQLBatchStatement[]): Promise<LibSQLRows[]> => {
    scope.session.assertOpen()
    if (statements.length === 0)
      return []
    const inTransaction = scope.stream !== null
    const stmts = statements.map(s => toHranaStatement(s.sql, s.args ?? []))
    const steps: Array<{ stmt: HranaStatement, condition?: HranaCondition | null }> = []
    if (!inTransaction)
      steps.push({ stmt: { sql: 'BEGIN' } })
    for (const stmt of stmts)
      steps.push({ stmt, condition: steps.length ? { type: 'ok', step: steps.length - 1 } : null })
    if (!inTransaction) {
      const last = steps.length - 1
      steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: last } })
      steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: last + 1 } } })
    }

    const stream = scope.stream ?? scope.session.openStream()
    let results: HranaStreamResult[]
    try {
      results = await stream.send([{ type: 'batch', batch: { steps } }], { close: !inTransaction })
    }
    finally {
      if (!inTransaction)
        await stream.close().catch(() => {})
    }

    const reply = results[0]
    if (!reply)
      throw new LibSQLError('The libSQL server sent no batch result', { code: 'LIBSQL_PROTOCOL_ERROR' })
    if (reply.type === 'error')
      throw toLibSQLError(reply.error)
    if (reply.response.type !== 'batch')
      throw new LibSQLError(`Expected a batch result, got '${reply.response.type}'`, { code: 'LIBSQL_PROTOCOL_ERROR' })

    const { step_results: stepResults, step_errors: stepErrors } = reply.response.result
    const offset = inTransaction ? 0 : 1
    for (let i = 0; i < stepErrors.length; i++) {
      const error = stepErrors[i]
      if (error)
        throw toLibSQLError(error)
    }
    return stmts.map((_, i) => {
      const result = stepResults[i + offset]
      if (!result)
        throw new LibSQLError(`Batch statement ${i + 1} did not run`, { code: 'LIBSQL_BATCH_SKIPPED' })
      return scope.session.rows(result)
    })
  }

  /**
   * `begin(fn)` / `begin(name, fn)`: a transaction on its own stream.
   *
   * Called on a transaction handle, it nests as a SAVEPOINT on that stream,
   * exactly as the sqlite wrapper nests.
   */
  sqlFunction.begin = async (fnOrName: unknown, maybeFn?: unknown): Promise<unknown> => {
    const fn = (typeof fnOrName === 'function' ? fnOrName : maybeFn) as ((tx: SQL) => unknown) | undefined
    if (typeof fn !== 'function')
      throw new TypeError('[query-builder] libsql begin(): a transaction callback is required')
    scope.session.assertOpen()

    if (scope.stream) {
      const name = `qb_sp_${scope.depth}`
      const target = scope.target
      await target.execute({ sql: `SAVEPOINT ${name}` })
      const inner = makeConnection({ ...scope, depth: scope.depth + 1 })
      try {
        const result = await fn(inner)
        await target.execute({ sql: `RELEASE SAVEPOINT ${name}` })
        return result
      }
      catch (error) {
        try {
          await target.execute({ sql: `ROLLBACK TO SAVEPOINT ${name}` })
          await target.execute({ sql: `RELEASE SAVEPOINT ${name}` })
        }
        catch {
          // Surface the original failure, not the cleanup one.
        }
        throw error
      }
    }

    const stream = scope.session.openStream()
    const target = streamTarget(scope.session, stream)
    try {
      await target.execute({ sql: 'BEGIN' })
    }
    catch (error) {
      await stream.close().catch(() => {})
      throw error
    }

    const tx = makeConnection({ session: scope.session, target, stream, depth: 1 })
    let result: unknown
    try {
      result = await fn(tx)
    }
    catch (error) {
      try {
        await stream.send([{ type: 'execute', stmt: { sql: 'ROLLBACK' } }], { close: true })
      }
      catch {
        // Closing the stream rolls back anyway; keep the caller's error.
        await stream.close().catch(() => {})
      }
      throw error
    }

    // COMMIT and close in one round trip. A failed COMMIT (a deferred foreign
    // key, a lost stream) is the caller's error: nothing was committed.
    const [commit] = await stream.send([{ type: 'execute', stmt: { sql: 'COMMIT' } }], { close: true })
    executeResult(commit)
    return result
  }

  sqlFunction.savepoint = sqlFunction.begin

  sqlFunction.beginDistributed = async (): Promise<never> => {
    throw new Error('[query-builder] beginDistributed() (two-phase commit) is not supported on libSQL. Use begin()/transaction().')
  }

  sqlFunction.close = async (): Promise<void> => {
    // Closing a transaction handle is not closing the connection.
    if (scope.stream)
      return
    await scope.session.close()
  }

  /** Marks this connection as libSQL for callers that need to know. */
  sqlFunction.libsql = { url: scope.session.http.baseUrl, transaction: scope.stream !== null }

  return sqlFunction as unknown as SQL
}

/**
 * Build a connection to a libSQL server with the surface of Bun's `SQL`.
 *
 * Nothing is sent until the first query.
 */
export function createLibSQLSQL(options: LibSQLConnectionOptions): SQL {
  const session = new LibSQLSession(options)
  return makeConnection({ session, target: sessionTarget(session), stream: null, depth: 0 })
}

/** Whether a connection object was built by {@link createLibSQLSQL}. */
export function isLibSQLConnection(connection: unknown): boolean {
  return (typeof connection === 'function' || (typeof connection === 'object' && connection !== null))
    && typeof (connection as { libsql?: unknown }).libsql === 'object'
    && (connection as { libsql?: unknown }).libsql !== null
}
