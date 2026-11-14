/**
 * Types for the calls stacksjs/bun adds to Bun's MySQL and Postgres drivers.
 *
 * These calls exist only on that build of Bun (https://github.com/stacksjs/bun,
 * `stacksjs.com/bun` in pantry). `bun-types` describes official Bun and does
 * not know them, so a program that runs on the other build and calls them
 * directly says so once, in any file of the project:
 *
 * ```ts
 * /// <reference types="bun-query-builder/bun-sync" />
 * ```
 *
 * or with `"types": ["bun-query-builder/bun-sync"]` in `tsconfig.json`. It is
 * opt-in because on official Bun the methods are `undefined` whatever the
 * types say: code that has to run on both asks first, as this library does
 * (`typeof query.wait === 'function'`).
 *
 * Nothing here is needed to use bun-query-builder or Stacks models, which
 * pick the runtime's calls themselves.
 */

declare module 'bun' {
  interface SQL {
    /**
     * `reserve()`, where it is called: blocks this thread until a connection
     * is the caller's, without the event loop turning.
     *
     * `undefined` when none can be had that way: every connection is busy
     * with something only the event loop can finish, such as a caller that
     * awaits. `await sql.reserve()` then waits for one.
     *
     * Only on stacksjs/bun. MySQL and PostgreSQL; throws on SQLite, which
     * has no reserved connections.
     *
     * @param ms How long to wait for a connection, in milliseconds. Without
     * it, as long as it takes.
     *
     * @example
     * ```ts
     * const connection = sql.reserveSync() ?? await sql.reserve()
     * try {
     *   connection.unsafe('BEGIN').executeSync()
     *   connection`update accounts set balance = balance - ${10} where id = ${1}`.executeSync()
     *   connection.unsafe('COMMIT').executeSync()
     * }
     * finally {
     *   connection.release()
     * }
     * ```
     */
    reserveSync(ms?: number): ReservedSQL | undefined
  }

  namespace SQL {
    interface Query<T> {
      /**
       * Starts the query and blocks this thread until it has settled, or for
       * `ms` milliseconds.
       *
       * The event loop does not turn meanwhile. The thread waits on the
       * socket of the connection the query is on, and nothing else of the
       * program runs: no other socket, no timer, no microtask.
       *
       * - `true`: the query has settled. `executeSync()` has its outcome.
       * - `false`: `ms` passed. The query is still running and can be waited
       *   for again, awaited or cancelled.
       * - `null`: there is nothing for this thread to wait on, so only the
       *   event loop can settle the query (every connection is held by a
       *   caller that awaits, say). Waiting longer here would not help;
       *   `await` it.
       *
       * A query that failed has settled too: `wait()` is `true` and does not
       * throw. `executeSync()` throws what it failed with.
       *
       * Only on stacksjs/bun.
       *
       * @param ms How long to wait, in milliseconds. Without it, until the
       * query settles.
       */
      wait(ms?: number): boolean | null

      /**
       * The result of the query, where it is called: what `await` would
       * give, or a throw of what the query rejected with.
       *
       * It is `wait(ms)` and then the outcome. When the query has not
       * settled after `ms` milliseconds, or cannot be waited for on this
       * thread (see {@link wait}), it throws `ERR_POSTGRES_SYNC_TIMEOUT` or
       * `ERR_MYSQL_SYNC_TIMEOUT`. The query keeps running then, and can
       * still be awaited or cancelled.
       *
       * Only on stacksjs/bun.
       *
       * @param ms How long to wait, in milliseconds. Without it, until the
       * query settles.
       *
       * @example
       * ```ts
       * const [user] = sql`select * from users where id = ${id}`.executeSync()
       * const rows = sql.unsafe('select * from orders where user_id = $1', [id]).executeSync(5000)
       * ```
       */
      executeSync(ms?: number): Awaited<Query<T>>

      /**
       * `cancel()`, for a caller that does not yield: it then blocks until
       * the request to stop the statement has reached the server, or for
       * `ms` milliseconds.
       *
       * On PostgreSQL that request travels on a connection of its own. Left
       * to the event loop it goes out after whatever the caller does next,
       * which can be the very thing the statement was waiting for: the
       * statement then runs although it was cancelled. MySQL has no such
       * request, so a statement the server has received runs to its end.
       *
       * Only on stacksjs/bun.
       *
       * @param ms How long to wait for the request to be sent, in
       * milliseconds.
       */
      cancelSync(ms?: number): Query<T>
    }
  }
}

export {}
