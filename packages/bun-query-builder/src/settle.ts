/**
 * Code that is synchronous when everything it touches is.
 *
 * A model method runs a query, and may run hooks. On `bun:sqlite`, and on the
 * network dialects through sync-driver.ts, the query answers where it is
 * called, so the method can return a plain value: `const user =
 * User.where(...).first()` is the row. But a hook may be an async function, a
 * caller may have supplied a connection that answers with promises, and
 * `models.execution: 'async'` asks for promises on purpose. The same method
 * then has to wait.
 *
 * Writing every method twice is how the two would drift apart. So each is
 * written once, as a generator that yields whatever it needs the value of:
 *
 * ```ts
 * get(): Row[] {
 *   return settle(function* () {
 *     const rows = yield* wait(exec.all(sql, params))
 *     return rows.map(hydrate)
 *   })
 * }
 * ```
 *
 * `settle` runs it. While every yielded value is plain it runs straight
 * through and returns the result. At the first promise it switches to waiting
 * and returns a promise of the result, exactly as an `async` function would.
 * A method therefore never returns a promise that it did not need.
 */

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The value of `value`, inside a `settle` body: itself, or what it resolves
 * to. Stands where `await` would.
 */
export function* wait<T>(value: T): Generator<unknown, Awaited<T>, unknown> {
  return (yield value) as Awaited<T>
}

async function settleLater<R>(body: Generator<unknown, R, unknown>, pending: PromiseLike<unknown>): Promise<R> {
  let next: unknown = pending
  for (;;) {
    let input: unknown
    let failure: { error: unknown } | undefined
    try {
      input = await next
    }
    catch (error) {
      failure = { error }
    }
    // A rejection is thrown into the body where it was waiting, so a
    // try/catch around the `yield*` sees it. Uncaught, it rejects this.
    const step = failure ? body.throw(failure.error) : body.next(input)
    if (step.done)
      return step.value
    next = step.value
  }
}

/**
 * Run a body to its result. Returns the result when nothing it yielded was a
 * promise, and a promise of the result otherwise.
 *
 * Typed as the plain result: that is what the configured, synchronous path
 * returns, and `await` accepts either.
 */
export function settle<R>(body: () => Generator<unknown, R, unknown>): R {
  const running = body()
  let step = running.next()
  while (!step.done) {
    if (isThenable(step.value))
      return settleLater(running, step.value) as unknown as R
    step = running.next(step.value)
  }
  return step.value
}

/**
 * Every value in a list, in order: the list itself when none is a promise,
 * `Promise.all` of it otherwise. For work that was started together and may
 * be waited for together.
 */
export function waitAll<T>(values: T[]): Awaited<T>[] | Promise<Awaited<T>[]> {
  return values.some(isThenable) ? Promise.all(values) : values as Awaited<T>[]
}

/**
 * Whether a query object answers in place by this library's contract: it has
 * an `executeSync()` and is not itself a promise.
 *
 * The connections this library makes (the `bun:sqlite` wrapper, the
 * synchronous network connection) hand out plain objects. A driver's own
 * query is a promise: Bun's `Query` extends `Promise`. Where the runtime gives
 * that one an `executeSync()` of its own (stacksjs/bun), it is a different
 * thing and is not taken for this one: nothing watches it for a transaction
 * held open in this process, it has no limit, and it is what a caller holds
 * exactly when it asked for promises (`models.execution: 'async'`, a
 * connection it supplied). Such a query is awaited, as it always was.
 */
export function answersHere(query: unknown): boolean {
  return query !== null
    && typeof query === 'object'
    && typeof (query as { executeSync?: unknown }).executeSync === 'function'
    && !(query instanceof Promise)
}

/**
 * Marks a function that stands in for an `async` callback: a wrapper a library
 * puts around the caller's own. {@link declaredAsync} then says of the wrapper
 * what it would say of the callback.
 */
export const ASYNC_CALLBACK: unique symbol = Symbol.for('bun-query-builder.asyncCallback')

/**
 * Whether a callback was written `async` (or wraps one that was): known before
 * it is called, which is when a transaction has to know that it will be held
 * open across an `await`.
 */
export function declaredAsync(fn: unknown): boolean {
  if (typeof fn !== 'function')
    return false
  return (fn as { [ASYNC_CALLBACK]?: unknown })[ASYNC_CALLBACK] === true || fn.constructor?.name === 'AsyncFunction'
}

/** `wrapper`, marked as standing in for `callback` (see {@link ASYNC_CALLBACK}). */
export function standingFor<T extends Function>(wrapper: T, callback: unknown): T {
  if (declaredAsync(callback))
    Object.defineProperty(wrapper, ASYNC_CALLBACK, { value: true, configurable: true })
  return wrapper
}

