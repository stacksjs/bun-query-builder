/**
 * Compile-time verification of `QueryBuilderOptions` — the type consumers
 * annotate their configuration with.
 *
 * This file is NOT executed; it's checked by `bun --bun tsc --noEmit`. Lines
 * marked @ts-expect-error MUST fail to compile, every other line MUST compile.
 * (`test/` is excluded from the typecheck, so config type coverage has to live
 * here under `src/` to be enforced at all.)
 *
 * The point of the file is stacksjs/bun-query-builder#1062: adding a field to
 * the resolved `QueryBuilderConfig` was a compile error in every downstream
 * app, because the resolved type was also the only one exported for consumers
 * to declare against. Section 1 is the regression pin — a config naming ONE
 * key must compile, at any depth. Sections 2-4 pin the parts a naive
 * `DeepPartial` silently breaks; section 5 pins that being optional did not
 * cost us any real type safety.
 */

import type { QueryBuilderConfig, QueryBuilderOptions } from '../types'
import { defineConfig, setConfig } from '../config'

// ---------------------------------------------------------------------------
// 1. Nothing is required, at any depth
// ---------------------------------------------------------------------------

// The empty config: the library supplies everything.
export const empty: QueryBuilderOptions = {}

// One top-level key. `migrationDir` is the field whose arrival broke #1062.
export const oneKey: QueryBuilderOptions = { dialect: 'sqlite' }
export const migrationOnly: QueryBuilderOptions = { migrationDir: 'db/migrations' }

// One leaf of a REQUIRED nested section. Plain `Partial` stops here: it would
// demand a complete `TimestampConfig`/`TransactionDefaultsConfig`.
export const oneLeaf: QueryBuilderOptions = { timestamps: { createdAt: 'inserted_at' } }
export const oneRetry: QueryBuilderOptions = { transactionDefaults: { retries: 5 } }

// One leaf of an OPTIONAL nested section. These four are the sharpest pin in
// the file: a naive `{ [K in keyof T]?: T[K] extends object ? … : T[K] }`
// leaves optional members unpartialized — `T[K]` is `X | undefined`, which is
// not a naked type parameter and so does not distribute, fails `extends object`
// and passes through whole — and every one of these still errors.
export const softOnly: QueryBuilderOptions = { softDeletes: { enabled: true } }
export const emptyVitess: QueryBuilderOptions = { vitess: {} }
export const emptyDebug: QueryBuilderOptions = { debug: {} }
export const browserLeaf: QueryBuilderOptions = { browser: { timeout: 1000 } }

// Two levels down.
export const deepLeaf: QueryBuilderOptions = { transactionDefaults: { backoff: { jitter: false } } }
export const poolLeaf: QueryBuilderOptions = { database: { pool: { max: 20 } } }

// The call sites take it too.
setConfig({ pagination: { defaultPerPage: 50 } })
export const defined = defineConfig({ dialect: 'postgres', database: { database: 'my_app' } })

// ---------------------------------------------------------------------------
// 2. Functions stay callable
// ---------------------------------------------------------------------------

// A mapped type only copies PROPERTIES, and a call signature is not one.
// Without the function guard clause `keyof (() => void)` is `never`, these
// hooks collapse to an empty object type, and the calls below stop compiling.
export const hooked: QueryBuilderOptions = {
  hooks: {
    onQueryStart: (event) => { void event.sql },
    onQueryEnd: (event) => { void event.durationMs },
  },
}
hooked.hooks?.onQueryStart?.({ sql: 'select 1' })

// Generic signatures survive too — `transformResponse` is `<T>(r: any) => T`,
// and a mapped type would erase the type parameter along with the signature.
type TransformResponse = NonNullable<NonNullable<QueryBuilderOptions['browser']>['transformResponse']>
export const transform: TransformResponse = (response: any) => response
export const transformed: number[] = transform<number[]>({})

// ---------------------------------------------------------------------------
// 3. Arrays stay arrays
// ---------------------------------------------------------------------------

// Recursing into `string[]` yields `(string | undefined)[]`, which no longer
// assigns back out to an array of `string` — so the read-backs are the pin.
// Arrays are replaced wholesale by the merge, so a partial array was never
// meaningful.
export const states: QueryBuilderOptions = { transactionDefaults: { sqlStates: ['40001'] } }
export const statesOut: readonly string[] = states.transactionDefaults!.sqlStates!
export const pragmas: QueryBuilderOptions = { sqlite: { pragmas: ['PRAGMA foreign_keys = ON'] } }
export const pragmasOut: readonly string[] = pragmas.sqlite!.pragmas!

// Array leaves are `readonly`, so the idiomatic `as const` config file assigns.
// A mutable `string[]` still assigns too — `readonly E[]` is the wider type.
export const asConst: QueryBuilderOptions = {
  dialect: 'sqlite',
  transactionDefaults: { sqlStates: ['40001', '40P01'] },
} as const

const sharedStates: readonly string[] = ['40001']
export const hoisted: QueryBuilderOptions = { transactionDefaults: { sqlStates: sharedStates } }

const mutableStates: string[] = ['40001']
export const fromMutable: QueryBuilderOptions = { transactionDefaults: { sqlStates: mutableStates } }

// ---------------------------------------------------------------------------
// 4. Record bags stay intact
// ---------------------------------------------------------------------------

const headers: Record<string, string> = { authorization: 'Bearer x' }
export const withHeaders: QueryBuilderOptions = { browser: { baseUrl: '/api', headers } }
// The read-back is the pin, exactly as for arrays: recursing into the bag would
// rewrite it as `{ [x: string]: string | undefined }`, which does not assign
// back out to `Record<string, string>`. Assigning INTO the bag is safe either
// way, so testing only that direction would leave the guard unpinned.
export const headersOut: Record<string, string> = withHeaders.browser!.headers!

// ---------------------------------------------------------------------------
// 5. Optional is not the same as unchecked
// ---------------------------------------------------------------------------

// @ts-expect-error - 'oracle' is not a SupportedDialect
export const badDialect: QueryBuilderOptions = { dialect: 'oracle' }

// @ts-expect-error - createdAt is a column name, not a number
export const badLeafType: QueryBuilderOptions = { timestamps: { createdAt: 42 } }

// @ts-expect-error - typo in a nested key is still an excess property
export const typo: QueryBuilderOptions = { timestamps: { craetedAt: 'created_at' } }

// @ts-expect-error - defaultPerPage is a number
export const badPagination: QueryBuilderOptions = { pagination: { defaultPerPage: 'lots' } }

// @ts-expect-error - foreignKeyFormat is a closed union
export const badRelations: QueryBuilderOptions = { relations: { foreignKeyFormat: 'nope' } }

// @ts-expect-error - a hook must be callable, not a number
export const badHook: QueryBuilderOptions = { hooks: { onQueryStart: 42 } }

// @ts-expect-error - headers values are strings
export const badHeaders: QueryBuilderOptions = { browser: { headers: { a: 1 } } }

// ---------------------------------------------------------------------------
// 6. The options type is a strict WIDENING of what setConfig used to take
// ---------------------------------------------------------------------------

// Every caller who was passing a `QueryBuilderConfig` or a
// `Partial<QueryBuilderConfig>` keeps compiling — that is what makes widening
// `setConfig()` a non-breaking change.
export const fromResolved: QueryBuilderOptions = {} as QueryBuilderConfig
export const fromPartial: QueryBuilderOptions = {} as Partial<QueryBuilderConfig>

// ...and not the reverse, which is what preserves the internal guarantee that
// every field of the resolved config is present.
// @ts-expect-error - QueryBuilderOptions cannot stand in for the resolved config
export const backToResolved: QueryBuilderConfig = {} as QueryBuilderOptions
