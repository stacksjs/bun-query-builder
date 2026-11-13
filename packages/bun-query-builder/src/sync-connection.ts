/**
 * A MySQL or Postgres connection that answers where it is asked.
 *
 * The query builder talks to its database through one object: Bun's `SQL`
 * (`sql.unsafe(text, params)`, `` sql`...` ``, `sql.begin(fn)`), or the
 * `bun:sqlite` wrapper that stands in for it. This is the same surface over
 * the worker-held connection in sync-driver.ts, so `db.selectFrom(...).get()`
 * is the rows on a network database exactly as it is on SQLite, and
 * `db.transaction(tx => ...)` is done when it returns.
 *
 * A statement is a query object, as with the driver: nothing runs until it is
 * asked for. `executeSync()` runs it and returns the rows; awaiting it does the
 * same and resolves to them, so code written for the driver's promises keeps
 * working.
 *
 * A transaction is a real one, on one connection. The worker opens it with the
 * driver's own `begin()` and holds it open; every statement issued through the
 * connection the callback receives runs on it, and it commits when the
 * callback returns, or rolls back when it throws. A callback that is `async`
 * is waited for, and the transaction is then a promise.
 */

import type { AwaitableDriverQuery, DriverConnection } from './db'
import type { StatementOptions, SyncDatabase, SyncTemplate } from './sync-driver'
import { bindingValue, serializeBindings, serializeCallArgs } from './bindings'
import { config } from './config'
import { connectionSignature, hasInjectedSqlInstance, networkConnectionTarget, resolveLibSQLTarget } from './db'
import { declaredAsync, isThenable, settle, wait } from './settle'
import { DEFAULT_STATEMENT_TIMEOUT_MS } from './sync-driver'
import { closeSyncDriver, syncDriverFor } from './sync-transport'

/** What a statement is made of, kept on its query object so it can be nested in another or run. */
const STATEMENT = Symbol('bun-query-builder.statement')

interface Statement {
  sql?: string
  params?: readonly unknown[]
  template?: SyncTemplate
  file?: string
}

/** A call to the driver's helper, rebuilt on the worker: `sql('name')`, `sql({ ... })`, `sql([ ... ])`. */
interface HelperCall {
  __qb: 'helper' | 'array'
  args: unknown[]
}

interface Scope {
  /** The driver statements go to. A transaction keeps the one it began on. */
  driver: () => SyncDatabase
  /** The transaction, savepoint or reserved connection every statement runs on. */
  session?: string
  /**
   * A transaction's statements that had to wait and have not answered yet. It
   * is not done until they are (see `within`).
   */
  waiting?: Set<PromiseLike<unknown>>
}

/**
 * Whether the configured database is one this connection is for: a network
 * dialect, not asked to answer with promises (`models.execution: 'async'`),
 * with no connection the caller supplied (that one lives on the calling
 * thread and answers later) and no libSQL server (its transport is `fetch`).
 */
export function answersInPlace(): boolean {
  return config.dialect !== 'sqlite'
    && config.models?.execution !== 'async'
    && !hasInjectedSqlInstance()
    && !resolveLibSQLTarget()
}

/**
 * A statement written as a template literal on this connection. Like the
 * driver's own query object it has no SQL text of its own to read: the text is
 * made on the worker, by the driver, from the literal's parts. So it cannot be
 * spliced into a builder's statement as a fragment either.
 */
export function isTemplateStatement(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { [STATEMENT]?: Statement })[STATEMENT]?.template !== undefined
}

function statementTimeout(): number {
  return config.models?.timeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
}

/** Postgres takes a Date as ISO text (bindings.ts); MySQL keeps its native Date binding. */
function bound(value: unknown, position?: number): unknown {
  return config.dialect === 'postgres' ? bindingValue(value, position) : value
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw)
}

function isHelperCall(value: unknown): value is HelperCall {
  const kind = (value as HelperCall | null)?.__qb
  return kind === 'helper' || kind === 'array'
}

function createConnection(scope: Scope): DriverConnection {
  /** A value inside a template: a nested statement, a helper call, or something to bind. */
  const fragment = (value: unknown, position: number): unknown => {
    if (value !== null && typeof value === 'object') {
      const statement = (value as { [STATEMENT]?: Statement })[STATEMENT]
      if (statement?.template)
        return statement.template
      // The driver takes a statement given as text inside a template too.
      if (statement?.sql !== undefined)
        return { __qb: 'unsafe', sql: statement.sql, params: statement.params ?? [] }
      if (statement)
        throw new TypeError('[bun-query-builder] A statement read from a file cannot be placed inside another.')
      if (isHelperCall(value))
        return value
    }
    return bound(value, position)
  }

  const query = (statement: Statement, options: StatementOptions = {}): AwaitableDriverQuery => {
    /**
     * The rows, where the statement answers in place. A promise of them in the
     * one case it cannot: it needs something a transaction still open in this
     * process is holding (sync-driver.ts). `limitMs` is this statement's own
     * limit, where the caller set one (`.timeout(ms)`).
     */
    const run = (limitMs?: number): unknown => {
      const driver = scope.driver()
      const where: StatementOptions = scope.session ? { ...options, session: scope.session } : options
      const limit = typeof limitMs === 'number' && limitMs > 0 ? limitMs : statementTimeout()
      const answer = statement.template
        ? driver.template(statement.template, limit, where)
        : statement.file
          ? driver.file(statement.file, statement.params ?? [], limit, where)
          : driver.unsafe(statement.sql!, statement.params ?? [], limit, where)
      const waiting = scope.waiting
      if (waiting && isThenable(answer)) {
        waiting.add(answer)
        const settled = (): void => { waiting.delete(answer) }
        answer.then(settled, settled)
      }
      return answer
    }
    // Asked for more than once, a statement still runs once, as a promise does.
    let pending: Promise<unknown> | undefined
    const execute = (): Promise<unknown> => pending ??= new Promise(resolve => resolve(run()))
    const text = statement.sql ?? statement.file ?? statement.template!.strings.join('?')
    return {
      [STATEMENT]: statement,
      executeSync: run,
      execute,
      then: (onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) => execute().then(onFulfilled, onRejected),
      catch: (onRejected?: ((reason: unknown) => unknown) | null) => execute().catch(onRejected),
      finally: (onFinally?: (() => void) | null) => execute().finally(onFinally),
      values: () => query(statement, { ...options, mode: 'values' }),
      raw: () => query(statement, { ...options, mode: 'raw' }),
      simple: () => query(statement, { ...options, simple: true }),
      // The wait for a statement is over when it has answered, so there is
      // never one in flight to cancel from here: a statement that outlives its
      // limit is cancelled by the driver (StatementTimeoutError).
      cancel: () => {},
      toString: () => text,
      // Only a statement given as text has text to report (see computeSqlText in client.ts).
      ...(statement.sql === undefined ? {} : { sql: statement.sql, parameters: statement.params }),
    } as unknown as AwaitableDriverQuery
  }

  const call = (first: unknown, ...rest: unknown[]): unknown => {
    if (isTemplateStrings(first)) {
      return query({
        template: {
          __qb: 'template',
          strings: [...first],
          raw: [...first.raw],
          values: rest.map((value, index) => fragment(value, index + 1)),
        },
      })
    }
    const args = config.dialect === 'postgres' ? serializeCallArgs([first, ...rest]) : [first, ...rest]
    return { __qb: 'helper', args } satisfies HelperCall
  }

  /** A transaction, a savepoint or a prepared (two-phase) transaction around `fn`. */
  const within = (kind: 'begin' | 'savepoint' | 'distributed') => (...args: unknown[]): unknown => {
    const fn = args.find(arg => typeof arg === 'function') as ((tx: DriverConnection) => unknown) | undefined
    if (!fn)
      throw new TypeError(`[bun-query-builder] ${kind === 'savepoint' ? 'savepoint' : 'begin'}(): a callback is required`)
    const label = args.find(arg => typeof arg === 'string') as string | undefined
    return settle(function* (): Generator<unknown, unknown, unknown> {
      const driver = scope.driver()
      // A callback written `async` will keep the transaction open across an
      // `await`, and says so before it is called: its first statement is
      // already one whose author awaits it (sync-driver.ts).
      const willHold = declaredAsync(fn)
      const session = (yield* wait(driver.open({
        kind,
        parent: scope.session,
        held: willHold,
        ...(kind === 'distributed' ? { name: label } : label ? { options: label } : {}),
      }, statementTimeout()))) as string
      const waiting = new Set<PromiseLike<unknown>>()
      let held = false
      try {
        let result: unknown
        try {
          if (willHold) {
            driver.hold(session)
            held = true
          }
          const answer = fn(createConnection({ driver: () => driver, session, waiting }))
          // Not written `async`, but it has to wait all the same: from here
          // on the transaction is open while other code runs.
          if (!held && isThenable(answer)) {
            driver.hold(session)
            held = true
          }
          result = yield* wait(answer)
          // The driver's pipelined form: a callback may return its statements.
          if (Array.isArray(result))
            result = yield* wait(Promise.all(result))
          // A statement that had to wait and that the callback did not wait
          // for is still part of the transaction: it is not committed around,
          // and its failure is the transaction's.
          if (waiting.size > 0) {
            const outcomes = (yield* wait(Promise.allSettled([...waiting]))) as PromiseSettledResult<unknown>[]
            const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
            if (failed)
              throw failed.reason
          }
        }
        catch (error) {
          // The failure the caller needs is the one that got it here, not one
          // from rolling back a transaction the database has already abandoned.
          try {
            yield* wait(driver.end(session, false, statementTimeout()))
          }
          catch {}
          throw error
        }
        yield* wait(driver.end(session, true, statementTimeout()))
        return result
      }
      finally {
        if (held)
          driver.unhold(session)
      }
    })
  }

  const connection = Object.assign(call, {
    unsafe: (sql: string, params?: unknown[]) => query({ sql, params: config.dialect === 'postgres' ? serializeBindings(params) : params }),
    file: (path: string, params?: unknown[]) => query({ file: path, params: config.dialect === 'postgres' ? serializeBindings(params) : params }),
    array: (...args: unknown[]) => ({ __qb: 'array', args: [bound(args[0]), ...args.slice(1)] } satisfies HelperCall),
    begin: within('begin'),
    transaction: within('begin'),
    savepoint: within('savepoint'),
    beginDistributed: within('distributed'),
    distributed: within('distributed'),
    commitDistributed: (name: string) => scope.driver().call('commitDistributed', [name], statementTimeout()),
    rollbackDistributed: (name: string) => scope.driver().call('rollbackDistributed', [name], statementTimeout()),
    /**
     * One connection of the pool, in the caller's hands until `release()`. What
     * the caller does with it in between is not known here, so it counts as
     * held open for as long as it is out (sync-driver.ts).
     */
    reserve: () => settle(function* (): Generator<unknown, unknown, unknown> {
      const driver = scope.driver()
      const session = (yield* wait(driver.open({ kind: 'reserve' }, statementTimeout()))) as string
      driver.hold(session)
      return Object.assign(createConnection({ driver: () => driver, session }), {
        release: () => {
          driver.unhold(session)
          return driver.end(session, true, statementTimeout())
        },
      })
    }),
    /** Close the pool. The next statement opens a new one. */
    close: () => closeSyncDriver(),
    /** Says what this is, to code that has to tell it from the driver's own connection. */
    answersInPlace: true as const,
  })
  return connection as unknown as DriverConnection
}

let shared: DriverConnection | undefined

/**
 * The connection for the configured database. One object for the life of the
 * process: it looks its driver up for each statement, so a connection that is
 * reset or reconfigured is followed, and builders that share it share a query
 * cache.
 */
export function syncConnection(): DriverConnection {
  return shared ??= createConnection({ driver: () => syncDriverFor(connectionSignature(), networkConnectionTarget) })
}
