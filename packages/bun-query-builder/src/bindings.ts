/**
 * How a JavaScript `Date` reaches the database driver.
 *
 * Every `Date` this library binds is sent as `date.toISOString()`: an absolute
 * instant in UTC (`2026-10-13T20:45:42.123Z`), which Postgres reads correctly
 * into `timestamptz`, `timestamp` (the UTC wall-clock time, the same value
 * Bun's prepared path stores) and `date` (the UTC calendar day), and which is
 * what the libSQL driver already sent. An invalid `Date` throws here, naming
 * the parameter, instead of reaching the database as the text "Invalid Date".
 *
 * Why it cannot be left to the driver:
 *
 * - Bun's Postgres driver with `prepare: false` (`pool.preparedStatements:
 *   false`) sends a `Date` as `String(date)`, e.g. `Tue Oct 13 2026 20:45:42
 *   GMT+0000 (Coordinated Universal Time)`. Postgres refuses that for every
 *   temporal type (`invalid input syntax for type timestamp`, or `time zone
 *   "gmt-0700" not recognized` outside UTC).
 * - With prepared statements on, a `Date` bound to a `date` parameter, or
 *   inside an array (`= ANY($1)`), fails the same way.
 * - `bun:sqlite` binds a `Date` as NULL, silently.
 *
 * MySQL-family connections are left alone: their `DATETIME` literal cannot
 * carry the `T`/`Z` of an ISO string (see `temporalLiteral` in client.ts).
 */

/** One bound value, with any `Date` (also inside arrays) serialized. */
export function bindingValue(value: unknown, position?: number): unknown {
  if (value instanceof Date)
    return dateBinding(value, position)
  if (Array.isArray(value) && value.some(needsSerializing))
    return value.map(item => bindingValue(item, position))
  return value
}

/**
 * A parameter list with every `Date` serialized.
 *
 * Returns the SAME array when nothing needs changing, so the common case
 * (no dates) allocates nothing and callers that compare or reuse the array
 * see no difference.
 */
export function serializeBindings<T extends readonly unknown[] | undefined | null>(params: T): T {
  if (!params || !params.some(needsSerializing))
    return params
  return params.map((value, index) => bindingValue(value, index + 1)) as unknown as T
}

/**
 * Wrap a Bun SQL Postgres connection so every statement it runs binds `Date`
 * parameters as ISO strings, whatever path built the statement.
 *
 * Covers `unsafe(sql, params)`, tagged templates (`sql\`... ${date}\``), the
 * helper (`sql({ at: date })`, `sql([row, row])`, an IN list `sql([date, date])`),
 * `array()`, `file()`, and the
 * connections it hands out: `begin`/`transaction`/`savepoint`/
 * `beginDistributed`/`distributed` callbacks and `reserve()`. Anything that is
 * not a Bun Postgres connection (SQLite wrapper, MySQL, a test double) is
 * returned unchanged, and wrapping twice is a no-op.
 */
export function withDateBindings<T>(connection: T): T {
  if (!isPostgresConnection(connection) || wrapped.has(connection as object))
    return connection
  // One wrapper per connection: builders created over the same connection must
  // see the same object, or the query cache (keyed on connection identity)
  // treats them as different connections and never hits.
  const existing = wrappers.get(connection as object)
  if (existing)
    return existing as T
  const target = connection as unknown as DriverFunction
  const proxy = new Proxy(target, {
    apply(fn, _thisArg, args: unknown[]) {
      return Reflect.apply(fn, target, serializeCallArgs(args))
    },
    get(fn, prop) {
      const value = Reflect.get(fn, prop, fn)
      if (typeof value !== 'function')
        return value
      switch (prop) {
        case 'unsafe':
        case 'file':
          return (text: unknown, params?: unknown[], ...rest: unknown[]) => value.call(fn, text, serializeBindings(params), ...rest)
        case 'array':
          return (values: unknown, ...rest: unknown[]) => value.call(fn, bindingValue(values), ...rest)
        case 'begin':
        case 'transaction':
        case 'savepoint':
        case 'beginDistributed':
        case 'distributed':
          return (...args: unknown[]) => value.apply(fn, args.map(arg => typeof arg === 'function'
            ? (conn: unknown, ...more: unknown[]) => (arg as (...a: unknown[]) => unknown)(withDateBindings(conn), ...more)
            : arg))
        case 'reserve':
          return async (...args: unknown[]) => withDateBindings(await value.apply(fn, args))
        default:
          return value.bind(fn)
      }
    },
  })
  wrapped.add(proxy)
  wrappers.set(connection as object, proxy)
  return proxy as unknown as T
}

const wrapped = new WeakSet<object>()
const wrappers = new WeakMap<object, object>()

/** A Bun SQL connection: callable (tagged template, helper) with methods. */
type DriverFunction = Function & Record<PropertyKey, any>

function needsSerializing(value: unknown): boolean {
  return value instanceof Date || (Array.isArray(value) && value.some(needsSerializing))
}

function dateBinding(value: Date, position?: number): string {
  if (Number.isNaN(value.getTime())) {
    const where = position ? ` (parameter ${position})` : ''
    throw new RangeError(`[query-builder] Cannot bind an invalid Date${where}: it would reach the database as the text "Invalid Date". Check the value before writing it.`)
  }
  return value.toISOString()
}

function isPostgresConnection(connection: unknown): boolean {
  return typeof connection === 'function' && (connection as { options?: { adapter?: unknown } }).options?.adapter === 'postgres'
}

/** A plain object or null-prototype record, i.e. a row for the `sql(row)` helper. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object')
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function serializeRecord(row: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null
  for (const key of Object.keys(row)) {
    if (needsSerializing(row[key])) {
      copy ??= { ...row }
      copy[key] = bindingValue(row[key])
    }
  }
  return copy ?? row
}

/**
 * Arguments of a call to the connection itself: a tagged template
 * (`strings, ...values`) or the helper (`sql(row | rows | identifiers, ...columns)`).
 */
function serializeCallArgs(args: unknown[]): unknown[] {
  const [first] = args
  if (Array.isArray(first) && 'raw' in first)
    return args.some((arg, index) => index > 0 && needsSerializing(arg))
      ? [first, ...args.slice(1).map((arg, index) => bindingValue(arg, index + 1))]
      : args
  if (isRecord(first))
    return [serializeRecord(first), ...args.slice(1)]
  // `sql(rows)` for a multi-row insert, `sql(values)` for an IN list.
  if (Array.isArray(first) && first.some(item => isRecord(item) || needsSerializing(item)))
    return [first.map(item => isRecord(item) ? serializeRecord(item) : bindingValue(item)), ...args.slice(1)]
  return args
}
