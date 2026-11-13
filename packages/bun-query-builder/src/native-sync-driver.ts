/**
 * A network database, queried synchronously, on the calling thread.
 *
 * sync-driver.ts gets a value out of Bun's MySQL and Postgres drivers by
 * keeping the connection on a worker thread and blocking the caller until the
 * worker has the rows. That costs a second thread and a copy of every row
 * between the two. It is what stock Bun allows: its drivers only answer
 * through the event loop.
 *
 * A Bun that carries the synchronous calls ([stacksjs/bun](https://github.com/stacksjs/bun):
 * `query.wait(ms)`, `query.executeSync(ms)`, `sql.reserveSync(ms)`) can wait
 * for a statement where it is issued. The thread blocks on the socket of the
 * one connection that has the answer, the event loop does not turn, and the
 * rows are the driver's own. This is the same driver as the worker's, with
 * the same rules, over those calls. Which one a program gets is decided when
 * the connection is opened (`openSyncDriver`): this one where the runtime has
 * the calls, the worker everywhere else.
 *
 * The rule about a transaction held open across an `await` is the one told at
 * the top of sync-driver.ts, and it is applied here the same way: while one is
 * held, a statement is watched, and it answers with a promise only when the
 * database says it is waiting on a held connection (or, inside a held
 * transaction, on any lock), or when no connection is left for it.
 *
 * A transaction is opened and ended here with its statements (`BEGIN`,
 * `COMMIT`, `SAVEPOINT`, ...) on a reserved connection. The driver's own
 * `begin()` cannot be used for it: it is an `async` function, and what it
 * awaits only moves when the event loop turns.
 */

import type { Answer, StatementOptions, SyncDatabase, SyncQueryResult, SyncTemplate } from './sync-driver'
import { SQL } from 'bun'
import { DEFAULT_STATEMENT_TIMEOUT_MS, FIRST_LOOK_MS, lockAnswer, lockQuestion, LONGEST_LOOK_MS, StatementTimeoutError, UNSEEN_WAIT_MS } from './sync-driver'

/** A statement of the driver, with the calls this file is for. */
interface NativeQuery extends PromiseLike<unknown> {
  /** true: settled. false: `ms` passed. null: only the event loop can settle it. */
  wait: (ms?: number) => boolean | null
  executeSync: (ms?: number) => unknown
  cancel: () => unknown
  cancelSync?: (ms?: number) => unknown
  simple: () => NativeQuery
  values: () => NativeQuery
  raw: () => NativeQuery
}

/** How long giving up on a statement may take: the time for the request to stop it to reach the server. */
const CANCEL_WAIT_MS = 2000

/** What a statement can be issued on: the pool, or one reserved connection. */
interface NativeTarget {
  (strings: TemplateStringsArray | unknown, ...values: unknown[]): unknown
  unsafe: (sql: string, params?: readonly unknown[]) => NativeQuery
  file: (path: string, params?: readonly unknown[]) => NativeQuery
  array: (...args: unknown[]) => unknown
}

interface NativeReserved extends NativeTarget {
  release: () => unknown
}

interface NativePool extends NativeTarget {
  reserveSync: (ms?: number) => NativeReserved | undefined
  reserve: () => Promise<NativeReserved>
  close: (options?: { timeout?: number }) => Promise<void>
}

/** A transaction, a savepoint or a reserved connection that is open. */
interface Session {
  kind: 'begin' | 'savepoint' | 'reserve' | 'distributed'
  connection: NativeReserved
  /** The session it is inside: a savepoint's transaction, a transaction's reserved connection. */
  parent?: Session
  /** It took its connection from the pool, and gives it back when it ends. */
  owns: boolean
  /** The statements that end it. */
  commit: string[]
  rollback: string[]
  /** The database's id for its connection. Undefined until asked, null where it cannot be read. */
  backend?: number | null
}

/** How a watched statement is asked about. */
interface Watch {
  /** The database's id for the connection the statement is on. */
  backend: number | null
  /** It was issued inside a held transaction, by code that awaits it. */
  awaited: boolean
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'
}

/** `next` on the value, where it is, or when it is. */
function then<T, R>(answer: Answer<T>, next: (value: T) => Answer<R>): Answer<R> {
  return isPromise(answer) ? answer.then(next) : next(answer)
}

/** `after` once `run` is over, however it ended, in place or later. */
function ensure<T>(run: () => Answer<T>, after: () => void): Answer<T> {
  let answer: Answer<T>
  try {
    answer = run()
  }
  catch (error) {
    after()
    throw error
  }
  if (isPromise(answer))
    return answer.finally(after)
  after()
  return answer
}

/** A name that goes between single quotes, as the driver checks it. */
function distributedName(name: unknown): string {
  if (typeof name !== 'string')
    throw new Error('Distributed transaction name must be a string.')
  if (name.includes('\''))
    throw new Error('Distributed transaction name cannot contain single quotes.')
  return name
}

/**
 * Whether this runtime's driver has the synchronous calls. Nothing is sent to
 * find out: a statement is only built.
 */
export function hasNativeSync(sql: unknown): sql is NativePool {
  if (typeof sql !== 'function')
    return false
  const pool = sql as unknown as Partial<NativePool>
  if (typeof pool.reserveSync !== 'function' || typeof pool.unsafe !== 'function')
    return false
  const probe = pool.unsafe('select 1') as Partial<NativeQuery>
  return typeof probe.wait === 'function' && typeof probe.executeSync === 'function'
}

export class NativeSyncDriver implements SyncDatabase {
  private closed = false
  private readonly dialect: 'postgres' | 'mysql' | null
  /** How many sessions this side has opened: each gets the next name. */
  private opened = 0
  private savepoints = 0
  private readonly sessions = new Map<string, Session>()
  /** Sessions held open across an `await`, with the database's id for each one's connection. */
  private readonly held = new Map<string, number | null>()
  /** A session's name, by the session it is inside. */
  private readonly inside = new Map<string, string>()
  /** The lock tables are read on a connection of their own, so the question can be asked while every pooled one is busy or held. */
  private watcher: NativePool | undefined
  private cannotSay = false

  constructor(readonly url: string, readonly options: Record<string, unknown>, private readonly sql: NativePool) {
    this.dialect = /^postgres/i.test(url) ? 'postgres' : /^(?:mysql|mariadb)/i.test(url) ? 'mysql' : null
  }

  /** The driver for `url`, or undefined where this runtime's driver has no synchronous calls. */
  static open(url: string, options: Record<string, unknown> = {}): NativeSyncDriver | undefined {
    const sql: unknown = new SQL(url, options)
    if (hasNativeSync(sql))
      return new NativeSyncDriver(url, options, sql)
    // Nothing was dialed: a pool connects when it is first asked for a connection.
    void (sql as { close?: (options?: { timeout?: number }) => Promise<void> }).close?.({ timeout: 0 })?.catch?.(() => {})
    return undefined
  }

  // ── statements ──────────────────────────────────────────────────────────

  /**
   * A template literal the caller built (sync-connection.ts hands it over as
   * data, the way it crosses to the worker), rebuilt on the connection that
   * will run it. Identifiers and row helpers are the driver's own.
   */
  private revive(target: NativeTarget, value: unknown): unknown {
    if (value === null || typeof value !== 'object')
      return value
    const marked = value as { __qb?: string, args?: unknown[], sql?: string, params?: unknown[] }
    if (marked.__qb === 'template')
      return this.build(target, value as SyncTemplate)
    if (marked.__qb === 'helper')
      return target(...(marked.args as [unknown, ...unknown[]]).map(arg => this.revive(target, arg)) as [unknown, ...unknown[]])
    if (marked.__qb === 'array')
      return target.array(...marked.args!)
    if (marked.__qb === 'unsafe')
      return target.unsafe(marked.sql!, marked.params)
    return value
  }

  private build(target: NativeTarget, template: SyncTemplate): NativeQuery {
    // What the driver takes for a template literal's strings: frozen, with a
    // frozen raw list that is not enumerable.
    const strings = template.strings.slice()
    Object.defineProperty(strings, 'raw', { value: Object.freeze(template.raw.slice()) })
    return target(Object.freeze(strings), ...template.values.map(value => this.revive(target, value))) as NativeQuery
  }

  private bindings(target: NativeTarget, params: readonly unknown[]): readonly unknown[] {
    const marked = (value: unknown): boolean => value !== null && typeof value === 'object' && typeof (value as { __qb?: unknown }).__qb === 'string'
    return params.some(marked) ? params.map(value => this.revive(target, value)) : params
  }

  private shaped(query: NativeQuery, options: StatementOptions): NativeQuery {
    if (options.simple)
      query = query.simple()
    if (options.mode === 'values')
      query = query.values()
    else if (options.mode === 'raw')
      query = query.raw()
    return query
  }

  /** The rows as the worker's driver gives them: the driver's own array, with an insert id under the one name. */
  private static rows(result: unknown): SyncQueryResult {
    const rows = (Array.isArray(result) ? result : []) as SyncQueryResult & { insertId?: number | bigint }
    if (rows.lastInsertRowid === undefined && rows.insertId !== undefined)
      rows.lastInsertRowid = rows.insertId
    return rows
  }

  /**
   * The promise of a statement that is already running and has to wait for
   * this thread's own code. `leftMs` is what remains of its limit.
   */
  private later(query: NativeQuery, leftMs: number | undefined, timeoutMs: number, describe: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (leftMs !== undefined) {
        timer = setTimeout(() => {
          try {
            query.cancel()
          }
          catch {}
          reject(new StatementTimeoutError(timeoutMs, describe))
        }, Math.max(0, leftMs))
      }
      query.then((value) => {
        clearTimeout(timer)
        resolve(value)
      }, (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /**
   * Give up on a statement that outlived its limit. Postgres takes the
   * request to stop it on a connection of its own, which nothing drives while
   * this thread does not yield: `cancelSync()` sees it to the server before
   * the caller goes on, to what may be the very thing the statement waited
   * for. MySQL has no such request.
   */
  private abandon(query: NativeQuery, timeoutMs: number, describe: string): never {
    try {
      if (typeof query.cancelSync === 'function')
        query.cancelSync(CANCEL_WAIT_MS)
      else
        query.cancel()
    }
    catch {}
    throw new StatementTimeoutError(timeoutMs, describe)
  }

  /**
   * Wait for a statement that has been built: in place, or watched while a
   * session is held open in this process.
   */
  private settle(query: NativeQuery, timeoutMs: number, describe: string, watch: Watch | undefined): Answer<unknown> {
    const limit = timeoutMs > 0 ? timeoutMs : undefined
    if (!watch) {
      const started = performance.now()
      const outcome = query.wait(limit)
      if (outcome)
        return query.executeSync()
      // Out of time, or nothing this thread can wait on: a connection that
      // only code waiting for this thread can give back.
      if (outcome === false)
        this.abandon(query, timeoutMs, describe)
      return this.later(query, limit === undefined ? undefined : limit - (performance.now() - started), timeoutMs, describe)
    }

    /** How long it has been waited for, counted in waits that ran out. */
    let waited = 0
    const left = (): number | undefined => limit === undefined ? undefined : limit - waited
    let unseen = false
    let look = FIRST_LOOK_MS
    for (;;) {
      const outcome = query.wait(look)
      if (outcome)
        return query.executeSync()
      if (outcome === null)
        return this.later(query, left(), timeoutMs, describe)
      waited += look
      if (limit !== undefined && waited >= limit)
        this.abandon(query, timeoutMs, describe)

      const holders = [...this.held.values()].filter((value): value is number => value !== null)
      // Nothing to ask with, or nobody to ask: wait a little, then take it
      // that the held transaction is why.
      if (watch.backend === null || unseen || holders.length < this.held.size) {
        if (waited >= UNSEEN_WAIT_MS)
          return this.later(query, left(), timeoutMs, describe)
        continue
      }
      const state = this.lockState(watch.backend, holders)
      if (state === undefined) {
        unseen = true
        continue
      }
      if (state.blocked || (watch.awaited && state.waiting))
        return this.later(query, left(), timeoutMs, describe)
      look = Math.min(look * 2, LONGEST_LOOK_MS)
    }
  }

  /** Undefined where the database cannot say. */
  private lockState(waiting: number, holders: readonly number[]): { waiting: boolean, blocked: boolean } | undefined {
    if (this.cannotSay || !this.dialect)
      return undefined
    try {
      this.watcher ??= new SQL(this.url, { ...this.options, max: 1 }) as unknown as NativePool
      const rows = this.watcher.unsafe(lockQuestion(this.dialect, waiting, holders)).executeSync(5000) as Record<string, unknown>[]
      return lockAnswer(rows[0])
    }
    catch {
      // No such table, or no right to read it: this database cannot say.
      this.cannotSay = true
      return undefined
    }
  }

  /** The database's own id for a connection: what its lock tables name. Null where it cannot be read. */
  private backendOf(connection: NativeTarget): number | null {
    if (!this.dialect)
      return null
    try {
      const rows = connection.unsafe(this.dialect === 'postgres' ? 'SELECT pg_backend_pid() AS backend' : 'SELECT CONNECTION_ID() AS backend').executeSync(5000) as Record<string, unknown>[]
      return Number(rows[0]?.backend) || null
    }
    catch {
      return null
    }
  }

  /** A savepoint runs on its transaction's connection: same id. */
  private backendOfSession(session: Session): number | null {
    if (session.backend === undefined)
      session.backend = session.parent ? this.backendOfSession(session.parent) : this.backendOf(session.connection)
    return session.backend
  }

  private sessionFor(name: string): Session {
    const session = this.sessions.get(name)
    if (!session)
      throw new Error('[bun-query-builder] This transaction is over: it was committed or rolled back before the statement ran.')
    return session
  }

  /** Whether a session, or one it is inside, is held open across an `await`. */
  private isHeld(session: string | undefined): boolean {
    for (let at = session; at !== undefined; at = this.inside.get(at)) {
      if (this.held.has(at))
        return true
    }
    return false
  }

  /** Run one statement where it belongs: on its session's connection, or on any of the pool's. */
  private run(make: (target: NativeTarget) => NativeQuery, timeoutMs: number, describe: string, options: StatementOptions): Answer<SyncQueryResult> {
    if (this.closed)
      throw new Error('[bun-query-builder] This database connection was closed.')
    const limit = timeoutMs > 0 ? timeoutMs : undefined
    if (options.session) {
      const session = this.sessionFor(options.session)
      const watch = this.held.size === 0
        ? undefined
        : { backend: this.backendOfSession(session), awaited: this.isHeld(options.session) }
      return then(this.settle(this.shaped(make(session.connection), options), timeoutMs, describe, watch), NativeSyncDriver.rows)
    }
    if (this.held.size === 0)
      return then(this.settle(this.shaped(make(this.sql), options), timeoutMs, describe, undefined), NativeSyncDriver.rows)

    // Watched: on a connection taken for it, so the database's lock tables can
    // be asked about this statement and no other.
    const connection = this.sql.reserveSync(limit)
    if (!connection) {
      // Every connection is held. It runs when one comes back, which takes
      // code that is waiting for this thread.
      return this.later(this.shaped(make(this.sql), options), limit, timeoutMs, describe).then(NativeSyncDriver.rows)
    }
    return ensure(
      () => then(this.settle(this.shaped(make(connection), options), timeoutMs, describe, { backend: this.backendOf(connection), awaited: false }), NativeSyncDriver.rows),
      () => { void connection.release() },
    )
  }

  unsafe(sql: string, params: readonly unknown[] = [], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    return this.run(target => target.unsafe(sql, this.bindings(target, params)), timeoutMs, sql, options)
  }

  template(template: SyncTemplate, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    return this.run(target => this.build(target, template), timeoutMs, template.strings.join('?'), options)
  }

  file(path: string, params: readonly unknown[] = [], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS, options: StatementOptions = {}): Answer<SyncQueryResult> {
    // The driver reads the file through the event loop: this one is a promise.
    return this.run(target => target.file(path, this.bindings(target, params)), timeoutMs, path, options)
  }

  // ── sessions ────────────────────────────────────────────────────────────

  /** One of a session's own statements (BEGIN, COMMIT, SAVEPOINT, ...), on its connection. */
  private command(session: Session, name: string | undefined, text: string, timeoutMs: number): Answer<SyncQueryResult> {
    const watch = this.held.size === 0
      ? undefined
      : { backend: this.backendOfSession(session), awaited: this.isHeld(name) }
    return then(this.settle(session.connection.unsafe(text).simple(), timeoutMs, text, watch), NativeSyncDriver.rows)
  }

  /** The statements that begin and end a transaction, as the driver's own `begin()` words them. */
  private transaction(spec: { kind: 'begin' | 'distributed', options?: string, name?: string }): { begin: string, commit: string[], rollback: string[] } {
    if (spec.kind === 'distributed') {
      const name = distributedName(spec.name)
      return this.dialect === 'mysql'
        ? { begin: `XA START '${name}'`, commit: [`XA END '${name}'`, `XA PREPARE '${name}'`], rollback: [`XA END '${name}'`, `XA ROLLBACK '${name}'`] }
        : { begin: 'BEGIN', commit: [`PREPARE TRANSACTION '${name}'`], rollback: ['ROLLBACK'] }
    }
    // They become a part of the statement, so nothing that could end it or start another.
    if (spec.options && !/^[A-Z ,]*$/i.test(spec.options))
      throw new Error('Transaction options can only contain letters, spaces, and commas.')
    const begin = this.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN'
    return { begin: spec.options ? `${begin} ${spec.options}` : begin, commit: ['COMMIT'], rollback: ['ROLLBACK'] }
  }

  /** A connection of the pool for the caller alone. A promise of one when every connection is held. */
  private take(timeoutMs: number): Answer<NativeReserved> {
    return this.sql.reserveSync(timeoutMs > 0 ? timeoutMs : undefined) ?? this.sql.reserve()
  }

  open(spec: {
    kind: 'begin' | 'savepoint' | 'reserve' | 'distributed'
    parent?: string
    options?: string
    name?: string
    held?: boolean
  }, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<string> {
    if (this.closed)
      throw new Error('[bun-query-builder] This database connection was closed.')
    const name = `s${++this.opened}`
    const above = spec.parent ? this.sessionFor(spec.parent) : undefined
    const register = (session: Session): string => {
      this.sessions.set(name, session)
      if (spec.parent)
        this.inside.set(name, spec.parent)
      return name
    }

    if (spec.kind === 'reserve') {
      // Another connection of the pool, whatever it is asked on.
      return then(this.take(timeoutMs), connection => register({ kind: 'reserve', connection, owns: true, commit: [], rollback: [] }))
    }

    if (spec.kind === 'savepoint') {
      if (!above)
        throw new Error('[bun-query-builder] A savepoint needs a transaction to be inside of.')
      // The form of the driver's own names: a counter, then what the caller called it.
      const label = spec.options ? `_${spec.options.replace(/\W/g, '_')}` : ''
      const id = `qb${++this.savepoints}${label}`
      const session: Session = {
        kind: 'savepoint',
        connection: above.connection,
        parent: above,
        owns: false,
        commit: [`RELEASE SAVEPOINT ${id}`],
        rollback: [`ROLLBACK TO SAVEPOINT ${id}`],
      }
      return then(this.command(session, spec.parent, `SAVEPOINT ${id}`, timeoutMs), () => register(session))
    }

    const commands = this.transaction({ kind: spec.kind, options: spec.options, name: spec.name })
    const begin = (connection: NativeReserved): Answer<string> => {
      const session: Session = { kind: spec.kind, connection, parent: above, owns: !above, commit: commands.commit, rollback: commands.rollback }
      // Asked ahead of BEGIN while it can matter. Asked inside, it would be the
      // transaction's first statement, and Postgres takes SET TRANSACTION
      // ISOLATION LEVEL only as the first.
      if (session.owns && (spec.held || this.held.size > 0))
        session.backend = this.backendOf(connection)
      let begun: Answer<SyncQueryResult>
      try {
        begun = this.command(session, spec.parent, commands.begin, timeoutMs)
      }
      catch (error) {
        if (session.owns)
          void connection.release()
        throw error
      }
      if (isPromise(begun)) {
        return begun.then(() => register(session), (error) => {
          if (session.owns)
            void connection.release()
          throw error
        })
      }
      return register(session)
    }
    return then(above ? above.connection : this.take(timeoutMs), begin)
  }

  end(name: string, commit: boolean, timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<void> {
    const session = this.sessions.get(name)
    if (!session)
      return
    this.sessions.delete(name)
    const release = (): void => {
      this.inside.delete(name)
      if (session.owns)
        void session.connection.release()
    }
    if (session.kind === 'reserve')
      return release()

    const texts = commit ? session.commit : session.rollback
    const answered = (result: SyncQueryResult, last: boolean): void => {
      // Postgres answers the COMMIT of a transaction that had already failed with ROLLBACK.
      if (last && commit && session.kind === 'begin' && result.command === 'ROLLBACK') {
        throw Object.assign(new Error('COMMIT was rolled back by the server because the transaction was already aborted'), {
          code: 'ERR_POSTGRES_COMMIT_ROLLED_BACK',
        })
      }
    }
    const step = (index: number): Answer<void> => {
      if (index >= texts.length)
        return
      return then(this.command(session, name, texts[index], timeoutMs), (result) => {
        answered(result, index === texts.length - 1)
        return step(index + 1)
      })
    }
    return ensure(() => step(0), release)
  }

  call(method: 'commitDistributed' | 'rollbackDistributed', args: readonly unknown[], timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS): Answer<void> {
    const name = distributedName(args[0])
    const commit = method === 'commitDistributed'
    const text = this.dialect === 'mysql'
      ? `${commit ? 'XA COMMIT' : 'XA ROLLBACK'} '${name}'`
      : `${commit ? 'COMMIT PREPARED' : 'ROLLBACK PREPARED'} '${name}'`
    return then(this.run(target => target.unsafe(text), timeoutMs, text, { simple: true }), () => undefined)
  }

  hold(name: string): void {
    if (this.closed || this.held.has(name))
      return
    const session = this.sessions.get(name)
    this.held.set(name, session ? this.backendOfSession(session) : null)
  }

  unhold(name: string): void {
    this.held.delete(name)
  }

  close(): void {
    if (this.closed)
      return
    this.closed = true
    this.sessions.clear()
    this.held.clear()
    this.inside.clear()
    // What is still running is the caller's to drop: the pool closes now.
    for (const pool of [this.watcher, this.sql])
      void pool?.close({ timeout: 0 }).catch(() => {})
  }
}
