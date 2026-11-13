/**
 * A network database, queried synchronously.
 *
 * Bun's MySQL and Postgres drivers answer with promises: the query goes out on
 * the event loop and the rows come back in a later turn. That is what makes
 * `const user = User.where(...).first()` a pending promise instead of a row.
 * `bun:sqlite` has never had the problem, because it runs the query where it
 * is called.
 *
 * This gives the network dialects the same shape. The connection lives on a
 * worker thread, which runs Bun's driver exactly as before. The calling thread
 * hands it the statement and waits, on a futex, until the rows are back. The
 * caller gets a plain value; `await` on a plain value still works, so code
 * written either way runs.
 *
 * What it costs is what `bun:sqlite` already costs: nothing else runs on the
 * calling thread while a query is in flight. That is the model PHP and Ruby
 * servers have always had, and it is why this is a choice (`models.execution`
 * in the config) and not the only path.
 *
 * ## The one statement that cannot wait on this thread
 *
 * Waiting on the calling thread is safe as long as nothing the statement
 * needs can only be produced by that thread. One thing can: a transaction
 * whose callback is `async`. It stays open across an `await`, holding its row
 * locks, and the code that will commit it is a continuation waiting for this
 * thread. A statement that needs one of those locks would wait for the commit
 * while the commit waits for the statement.
 *
 * So while a transaction (or a reserved connection) is held open across an
 * `await` in this process, each statement is watched. The worker says which
 * database connection it is running on, and the database is asked whether
 * that connection is waiting on one of the held ones. If it is, and only
 * then, the call stops waiting and answers with a promise of its rows: the
 * rows cannot exist until other code has run, so there is no value to give.
 * The same goes for a statement that needs a connection when every one in the
 * pool is held. Everything else still answers where it is called, and a
 * program that keeps its transactions synchronous never has a held one.
 *
 * The worker's source is a string, not a file, so it survives being bundled,
 * minified and compiled into a binary: there is no second file to find at
 * runtime.
 */

import type { receiveMessageOnPort, Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const requireHostModule = createRequire(import.meta.url)

/**
 * A statement's answer in the shape Bun's driver gives it: the rows, as an
 * array, carrying what the driver reported about the statement. Code written
 * against the driver's own result reads this one the same way.
 */
export type SyncQueryResult = Record<string, unknown>[] & {
  count?: number
  affectedRows?: number
  lastInsertRowid?: number | bigint
  command?: string
}

/** A value where the statement answered in place, a promise of it where it had to wait for this thread's own code. */
export type Answer<T> = T | Promise<T>

/** Where and how a statement runs. */
export interface StatementOptions {
  /** A transaction, savepoint or reserved connection from {@link SyncDriver.open}. Without one the statement takes any pooled connection. */
  session?: string
  /** Rows as arrays of values (`values`) or of raw buffers (`raw`) instead of objects. */
  mode?: 'values' | 'raw'
  /** The simple query protocol: several statements in one text, no parameters. */
  simple?: boolean
}

/**
 * A template literal as it crosses to the worker: the literal's strings and
 * its values, where a value may itself be a nested template, a call to the
 * driver's helper (`sql('name')`, `sql({ ... })`) or `sql.array(...)`.
 */
export interface SyncTemplate {
  __qb: 'template'
  strings: string[]
  raw: string[]
  values: unknown[]
}

interface WorkerReply {
  /** The request this answers. 0 is the worker announcing it has opened. */
  id: number
  ok: boolean
  /**
   * Not the answer yet, but something about it: `backend` names the database
   * connection the statement is running on, `queued` says it is waiting for a
   * connection because every one in the pool is taken.
   */
  note?: 'backend' | 'queued'
  /** The database's own id for a connection: `pg_backend_pid()`, `CONNECTION_ID()`. Null where it cannot be read. */
  backend?: number | null
  /** Whether the connection asked about is waiting on one of the held ones. Null where the database cannot say. */
  blocked?: boolean | null
  rows?: Record<string, unknown>[]
  count?: number | null
  affectedRows?: number | null
  lastInsertRowid?: number | bigint | null
  command?: string | null
  error?: { name: string, message: string, stack?: string, fields: Record<string, unknown> }
}

const WORKER_SOURCE = /* js */ `
import { SQL } from 'bun'
import { parentPort, workerData } from 'node:worker_threads'

const { signal, port, url, options } = workerData
const flag = new Int32Array(signal)
// One count per reply. The caller sleeps while the count is the one it last
// saw, so a reply that lands before it sleeps is never missed.
const reply = (message) => {
  port.postMessage(message)
  Atomics.add(flag, 0, 1)
  Atomics.notify(flag, 0)
}
// Statements in flight, by id, so one the caller stopped waiting for can be cancelled.
const running = new Map()
const describe = (error) => {
  const fields = {}
  if (error && typeof error === 'object') {
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key === 'stack' || key === 'message' || key === 'name') continue
      const value = error[key]
      if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) fields[key] = value
    }
  }
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack,
    fields,
  }
}

let sql
try {
  sql = new SQL(url, options)
  reply({ id: 0, ok: true })
}
catch (error) {
  reply({ id: 0, ok: false, error: describe(error) })
}

const dialect = /^postgres/i.test(url) ? 'postgres' : /^(mysql|mariadb)/i.test(url) ? 'mysql' : null
// How many connections the pool may open, and how many are out of it: one per
// transaction or reserved connection, and one per watched statement.
const capacity = Number(options?.max) > 0 ? Number(options.max) : 10
let inUse = 0

// A transaction, a savepoint or a reserved connection the caller holds open
// across statements. The driver's own begin()/savepoint() own the BEGIN, the
// COMMIT and the ROLLBACK: each is held inside its callback until the caller
// says how it ended, so nothing here has to know a dialect's syntax for them.
const sessions = new Map()
const ROLLED_BACK = Symbol('rolled back')

// The database's own id for a connection, asked once and remembered. It is
// what the database's lock tables name, which is how a statement waiting on a
// transaction this process holds open is told from one that is merely slow.
const backends = new WeakMap()
const backendOf = async (connection) => {
  if (!dialect)
    return null
  if (backends.has(connection))
    return backends.get(connection)
  let backend = null
  try {
    const rows = await connection.unsafe(dialect === 'postgres' ? 'SELECT pg_backend_pid() AS backend' : 'SELECT CONNECTION_ID() AS backend')
    backend = Number(rows[0]?.backend) || null
  }
  catch {}
  backends.set(connection, backend)
  return backend
}
// A savepoint runs on its transaction's connection: same backend.
const backendOfSession = async (session) => {
  if (session.backend === undefined)
    session.backend = session.parent ? await backendOfSession(session.parent) : await backendOf(session.connection)
  return session.backend
}

// The lock tables are read on a connection of their own, so the question can
// be asked while every pooled connection is busy or held.
let watcher
let cannotSay = false
const integers = values => values.filter(value => Number.isInteger(value)).join(', ')
const blockedBy = async (waiting, holders) => {
  if (cannotSay || !dialect || !Number.isInteger(waiting) || holders.length === 0)
    return null
  try {
    watcher ??= new SQL(url, { ...options, max: 1 })
    if (dialect === 'postgres') {
      // Followed through other connections too: waiting on one that waits on a
      // held one is waiting on the held one.
      const rows = await watcher.unsafe(
        'WITH RECURSIVE chain(pid, depth) AS ('
        + ' SELECT blocker, 1 FROM unnest(pg_blocking_pids(' + waiting + ')) AS blocker'
        + ' UNION'
        + ' SELECT blocker, chain.depth + 1 FROM chain, unnest(pg_blocking_pids(chain.pid)) AS blocker WHERE chain.depth < 6'
        + ') SELECT EXISTS (SELECT 1 FROM chain WHERE pid IN (' + integers(holders) + ')) AS blocked',
      )
      return rows[0]?.blocked === true
    }
    const rows = await watcher.unsafe(
      'SELECT 1 AS blocked FROM performance_schema.data_lock_waits w'
      + ' JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID'
      + ' JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID'
      + ' WHERE r.PROCESSLIST_ID = ' + waiting + ' AND b.PROCESSLIST_ID IN (' + integers(holders) + ') LIMIT 1',
    )
    return rows.length > 0
  }
  catch {
    // No such table, or no right to read it: this database cannot say.
    cannotSay = true
    return null
  }
}

// A template literal the caller built on its own thread, rebuilt on the
// connection that will run it. Identifiers and row helpers are the driver's
// own: sql('name'), sql({ ... }), sql([ ... ]), sql.array([ ... ]).
const revive = (target, value) => {
  if (value === null || typeof value !== 'object')
    return value
  if (value.__qb === 'template')
    return build(target, value)
  if (value.__qb === 'helper')
    return target(...value.args.map(arg => revive(target, arg)))
  if (value.__qb === 'array')
    return target.array(...value.args)
  if (value.__qb === 'unsafe')
    return target.unsafe(value.sql, value.params)
  return value
}
const build = (target, template) => {
  // What the driver takes for a template literal's strings: frozen, with a
  // frozen raw list that is not enumerable.
  const strings = template.strings.slice()
  Object.defineProperty(strings, 'raw', { value: Object.freeze(template.raw.slice()) })
  return target(Object.freeze(strings), ...template.values.map(value => revive(target, value)))
}

// A bound value may be one of the driver's own, built by its helper on the
// caller's side: sql.array([ ... ], 'timestamptz') for = ANY($1).
const marked = value => value !== null && typeof value === 'object' && typeof value.__qb === 'string'
const bindings = (target, params) => Array.isArray(params) && params.some(marked)
  ? params.map(value => revive(target, value))
  : params

const sessionFor = (name) => {
  const session = sessions.get(name)
  if (!session)
    throw new Error('[bun-query-builder] This transaction is over: it was committed or rolled back before the statement ran.')
  return session
}

const open = (job) => {
  const above = job.parent ? sessionFor(job.parent) : undefined
  const parent = above ? above.connection : sql
  // A savepoint is on its transaction's connection. Everything else takes one.
  const takes = job.kind !== 'savepoint'
  if (takes && job.watch && inUse >= capacity)
    reply({ id: job.id, ok: true, note: 'queued' })
  if (job.kind === 'reserve') {
    parent.reserve().then((connection) => {
      inUse++
      sessions.set(job.session, { kind: 'reserve', connection, takes })
      reply({ id: job.id, ok: true })
    }, error => reply({ id: job.id, ok: false, error: describe(error) }))
    return
  }
  let announced = false
  const session = { kind: job.kind, connection: null, finish: null, done: null, parent: above, takes }
  const hold = (connection) => {
    session.connection = connection
    sessions.set(job.session, session)
    if (takes)
      inUse++
    announced = true
    reply({ id: job.id, ok: true })
    return new Promise((resolve, reject) => { session.finish = { resolve, reject } })
  }
  const args = job.kind === 'distributed' ? [job.name, hold] : job.options ? [job.options, hold] : [hold]
  const method = job.kind === 'savepoint' ? 'savepoint' : job.kind === 'distributed' ? 'beginDistributed' : 'begin'
  try {
    session.done = parent[method](...args)
  }
  catch (error) {
    reply({ id: job.id, ok: false, error: describe(error) })
    return
  }
  // Failing to open is this request's answer. Failing later is the answer to
  // whoever ends the session, and is read there.
  session.done.then(() => {}, (error) => {
    if (!announced)
      reply({ id: job.id, ok: false, error: describe(error) })
  })
}

const end = async (job) => {
  const session = sessions.get(job.session)
  if (!session)
    return reply({ id: job.id, ok: true })
  // A commit waits for whatever is still running on its connection, so it can
  // be waiting on a held transaction too.
  if (job.watch)
    reply({ id: job.id, ok: true, note: 'backend', backend: await backendOfSession(session) })
  sessions.delete(job.session)
  try {
    if (session.kind === 'reserve') {
      await session.connection.release?.()
      return reply({ id: job.id, ok: true })
    }
    if (job.commit)
      session.finish.resolve()
    else
      session.finish.reject(ROLLED_BACK)
    try {
      await session.done
      reply({ id: job.id, ok: true })
    }
    catch (error) {
      if (error === ROLLED_BACK)
        reply({ id: job.id, ok: true })
      else
        reply({ id: job.id, ok: false, error: describe(error) })
    }
  }
  finally {
    if (session.takes)
      inUse--
  }
}

const statement = (target, job) => {
  let query = job.op === 'template'
    ? build(target, job.template)
    : job.op === 'file'
      ? target.file(job.path, bindings(target, job.params))
      : target.unsafe(job.sql, bindings(target, job.params))
  if (job.simple)
    query = query.simple()
  if (job.mode === 'values')
    query = query.values()
  else if (job.mode === 'raw')
    query = query.raw()
  return query
}

const run = async (target, job) => {
  const query = statement(target, job)
  running.set(job.id, query)
  const result = await query
  const rows = Array.isArray(result) ? Array.from(result) : []
  reply({
    id: job.id,
    ok: true,
    rows,
    count: result?.count ?? null,
    affectedRows: result?.affectedRows ?? null,
    lastInsertRowid: result?.lastInsertRowid ?? result?.insertId ?? null,
    command: result?.command ?? null,
  })
}

parentPort.on('message', async (job) => {
  if (job.op === 'cancel') {
    // Nobody is waiting for this statement any more. Its reply, if one still
    // comes, carries an id the caller has moved past.
    try { running.get(job.id)?.cancel?.() } catch {}
    return
  }
  try {
    if (job.op === 'close') {
      await watcher?.close?.()
      await sql?.close?.()
      reply({ id: job.id, ok: true })
      return
    }
    if (job.op === 'open')
      return open(job)
    if (job.op === 'end')
      return await end(job)
    if (job.op === 'backend')
      return reply({ id: job.id, ok: true, backend: await backendOfSession(sessionFor(job.session)) })
    if (job.op === 'probe')
      return reply({ id: job.id, ok: true, blocked: await blockedBy(job.waiting, job.holders) })
    if (job.op === 'call') {
      // A pool-level command with no rows to speak of (two-phase commit).
      await sql[job.method](...job.args)
      reply({ id: job.id, ok: true })
      return
    }
    if (job.session) {
      const session = sessionFor(job.session)
      if (job.watch)
        reply({ id: job.id, ok: true, note: 'backend', backend: await backendOfSession(session) })
      return await run(session.connection, job)
    }
    if (!job.watch)
      return await run(sql, job)
    // Watched: on a connection taken for it, so the database's lock tables can
    // be asked about this statement and no other.
    if (inUse >= capacity)
      reply({ id: job.id, ok: true, note: 'queued' })
    const connection = await sql.reserve()
    inUse++
    try {
      reply({ id: job.id, ok: true, note: 'backend', backend: await backendOf(connection) })
      await run(connection, job)
    }
    finally {
      inUse--
      connection.release?.()
    }
  }
  catch (error) {
    reply({ id: job.id, ok: false, error: describe(error) })
  }
  finally {
    running.delete(job.id)
  }
})
`

/** How long a worker may take to open before it is declared broken. A query has no limit here: the driver's own timeouts apply. */
const STARTUP_TIMEOUT_MS = 30_000

/**
 * How long a statement may take before the caller stops waiting for it.
 *
 * The caller's thread does nothing else while it waits, so a statement that
 * can never finish would stop the whole process, silently. A statement held
 * up by this process's own open transaction is found and answered with a
 * promise instead (see the note at the top of this file); what is left is a
 * lock another process holds, or a query that is simply too slow. A limit
 * turns either into an error that says so.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

/**
 * How long a watched statement is waited for in place when the database cannot
 * say what it is waiting on (no access to its lock tables, or a dialect that
 * has none). Past this it answers with a promise, on the assumption that the
 * transaction held open in this process is what it needs.
 */
const UNSEEN_WAIT_MS = 50

/** The first wait for a watched statement before the database is asked about it, and the longest between askings. */
const FIRST_LOOK_MS = 1
const LONGEST_LOOK_MS = 40

/**
 * Thrown when a statement outlives its limit. Postgres cancels the statement.
 * MySQL's protocol has no cancel (it takes a `KILL QUERY` from a second
 * connection), so an abandoned MySQL statement may still complete later.
 */
export class StatementTimeoutError extends Error {
  readonly code = 'ERR_QB_MODEL_STATEMENT_TIMEOUT'
  constructor(readonly timeoutMs: number, readonly sql: string) {
    super(
      `[bun-query-builder] A query did not answer within ${timeoutMs / 1000}s and was abandoned. `
      + 'The calling thread waits for a query, so one that cannot finish would stop the process: usually it needs a '
      + 'lock that another process, or a session left open, is holding. '
      + 'Postgres cancels the abandoned statement; MySQL cannot, so there it may still be applied once it can run. '
      + 'Raise the limit with `models: { timeoutMs }` (0 for none).',
    )
    this.name = 'StatementTimeoutError'
  }
}

function rebuildError(described: NonNullable<WorkerReply['error']>): Error {
  const error = new Error(described.message)
  error.name = described.name
  Object.assign(error, described.fields)
  if (described.stack) {
    // The worker's frames say where the driver failed; this thread's say who asked.
    error.stack = `${described.stack}\n    at <synchronous query>\n${(error.stack ?? '').split('\n').slice(1).join('\n')}`
  }
  return error
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'
}

/** A statement that had to wait for this thread's own code, and whoever is waiting for it. */
interface Later {
  resolve: (reply: WorkerReply) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

/** The worker's end of the channel as this side uses it: read in place, or listened to. */
interface ReplyPort {
  on: (event: 'message', listener: (reply: WorkerReply) => void) => void
  off: (event: 'message', listener: (reply: WorkerReply) => void) => void
  ref?: () => void
  unref?: () => void
}

/**
 * One worker, one connection pool, any number of statements.
 *
 * The caller is blocked for the length of a statement, so in the ordinary
 * case only one is ever being waited for. Each still carries an id: a
 * statement the caller gave up on (see `DEFAULT_STATEMENT_TIMEOUT_MS`) may
 * answer later, and its reply must not be taken for the next one's. A
 * statement that had to wait for this thread's own code is answered through a
 * promise, and its reply is delivered whenever it comes.
 */
export class SyncDriver {
  private readonly worker: Worker
  private readonly takeMessage: typeof receiveMessageOnPort
  private readonly flag: Int32Array
  private readonly port: MessagePort
  private closed = false
  /** The id of the last request sent. */
  private sequence = 0
  /** How many replies this side has taken. The worker's count runs ahead of it while one is waiting. */
  private taken = 0
  /** How many sessions this side has opened: each gets the next name. */
  private sessions = 0
  /**
   * Transactions and reserved connections held open across an `await`, with
   * the database's id for each one's connection (null where it cannot be
   * read). While there are any, statements are watched.
   */
  private readonly held = new Map<string, number | null>()
  /** Statements that had to wait, by request id. */
  private readonly later = new Map<number, Later>()
  private readonly deliver = (reply: WorkerReply): void => {
    this.taken++
    this.settleLater(reply)
  }

  constructor(readonly url: string, readonly options: Record<string, unknown> = {}) {
    // SQLite and ordinary package imports do not need the network worker.
    // Resolve the real host capability only when this driver is requested;
    // an unavailable worker API still throws here, before allocating a channel.
    const { MessageChannel, receiveMessageOnPort, Worker } = requireHostModule('node:worker_threads') as typeof import('node:worker_threads')
    this.takeMessage = receiveMessageOnPort
    const signal = new SharedArrayBuffer(4)
    this.flag = new Int32Array(signal)
    const channel = new MessageChannel()
    this.port = channel.port1 as unknown as MessagePort
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { signal, port: channel.port2, url, options },
      transferList: [channel.port2 as unknown as Transferable],
    } as ConstructorParameters<typeof Worker>[1])
    // The worker must not keep a finished program alive.
    this.worker.unref()
    const opened = this.receive(0, STARTUP_TIMEOUT_MS)
    if (!opened) {
      this.closed = true
      void this.worker.terminate()
      throw new Error(`[bun-query-builder] The database worker did not start within ${STARTUP_TIMEOUT_MS / 1000}s.`)
    }
    if (!opened.ok) {
      this.closed = true
      void this.worker.terminate()
      throw rebuildError(opened.error!)
    }
  }

  /**
   * The next reply nobody else is waiting for, or undefined when `waitMs`
   * passes first (`undefined` waits for as long as it takes). A reply to a
   * statement that had to wait is handed to its promise on the way.
   *
   * The wait is measured by the wait itself, not by reading a clock before and
   * after: a program may have stopped its clock (a test that freezes time
   * does), and a limit measured against a clock that never moves is never
   * reached.
   */
  private next(waitMs: number | undefined): WorkerReply | undefined {
    let remaining = waitMs
    for (;;) {
      const message = this.takeMessage(this.port as unknown as Parameters<typeof receiveMessageOnPort>[0])
      if (message) {
        this.taken++
        const reply = message.message as WorkerReply
        if (this.settleLater(reply))
          continue
        return reply
      }
      if (remaining !== undefined && remaining <= 0)
        return undefined
      // Sleeps only while the worker has announced nothing this side has not
      // taken. A reply announced but not yet readable comes straight back here.
      const before = performance.now()
      const outcome = Atomics.wait(this.flag, 0, this.taken, remaining)
      if (remaining !== undefined)
        remaining = outcome === 'timed-out' ? 0 : remaining - Math.max(0, performance.now() - before)
    }
  }

  /**
   * Wait for the reply to request `id` and take it. Undefined when
   * `timeoutMs` passes first. A reply to an earlier request, one this side
   * had already stopped waiting for, is dropped on the way.
   */
  private receive(id: number, timeoutMs: number): WorkerReply | undefined {
    let remaining = timeoutMs > 0 ? timeoutMs : undefined
    for (;;) {
      const before = performance.now()
      const reply = this.next(remaining)
      if (!reply)
        return undefined
      if (reply.id === id && !reply.note)
        return reply
      // Somebody else's reply: what is left of the limit is what is left.
      if (remaining !== undefined)
        remaining = Math.max(0, remaining - Math.max(0, performance.now() - before))
    }
  }

  /** Hand a reply to the promise of the statement it answers. False when it answers none. */
  private settleLater(reply: WorkerReply): boolean {
    const waiting = this.later.get(reply.id)
    if (!waiting)
      return false
    // Something about the statement, not its answer: nobody is asking any more.
    if (reply.note)
      return true
    this.later.delete(reply.id)
    clearTimeout(waiting.timer)
    if (reply.ok)
      waiting.resolve(reply)
    else
      waiting.reject(rebuildError(reply.error!))
    this.listen()
    return true
  }

  /** Listen for replies while a statement is waiting for one, and only then: a listener keeps the program alive. */
  private listen(): void {
    const port = this.port as unknown as ReplyPort
    if (this.later.size > 0 && !this.closed) {
      port.off('message', this.deliver)
      port.on('message', this.deliver)
      port.ref?.()
    }
    else {
      port.off('message', this.deliver)
      port.unref?.()
    }
  }

  /**
   * The promise of a statement that is already running and has to wait for
   * this thread's own code. `leftMs` is what remains of its limit (undefined
   * for none).
   */
  private defer(id: number, leftMs: number | undefined, timeoutMs: number, describe: string): Promise<WorkerReply> {
    return new Promise<WorkerReply>((resolve, reject) => {
      const waiting: Later = { resolve, reject }
      if (leftMs !== undefined) {
        waiting.timer = setTimeout(() => {
          this.later.delete(id)
          this.worker.postMessage({ op: 'cancel', id })
          reject(new StatementTimeoutError(timeoutMs, describe))
          this.listen()
        }, Math.max(0, leftMs))
      }
      this.later.set(id, waiting)
      this.listen()
    })
  }

  /** Send one request and wait for its reply on this thread, or throw what the driver threw. `timeoutMs` of 0 waits for as long as it takes. */
  private requestInPlace(job: Record<string, unknown>, timeoutMs: number, describe: string): WorkerReply {
    const id = ++this.sequence
    this.worker.postMessage({ ...job, id })
    const reply = this.receive(id, timeoutMs)
    if (!reply) {
      this.worker.postMessage({ op: 'cancel', id })
      throw new StatementTimeoutError(timeoutMs, describe)
    }
    if (!reply.ok)
      throw rebuildError(reply.error!)
    return reply
  }

  /**
   * Send one request while a transaction is held open in this process. It is
   * waited for in place like any other, but watched: the moment the database
   * says its connection is waiting on a held one, or the worker says there is
   * no connection left for it, the wait ends and its promise is returned.
   */
  private requestWatched(job: Record<string, unknown>, timeoutMs: number, describe: string): Answer<WorkerReply> {
    const id = ++this.sequence
    this.worker.postMessage({ ...job, id, watch: true })
    /** How long it has been waited for, counted in waits that ran out (see `next`). */
    let waited = 0
    const left = (): number | undefined => timeoutMs > 0 ? timeoutMs - waited : undefined
    /** The statement's connection: undefined until the worker names it, null where it has no name. */
    let backend: number | null | undefined
    /** The question in flight, if one is. */
    let asking: number | undefined
    let unseen = false
    let look = FIRST_LOOK_MS
    for (;;) {
      const reply = this.next(look)
      if (reply?.id === id) {
        if (reply.note === 'queued')
          return this.defer(id, left(), timeoutMs, describe)
        if (reply.note === 'backend') {
          backend = reply.backend ?? null
          continue
        }
        if (!reply.ok)
          throw rebuildError(reply.error!)
        return reply
      }
      if (reply && reply.id === asking) {
        asking = undefined
        if (reply.blocked === true)
          return this.defer(id, left(), timeoutMs, describe)
        if (reply.blocked === null || reply.blocked === undefined)
          unseen = true
        look = Math.min(look * 2, LONGEST_LOOK_MS)
        continue
      }
      if (reply)
        continue

      waited += look
      if (timeoutMs > 0 && waited >= timeoutMs) {
        this.worker.postMessage({ op: 'cancel', id })
        throw new StatementTimeoutError(timeoutMs, describe)
      }
      if (asking !== undefined)
        continue
      const holders = [...this.held.values()].filter((value): value is number => value !== null)
      // Nothing to ask with, or nobody to ask, or no word yet of a connection
      // for it: wait a little, then take it that the held transaction is why.
      if (backend === undefined || backend === null || unseen || holders.length < this.held.size) {
        if (waited >= UNSEEN_WAIT_MS)
          return this.defer(id, left(), timeoutMs, describe)
        continue
      }
      asking = ++this.sequence
      this.worker.postMessage({ op: 'probe', id: asking, waiting: backend, holders })
    }
  }

  private request(job: Record<string, unknown>, timeoutMs: number, describe: string): Answer<WorkerReply> {
    if (this.closed)
      throw new Error('[bun-query-builder] This database connection was closed.')
    return this.held.size === 0
      ? this.requestInPlace(job, timeoutMs, describe)
      : this.requestWatched(job, timeoutMs, describe)
  }

  private static rows(reply: WorkerReply): SyncQueryResult {
    return Object.assign(reply.rows ?? [], {
      count: reply.count ?? undefined,
      affectedRows: reply.affectedRows ?? undefined,
      lastInsertRowid: reply.lastInsertRowid ?? undefined,
      command: reply.command ?? undefined,
    })
  }

  private static answer<T>(reply: Answer<WorkerReply>, read: (reply: WorkerReply) => T): Answer<T> {
    return isPromise(reply) ? reply.then(read) : read(reply)
  }

  /**
   * Run one statement and return its rows, or throw what the driver threw.
   * Named for the driver method it stands in for. `timeoutMs` of 0 waits for
   * as long as the statement takes.
   */
  unsafe(sql: string, params: readonly unknown[] = [], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    return SyncDriver.answer(this.request({ op: 'query', sql, params, ...options }, timeoutMs, sql), SyncDriver.rows)
  }

  /** Run a statement the caller wrote as a template literal, rebuilt on the connection that runs it. */
  template(template: SyncTemplate, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    return SyncDriver.answer(this.request({ op: 'template', template, ...options }, timeoutMs, template.strings.join('?')), SyncDriver.rows)
  }

  /** Run the statements in a file. */
  file(path: string, params: readonly unknown[] = [], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    return SyncDriver.answer(this.request({ op: 'file', path, params, ...options }, timeoutMs, path), SyncDriver.rows)
  }

  /**
   * Open a transaction, a savepoint inside one, or a reserved connection, and
   * return the name statements use to run on it (`options.session`). It stays
   * open until {@link end}. Waiting here means waiting for a free connection.
   */
  open(spec: { kind: 'begin' | 'savepoint' | 'reserve' | 'distributed', parent?: string, options?: string, name?: string }, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<string> {
    const session = `s${++this.sessions}`
    return SyncDriver.answer(this.request({ op: 'open', session, ...spec }, timeoutMs, `${spec.kind} (waiting for a connection)`), () => session)
  }

  /** Commit or roll back a transaction or savepoint, or release a reserved connection. Throws what COMMIT threw. */
  end(session: string, commit: boolean, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<void> {
    return SyncDriver.answer(this.request({ op: 'end', session, commit }, timeoutMs, commit ? 'COMMIT' : 'ROLLBACK'), () => undefined)
  }

  /** A pool-level command with no rows: `commitDistributed(name)`, `rollbackDistributed(name)`. */
  call(method: 'commitDistributed' | 'rollbackDistributed', args: readonly unknown[], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<void> {
    return SyncDriver.answer(this.request({ op: 'call', method, args }, timeoutMs, method), () => undefined)
  }

  /**
   * Say that a session is being held open across an `await`: its transaction's
   * callback has returned a promise, or it is a reserved connection in the
   * caller's hands. From here until {@link unhold}, statements are watched for
   * waiting on it.
   */
  hold(session: string): void {
    if (this.closed || this.held.has(session))
      return
    let backend: number | null = null
    try {
      // Asked in place: the session's connection is idle, its callback having
      // just returned, or the worker already knows the answer.
      backend = this.requestInPlace({ op: 'backend', session }, 5000, 'connection id').backend ?? null
    }
    catch {}
    this.held.set(session, backend)
  }

  /** The session is no longer held: it has been committed, rolled back or released. */
  unhold(session: string): void {
    this.held.delete(session)
  }

  /** Close the pool and stop the worker. Safe to call twice. */
  close(): void {
    if (this.closed)
      return
    this.closed = true
    try {
      const id = ++this.sequence
      this.worker.postMessage({ op: 'close', id })
      this.receive(id, 5000)
    }
    finally {
      for (const waiting of this.later.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error('[bun-query-builder] This database connection was closed.'))
      }
      this.later.clear()
      this.held.clear()
      this.listen()
      void this.worker.terminate()
    }
  }
}

let current: { key: string, driver: SyncDriver } | null = null

/**
 * The driver for a connection, opened on first use and kept until the
 * connection it describes changes. `key` is the caller's identity for it.
 */
export function syncDriverFor(key: string, target: () => { url: string, options: Record<string, unknown> }): SyncDriver {
  if (current?.key === key)
    return current.driver
  closeSyncDriver()
  const { url, options } = target()
  current = { key, driver: new SyncDriver(url, options) }
  return current.driver
}

/** Close the model layer's synchronous connection, if one is open. */
export function closeSyncDriver(): void {
  const open = current
  current = null
  open?.driver.close()
}
