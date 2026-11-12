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
const reply = (message) => {
  port.postMessage(message)
  Atomics.store(flag, 0, 1)
  Atomics.notify(flag, 0)
}
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
  reply({ ok: true })
}
catch (error) {
  reply({ ok: false, error: describe(error) })
}

parentPort.on('message', async (job) => {
  try {
    if (job.op === 'close') {
      await sql?.close?.()
      reply({ ok: true })
      return
    }
    const result = await sql.unsafe(job.sql, job.params)
    const rows = Array.isArray(result) ? Array.from(result) : []
    reply({
      ok: true,
      rows,
      count: result?.count ?? null,
      affectedRows: result?.affectedRows ?? null,
      lastInsertRowid: result?.lastInsertRowid ?? result?.insertId ?? null,
      command: result?.command ?? null,
    })
  }
  catch (error) {
    reply({ ok: false, error: describe(error) })
  }
})
`

/** How long a worker may take to open before it is declared broken. A query has no limit here: the driver's own timeouts apply. */
const STARTUP_TIMEOUT_MS = 30_000

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
 * The caller is blocked for the length of each, so there is never a second
 * statement to keep apart from the first.
 */
export class SyncDriver {
  private readonly worker: Worker
  private readonly flag: Int32Array
  private readonly port: MessagePort
  private closed = false

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
    const opened = this.receive(STARTUP_TIMEOUT_MS)
    if (!opened.ok) {
      this.closed = true
      void this.worker.terminate()
      throw rebuildError(opened.error!)
    }
  }

  /** Wait for the worker's next reply and take it. */
  private receive(timeoutMs?: number): WorkerReply {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
    for (;;) {
      const waited = Atomics.wait(this.flag, 0, 0, deadline === undefined ? undefined : Math.max(0, deadline - Date.now()))
      const message = receiveMessageOnPort(this.port as unknown as Parameters<typeof receiveMessageOnPort>[0])
      if (message) {
        Atomics.store(this.flag, 0, 0)
        return message.message as WorkerReply
      }
      if (waited === 'timed-out')
        return { ok: false, error: { name: 'Error', message: `[bun-query-builder] The database worker did not start within ${STARTUP_TIMEOUT_MS / 1000}s.`, fields: {} } }
      // Woken with nothing to read: the notification outran the message. Wait again.
    }
  }

  /** Run one statement and return its rows, or throw what the driver threw. Named for the driver method it stands in for. */
  unsafe(sql: string, params: readonly unknown[] = []): SyncQueryResult {
    if (this.closed)
      throw new Error('[bun-query-builder] This database connection was closed.')
    Atomics.store(this.flag, 0, 0)
    this.worker.postMessage({ op: 'query', sql, params })
    const reply = this.receive()
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
      Atomics.store(this.flag, 0, 0)
      this.worker.postMessage({ op: 'close' })
      this.receive(5000)
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
