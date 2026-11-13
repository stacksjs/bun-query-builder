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
 * The worker's source is a string, not a file, so it survives being bundled,
 * minified and compiled into a binary: there is no second file to find at
 * runtime.
 */

import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'

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

interface WorkerReply {
  /** The request this answers. 0 is the worker announcing it has opened. */
  id: number
  ok: boolean
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

parentPort.on('message', async (job) => {
  if (job.op === 'cancel') {
    // Nobody is waiting for this statement any more. Its reply, if one still
    // comes, carries an id the caller has moved past.
    try { running.get(job.id)?.cancel?.() } catch {}
    return
  }
  try {
    if (job.op === 'close') {
      await sql?.close?.()
      reply({ id: job.id, ok: true })
      return
    }
    const query = sql.unsafe(job.sql, job.params)
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
 * can never finish would stop the whole process, silently. The usual way to
 * write one: a model call inside a `db.transaction()` that needs a row the
 * transaction has locked. The transaction's connection lives on the calling
 * thread, the model's on the worker, and the transaction cannot commit while
 * its thread is waiting for the model. A limit turns that into an error that
 * says so.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

/**
 * Thrown when a statement outlives its limit. Postgres cancels the statement.
 * MySQL's protocol has no cancel (it takes a `KILL QUERY` from a second
 * connection), so an abandoned MySQL statement may still complete later.
 */
export class StatementTimeoutError extends Error {
  readonly code = 'ERR_QB_MODEL_STATEMENT_TIMEOUT'
  constructor(readonly timeoutMs: number, readonly sql: string) {
    super(
      `[bun-query-builder] A model query did not answer within ${timeoutMs / 1000}s and was abandoned. `
      + 'A model call waits for its query on the calling thread, so a query that needs a lock held by an open '
      + 'transaction on this same thread can never finish: commit first, or run the statement on the transaction. '
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

/**
 * One worker, one connection pool, any number of statements, one at a time.
 * The caller is blocked for the length of each, so only one is ever being
 * waited for. Each still carries an id: a statement the caller gave up on
 * (see `DEFAULT_STATEMENT_TIMEOUT_MS`) may answer later, and its reply must
 * not be taken for the next one's.
 */
export class SyncDriver {
  private readonly worker: Worker
  private readonly flag: Int32Array
  private readonly port: MessagePort
  private closed = false
  /** The id of the last request sent. */
  private sequence = 0
  /** How many replies this side has taken. The worker's count runs ahead of it while one is waiting. */
  private taken = 0

  constructor(readonly url: string, readonly options: Record<string, unknown> = {}) {
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
   * Wait for the reply to request `id` and take it. Undefined when
   * `timeoutMs` passes first. A reply to an earlier request, one this side
   * had already stopped waiting for, is dropped on the way.
   */
  private receive(id: number, timeoutMs: number): WorkerReply | undefined {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined
    for (;;) {
      const message = receiveMessageOnPort(this.port as unknown as Parameters<typeof receiveMessageOnPort>[0])
      if (message) {
        this.taken++
        const reply = message.message as WorkerReply
        if (reply.id === id)
          return reply
        continue
      }
      const remaining = deadline === undefined ? undefined : deadline - Date.now()
      if (remaining !== undefined && remaining <= 0)
        return undefined
      // Sleeps only while the worker has announced nothing this side has not
      // taken. A reply announced but not yet readable comes straight back here.
      Atomics.wait(this.flag, 0, this.taken, remaining)
    }
  }

  /**
   * Run one statement and return its rows, or throw what the driver threw.
   * Named for the driver method it stands in for. `timeoutMs` of 0 waits for
   * as long as the statement takes.
   */
  unsafe(sql: string, params: readonly unknown[] = [], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): SyncQueryResult {
    if (this.closed)
      throw new Error('[bun-query-builder] This database connection was closed.')
    const id = ++this.sequence
    this.worker.postMessage({ op: 'query', id, sql, params })
    const reply = this.receive(id, timeoutMs)
    if (!reply) {
      this.worker.postMessage({ op: 'cancel', id })
      throw new StatementTimeoutError(timeoutMs, sql)
    }
    if (!reply.ok)
      throw rebuildError(reply.error!)
    return Object.assign(reply.rows ?? [], {
      count: reply.count ?? undefined,
      affectedRows: reply.affectedRows ?? undefined,
      lastInsertRowid: reply.lastInsertRowid ?? undefined,
      command: reply.command ?? undefined,
    })
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
