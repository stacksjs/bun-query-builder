/**
 * Dynamic ORM for bun-query-builder
 *
 * Creates fully-featured model classes from Stacks-style model definitions
 * without any code generation. Provides precise TypeScript inference.
 *
 * @example
 * ```ts
 * import { createModel } from 'bun-query-builder'
 *
 * const User = createModel({
 *   name: 'User',
 *   table: 'users',
 *   attributes: {
 *     name: { type: 'string', fillable: true },
 *     email: { type: 'string', fillable: true, unique: true },
 *     age: { type: 'number', fillable: true },
 *     status: { type: ['active', 'inactive'] as const, fillable: true },
 *   }
 * } as const)
 *
 * const user = User.find(1)
 * user?.get('status') // type: 'active' | 'inactive'
 * ```
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type { FactoryFaker } from './faker-compat'
import type { PaginateOptions } from './client'
import type { SupportedDialect } from './types'
import type { InferRelationNames, RelationCardinality } from './type-inference'
export type { InferRelationNames } from './type-inference'
import { isNumericPlanType, normalizeAttributeType, sqliteAffinityFor } from './column-types'
import { config, isMysqlLike } from './config'
import { serializeBindings } from './bindings'
import { connectionSignature, getOrCreateBunSql, hasInjectedSqlInstance, networkConnectionTarget, resolveLibSQLTarget } from './db'
import { settle, wait, waitAll } from './settle'
import { DEFAULT_STATEMENT_TIMEOUT_MS } from './sync-driver'
import { closeSyncDriver, syncDriverFor } from './sync-transport'
import { applySqliteBootstrapPragmas } from './sqlite-pragmas'
import { createFakerCompatLayer } from './faker-compat'
import { normalizeRelationEntry, normalizeRelationList } from './relation-utils'
import { singularizerFor, toTableName as sharedToTableName } from './inflect'
import type { WhereTerm } from './sql-fragments'
import { countPlaceholders, quoteIdentifierForDialect, renderInPredicate, renderWhereTerms, toDialectPlaceholders } from './sql-fragments'

/**
 * Current timestamp formatted for the active dialect.
 *
 * Postgres and SQLite both accept the full ISO-8601 string
 * (`2026-06-01T12:54:58.720Z`). MySQL's `DATETIME` does NOT — it rejects
 * the `T` separator, the `Z` zone suffix, and sub-second precision beyond
 * the column definition, raising `Incorrect datetime value`. So for MySQL
 * we emit the canonical `YYYY-MM-DD HH:MM:SS` form it accepts. Used for all
 * auto-managed `created_at` / `updated_at` / `deleted_at` writes.
 */
function formatNow(): string {
  const iso = new Date().toISOString()
  return isMysqlLike(config.dialect) ? iso.slice(0, 19).replace('T', ' ') : iso
}

/**
 * Strict identifier pattern for SQL column / table names: starts with
 * a letter or underscore, then letters / digits / underscores only.
 * No quotes, no dots, no spaces, no special characters.
 *
 * Used by `assertValidIdentifier` to validate user-supplied column
 * names at the entry points where ORM methods accept them (increment,
 * decrement, pluck, aggregate, orderBy via raw forms, …). The
 * compile-time `keyof TAttributes` constraint catches the common case
 * where the column name comes from a literal; this regex is the
 * runtime backstop for `as any` casts and code that builds column
 * names from request input. stacksjs/stacks#1858 (Q-2, Q-9, Q-10).
 */
const SAFE_SQL_IDENTIFIER = /^[A-Z_][A-Z0-9_]*$/i

function assertValidIdentifier(name: unknown, context: string): asserts name is string {
  if (typeof name !== 'string' || name.length === 0)
    throw new TypeError(`[bun-query-builder] ${context}: identifier must be a non-empty string, got ${typeof name}`)
  if (name.length > 64)
    throw new TypeError(`[bun-query-builder] ${context}: identifier '${name}' exceeds 64 chars`)
  if (!SAFE_SQL_IDENTIFIER.test(name))
    throw new TypeError(`[bun-query-builder] ${context}: identifier '${name}' contains characters outside [A-Za-z0-9_] — refusing to interpolate into SQL`)
}

/**
 * Comparison operators a caller may put in the `op` slot of a relation
 * filter. `wherePivot(column, op, value)` interpolates that slot raw, so
 * without this an operator is a second SQL hole through the same call. Same
 * set as the builder's own `SAFE_WHERE_OPERATORS` in `client.ts`, duplicated
 * rather than imported because `orm.ts` depends on `client.ts` for types
 * only and a value import would make that a runtime dependency.
 */
const SAFE_COMPARISON_OPERATORS = new Set([
  '=', '!=', '<>', '<', '<=', '>', '>=',
  'like', 'not like', 'ilike', 'not ilike',
  'in', 'not in', 'is', 'is not', 'between', 'not between',
])

function assertValidComparisonOperator(op: unknown, context: string): string {
  if (typeof op !== 'string')
    throw new TypeError(`[bun-query-builder] ${context}: operator must be a string, got ${typeof op}`)
  if (!SAFE_COMPARISON_OPERATORS.has(op.toLowerCase().trim()))
    throw new TypeError(`[bun-query-builder] ${context}: refusing to use '${op}' as a SQL operator — not in the allowed set (${[...SAFE_COMPARISON_OPERATORS].join(', ')})`)
  return op
}

/**
 * Render a LIKE-family predicate for the configured dialect.
 *
 * The two builders disagreed about case on PostgreSQL: the query builder's
 * `whereLike` renders `LOWER(col) LIKE LOWER(?)` and is case-insensitive by
 * default, while the model builder pushed a plain `like`, which PostgreSQL
 * treats case-sensitively. SQLite and MySQL hid it, because their `LIKE`
 * ignores case anyway, so a search box built on a model silently stopped
 * matching when the app moved to PostgreSQL — `donald` did not find `Donald`
 * (stacksjs/stacks#3202). See stacksjs/bun-query-builder#1206.
 *
 * The model builder now matches the query builder: case-insensitive unless the
 * caller opts out with `caseSensitive`. The generic `where(col, 'like', v)`
 * form is untouched and stays case-sensitive, exactly as it is on the query
 * builder — only the dedicated `whereLike` family carries the default.
 */
function renderLikePredicate(column: string, operator: WhereOperator, caseInsensitive: boolean): string {
  const negated = operator === 'not like' || operator === 'not ilike'
  const native = operator === 'ilike' || operator === 'not ilike'

  // Postgres has a real ILIKE; everywhere else the lowered comparison is it.
  if (native && config.dialect === 'postgres')
    return `${column} ${negated ? 'NOT ILIKE' : 'ILIKE'} ?`
  if (native || caseInsensitive)
    return `LOWER(${column}) ${negated ? 'NOT LIKE' : 'LIKE'} LOWER(?)`
  return `${column} ${negated ? 'NOT LIKE' : 'LIKE'} ?`
}

/**
 * Validate an ORDER BY target column. Like `assertValidIdentifier` but
 * additionally accepts the table-qualified `table.column` form by
 * validating each side of a single dot with the same strict rule. Any
 * other shape (multiple dots, quotes, spaces, `;`, sub-selects, …) is
 * rejected before it can be interpolated into the ORDER BY clause.
 *
 * The column name is interpolated RAW into SQL at the build sites, so a
 * malformed/malicious identifier here is a SQL-injection /
 * column-enumeration vector. stacksjs/stacks#1858.
 */
function assertValidOrderByColumn(name: unknown, context: string): asserts name is string {
  if (typeof name !== 'string' || name.length === 0)
    throw new TypeError(`[bun-query-builder] ${context}: identifier must be a non-empty string, got ${typeof name}`)
  const parts = name.split('.')
  if (parts.length > 2 || parts.some(p => p.length === 0 || p.length > 64 || !SAFE_SQL_IDENTIFIER.test(p)))
    throw new TypeError(`[bun-query-builder] ${context}: invalid ORDER BY column '${name}' — expected 'column' or 'table.column' of [A-Za-z0-9_] — refusing to interpolate into SQL`)
}

/**
 * Resolve the bindings handed to `ModelQueryBuilder.whereRaw`/`orWhereRaw`.
 *
 * Both spellings are accepted: separate arguments, `whereRaw(sql, a, b)`, and
 * one array, `whereRaw(sql, [a, b])` — the Laravel/Knex form the docs taught.
 * The array form used to be stored as a single binding, `[[a, b]]`. bun:sqlite
 * took that as the whole bindings list only when it was the only value of a
 * read, threw once any other clause bound a value, and threw on every write
 * because `run()` does not spread. Bun.sql comma-joined it for a text parameter,
 * so one value passed and two failed with `insufficient data left in message`.
 * See stacksjs/bun-query-builder#1146.
 *
 * The array is copied, so mutating it after the call does not change the query.
 *
 * On Postgres the lone array used to reach Bun.sql whole, so the parameter's
 * type decided how it was sent, and some calls depended on that. Each element
 * is now bound exactly as if it had been passed separately:
 *
 *  - an array meant as ONE json/jsonb value is wrapped,
 *    `whereRaw('tags @> ?', [['bun']])`; unwrapped, `['bun']` now binds the
 *    string `'bun'` where it used to bind the JSON array `["bun"]`. Arrays inside
 *    the bindings are passed through untouched for this reason;
 *  - a number, bigint or boolean compared with text needs a cast or a string,
 *    `whereRaw("meta->>'id' = ?", [String(id)])`, where the whole array used to
 *    arrive as text;
 *  - `[null]` and `[undefined]` bind NULL, where they used to bind `''`.
 *
 * A lone `undefined` with no `?` in the fragment is no bindings: it is what a
 * wrapper such as `(sql, bindings?) => q.whereRaw(sql, bindings)` forwards, and
 * binding it would add a value no placeholder takes. With a `?` it stays a NULL
 * binding, as before.
 */
function resolveRawBindings(fragment: string, params: unknown[]): unknown[] {
  if (params.length !== 1)
    return params
  const only = params[0]
  if (Array.isArray(only))
    return [...only]
  if (only === undefined && countPlaceholders(fragment) === 0)
    return []
  return params
}

// Lazy reference to model registry to avoid circular dependency
// eslint-disable-next-line pickier/no-unused-vars
let _getModel: ((name: string) => any) | null = null

/**
 * Models built by `createModel`, keyed by definition name.
 *
 * `defineModel` publishes into model.ts's global registry; `createModel` never
 * did. So every lookup below missed a `createModel` model, and each caller fell
 * back to its own guess:
 *
 *  - relation resolution guessed the table from the MODEL NAME, ignoring a
 *    declared `table`. Where no table existed at the guessed name that was a
 *    "no such table" crash; where one did — a plausible accident, since the
 *    guess is the conventional name — the relation silently read the WRONG
 *    TABLE and returned wrong rows.
 *  - eager-load hydration fell back to the PARENT's definition, so the related
 *    rows were shaped by the wrong model. An attribute marked `hidden: true` on
 *    the related model was serialized into a `with()` payload even though a
 *    direct query on that same model redacts it.
 *
 * See stacksjs/bun-query-builder#1093.
 *
 * Kept module-local rather than written into the public registry so that
 * `getAllModels()` / `getModelRegistry()` / `hasModel()` keep reporting exactly
 * what `defineModel` put there, and so two models sharing a name cannot clobber
 * each other's public entry.
 */
const localModels = new Map<string, any>()

function registerLocalModel(name: string, model: any): void {
  localModels.set(name, model)
  // Relation resolution is memoized per model+relation pair. A resolution
  // computed before this model was registered guessed its table, so the memo
  // has to go or registration order silently decides the answer.
  relationCache.clear()
}

/** Drops the `createModel` models. Paired with `clearModelRegistry()`. */
export function clearLocalModels(): void {
  localModels.clear()
  relationCache.clear()
}

function getModelFromRegistry(name: string): any {
  if (!_getModel) {
    try {
      _getModel = require('./model').getModel
    }
    catch {
      _getModel = () => undefined
    }
  }
  // The public registry wins, so a `defineModel` facade still shadows the plain
  // model it wraps.
  return _getModel!(name) ?? localModels.get(name)
}

// Binding helper type for SQL queries
type Bindings = SQLQueryBindings[]

// Primitive type mappings
type PrimitiveTypeMap = {
  string: string
  number: number
  boolean: boolean
  date: Date
  json: Record<string, unknown>
}

// Infer the actual TS type from attribute type definition
type InferType<T> =
  T extends keyof PrimitiveTypeMap ? PrimitiveTypeMap[T] :
  T extends readonly (infer U)[] ? U :
  T extends (infer U)[] ? U :
  T extends { getShape: () => infer TShape extends Readonly<Record<string, unknown>> }
    ? { -readonly [TKey in keyof TShape]: InferType<TShape[TKey]> }
    : T extends { test: (value: infer U) => unknown } ? U :
      T extends { validate: (value: infer U) => unknown } ? U :
        unknown

// Attribute definition with explicit type
export interface TypedAttribute<T = unknown> {
  type?: T
  order?: number
  fillable?: boolean
  unique?: boolean
  hidden?: boolean
  guarded?: boolean
  nullable?: boolean
  /** NOT NULL when true. Beats the validator's own `.required()`, as in the migration generator. */
  required?: boolean
  default?: InferType<T>
  /** Control FK constraint: false to skip, true to auto-infer, or explicit config */
  foreignKey?: boolean | import('./schema').ForeignKeyConfig
  validation?: {
    rule: unknown
    message?: Record<string, string>
  }
  factory?: (faker: FactoryFaker) => InferType<T>
}

/** Structural type for model instances passed to lifecycle hooks. */
// eslint-disable-next-line ts/no-empty-object-type
export interface ModelHookInstance extends Record<string, unknown> {
  get(key: string): unknown
  /** Raw attribute read (skips computed `get:` accessors). */
  getAttribute?(key: string): unknown
  /** Plain-object snapshot of all attributes. */
  getAttributes?(): Record<string, unknown>
  /** Subset of attributes for the named columns. */
  only?(keys: ReadonlyArray<string>): Record<string, unknown>
  /** All attributes except the named columns. */
  except?(keys: ReadonlyArray<string>): Record<string, unknown>
  /** Plain-object snapshot for JSON serialization (folds in relations). */
  toArray?(): Record<string, unknown>
}

/**
 * Object form of a `belongsTo` entry. The migration generator has always
 * honored `foreignKey`/`onDelete` here (see `normalizeRelationEntry`), but the
 * declaration type only admitted plain model-name strings — so the supported
 * form was a type error at the call site.
 */
export interface BelongsToEntry {
  readonly model: string
  /** Query/eager-load name; defaults to the lowercased model name. */
  readonly relationName?: string
  /** FK column on THIS table. Defaults to `${snake(model)}_id`. */
  readonly foreignKey?: string
  /** ON DELETE behaviour for the generated constraint. */
  readonly onDelete?: import('./schema').OnForeignKeyAction
}

// Base model definition
export interface ModelDefinition {
  readonly name: string
  readonly table: string
  readonly primaryKey?: string
  readonly autoIncrement?: boolean
  readonly connection?: string
  readonly traits?: {
    readonly useUuid?: boolean
    readonly useTimestamps?: boolean | object
    readonly timestampable?: boolean | object
    readonly useSoftDeletes?: boolean | object
    readonly softDeletable?: boolean | object
    readonly useSearch?: boolean | {
      readonly displayable?: readonly string[]
      readonly searchable?: readonly string[]
      readonly sortable?: readonly string[]
      readonly filterable?: readonly string[]
    }
    readonly useSeeder?: boolean | {
      readonly count: number
    }
    readonly seedable?: boolean | {
      readonly count: number
    }
    readonly useApi?: boolean | {
      readonly uri?: string
      readonly routes?: readonly string[]
      readonly middleware?: readonly string[]
    }
    readonly useAuth?: boolean | {
      readonly usePasskey?: boolean
      readonly useTwoFactor?: boolean
    }
    readonly authenticatable?: boolean | object
    readonly observe?: boolean | readonly string[]
    readonly billable?: boolean
    readonly likeable?: boolean | object
    readonly taggable?: boolean
    readonly categorizable?: boolean
    readonly commentables?: boolean
    readonly commentable?: boolean
    readonly useActivityLog?: boolean | object
    readonly useSocials?: readonly string[]
  }
  readonly belongsTo?: readonly (string | BelongsToEntry)[] | Readonly<Record<string, string | BelongsToEntry>>
  readonly hasMany?: readonly string[] | Readonly<Record<string, string>>
  readonly hasOne?: readonly string[] | Readonly<Record<string, string>>
  readonly belongsToMany?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly hasOneThrough?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly hasManyThrough?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly morphOne?: string | object | Readonly<Record<string, string>>
  readonly morphMany?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly morphTo?: object
  readonly morphToMany?: readonly string[]
  readonly morphedByMany?: readonly string[]
  readonly attributes: {
    readonly [key: string]: TypedAttribute<unknown>
  }
  readonly get?: Record<string, (attributes: Record<string, unknown>) => unknown>
  readonly set?: Record<string, (attributes: Record<string, unknown>) => unknown>
  readonly scopes?: Record<string, (value: unknown) => unknown>
  readonly indexes?: readonly object[]
  readonly dashboard?: { readonly enabled?: boolean; readonly highlight?: boolean | number }
  readonly hooks?: {
    readonly beforeCreate?: (data: Record<string, unknown>) => void | Promise<void>
    readonly afterCreate?: (model: ModelHookInstance) => void | Promise<void>
    readonly beforeUpdate?: (model: ModelHookInstance, data: Record<string, unknown>) => void | Promise<void>
    readonly afterUpdate?: (model: ModelHookInstance) => void | Promise<void>
    readonly beforeDelete?: (model: ModelHookInstance) => void | Promise<void>
    readonly afterDelete?: (model: ModelHookInstance) => void | Promise<void>
  }
}

/**
 * Whether one of a model's lifecycle hooks may answer with a promise.
 *
 * A model with no hooks, or only hooks that return nothing, writes where the
 * call is written. One `async` hook makes every write on that model wait for
 * it, so the write returns a promise. A definition known only as
 * `ModelDefinition` counts as possibly asynchronous: its hooks are not known.
 */
type HasAsyncHook<TDef> = TDef extends { hooks?: infer H }
  ? [H] extends [undefined]
      ? false
      : true extends {
        [K in keyof NonNullable<H>]-?: NonNullable<NonNullable<H>[K]> extends (...args: never[]) => infer R
          ? ([Extract<R, PromiseLike<unknown>>] extends [never] ? false : true)
          : false
      }[keyof NonNullable<H>]
        ? true
        : false
  : false

/**
 * Whether one of a model's `set` mutators answers with a promise. A write
 * waits for such a mutator, so it returns a promise, the same as for a hook.
 * A `set` known only as a record of functions is not counted: nothing says
 * any of them is asynchronous.
 */
type HasAsyncSetter<TDef> = TDef extends { set?: infer S }
  ? [S] extends [undefined]
      ? false
      : true extends {
        [K in keyof NonNullable<S>]-?: NonNullable<NonNullable<S>[K]> extends (...args: never[]) => infer R
          ? (unknown extends R ? false : [Extract<R, PromiseLike<unknown>>] extends [never] ? false : true)
          : false
      }[keyof NonNullable<S>]
        ? true
        : false
  : false

/**
 * What a write returns: the value, or a promise of it on a model whose hooks
 * or mutators may be asynchronous (see {@link HasAsyncHook} and
 * {@link HasAsyncSetter}). Reads never run either, so they are always the value.
 */
export type Written<TDef, R> = true extends (HasAsyncHook<TDef> | HasAsyncSetter<TDef>) ? Promise<R> : R

// Extract attribute keys from definition
type AttributeKeys<TDef extends ModelDefinition> = keyof TDef['attributes'] & string

// Infer single attribute type
type InferAttributeType<TAttr> =
  TAttr extends { type: infer T } ? InferType<T> :
  TAttr extends { factory: (faker: FactoryFaker) => infer R }
    ? [Exclude<R, null | undefined>] extends [never]
      ? TAttr extends { validation: { rule: infer V } } ? InferType<V> | Extract<R, null | undefined> : R
      : R
    : TAttr extends { validation: { rule: infer R } } ? InferType<R> :
  unknown

// Build the full attributes type from definition. Columns declared
// `nullable: true` admit null — mirrors InferAttributes in type-inference.ts.
type InferModelAttributes<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { nullable: true }
    ? InferAttributeType<TDef['attributes'][K]> | null
    : InferAttributeType<TDef['attributes'][K]>
}

type SnakeCase<S extends string> = S extends `${infer C}${infer Rest}`
  ? C extends Lowercase<C>
    ? `${C}${SnakeCase<Rest>}`
    : `_${Lowercase<C>}${SnakeCase<Rest>}`
  : S

type SnakeCaseAttributes<TDef extends ModelDefinition> = {
  [K in keyof InferModelAttributes<TDef> & string as SnakeCase<K>]: InferModelAttributes<TDef>[K]
}

// System fields added by traits. The primary-key column honors the model's
// declared `primaryKey` (default 'id') — a custom-pk model exposes THAT
// column, not a phantom 'id'. Mirrors InferAttributes in type-inference.ts.
type TraitSystemFields<TDef extends ModelDefinition> =
  { [K in TDef extends { primaryKey: infer PK extends string } ? PK : 'id']: number } &
  (TDef['traits'] extends { useUuid: true } ? { uuid: string } : {}) &
  (TDef['traits'] extends { useTimestamps: true } ? { created_at: string; updated_at: string | null } : {}) &
  (TDef['traits'] extends { timestampable: true | object } ? { created_at: string; updated_at: string | null } : {}) &
  (TDef['traits'] extends { useSoftDeletes: true } ? { deleted_at: string | null } : {}) &
  (TDef['traits'] extends { softDeletable: true | object } ? { deleted_at: string | null } : {}) &
  (TDef['traits'] extends { useAuth: true | object } ? { two_factor_secret: string | null; public_key: string | null } : {}) &
  (TDef['traits'] extends { billable: true | object } ? { stripe_id: string | null } : {})

/**
 * Every column name the model declares itself, in both the casing it was
 * written in and its snake_case column form.
 */
type DeclaredColumns<TDef extends ModelDefinition> =
  AttributeKeys<TDef> | SnakeCase<AttributeKeys<TDef>>

/**
 * Trait-added system fields, minus anything the model declares explicitly.
 *
 * Without the `Omit`, a model that declares a column a trait also contributes
 * (`created_at: { type: 'date' }` alongside `useTimestamps`, or a `user_id`
 * string alongside `belongsTo: ['User']`) intersected the two shapes into
 * `Date & string` — or outright `never`. Every read of that column then had an
 * uninhabited type and every write was rejected. A column the model spells out
 * is the authority on its own type; the trait default only fills the gap.
 */
type SystemFields<TDef extends ModelDefinition> =
  Omit<TraitSystemFields<TDef>, DeclaredColumns<TDef>>

/**
 * A single `belongsTo` entry reduced to the FK column it puts on this table.
 * Mirrors `normalizeRelationEntry` in relation-utils.ts: an explicit
 * `foreignKey` wins, otherwise the name is derived from the model name.
 */
type BelongsToFkOf<E> =
  E extends string
    ? `${SnakeCase<Uncapitalize<E>>}_id`
    : E extends { foreignKey: infer F extends string }
      ? F
      : E extends { model: infer M extends string }
        ? `${SnakeCase<Uncapitalize<M>>}_id`
        : never

/**
 * The foreign-key columns a `belongsTo` puts on THIS model's table.
 *
 * `belongsTo: ['Farm', 'Field']` means the migration carries `farm_id` and
 * `field_id`, so they are as real as any declared attribute and code queries
 * them constantly (`Mission.where('field_id', field.id)`). They were missing
 * from both `ModelAttributes` and `ColumnName`, which made every such query a
 * type error against a column that demonstrably exists.
 *
 * All four declaration shapes the migration generator accepts are covered:
 * `['Farm']`, `[{ model: 'Farm', foreignKey: 'owner_id' }]`, `{ farm: 'Farm' }`
 * and `{ owner: { model: 'User', foreignKey: 'owner_id' } }`. The array case
 * MUST be checked first — a tuple also structurally matches `Record`, and the
 * record branch would otherwise read its numeric indices as entries.
 *
 * The default name follows the same snake_case convention the relation resolver
 * uses at runtime: `Farm` -> `farm_id`, `TreatmentMap` -> `treatment_map_id`.
 */
type BelongsToKeys<TDef extends ModelDefinition> =
  TDef extends { belongsTo: infer R }
    ? R extends readonly (infer E)[]
      ? BelongsToFkOf<E>
      : R extends Readonly<Record<string, infer W>>
        ? BelongsToFkOf<W>
        : never
    : never

// A declared attribute of the same name wins — see SystemFields above.
type BelongsToColumns<TDef extends ModelDefinition> = {
  [K in Exclude<BelongsToKeys<TDef>, DeclaredColumns<TDef>>]: number
}

// Complete model type
type ModelAttributes<TDef extends ModelDefinition> =
  InferModelAttributes<TDef> & SnakeCaseAttributes<TDef> & SystemFields<TDef> & BelongsToColumns<TDef>

// All valid column names
type ColumnName<TDef extends ModelDefinition> =
  | AttributeKeys<TDef>
  | SnakeCase<AttributeKeys<TDef>>
  | (TDef extends { primaryKey: infer PK extends string } ? PK : 'id')
  | (TDef['traits'] extends { useUuid: true } ? 'uuid' : never)
  | (TDef['traits'] extends { useTimestamps: true } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { timestampable: true | object } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { useSoftDeletes: true } ? 'deleted_at' : never)
  | (TDef['traits'] extends { softDeletable: true | object } ? 'deleted_at' : never)
  | (TDef['traits'] extends { useAuth: true | object } ? 'two_factor_secret' | 'public_key' : never)
  | (TDef['traits'] extends { billable: true | object } ? 'stripe_id' : never)
  | BelongsToKeys<TDef>

// Hidden fields
type HiddenKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { hidden: true } ? K : never
}[AttributeKeys<TDef>]

// Fillable fields
type FillableKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { fillable: true } ? K : never
}[AttributeKeys<TDef>]

/**
 * `belongsTo` foreign keys are always writable.
 *
 * Attaching a record to its parent IS the create: `Mission.create({ …,
 * field_id: field.id })`. There is no attribute declaration to put
 * `fillable: true` on, because the column comes from the relation rather than
 * from `attributes`, so without this every such create was a type error
 * against the one column the relation exists to set.
 */
/**
 * What `create` / `update` accept.
 *
 * `null` is allowed alongside each column's own type because a write is how a
 * nullable column gets CLEARED, and that is a different instruction from
 * leaving the field out. Without it, a caller assembling an update payload -
 * `{ subject: form.subject ?? null }` is the ordinary shape - had to choose
 * between a type error and `undefined`, and `undefined` silently means "do not
 * touch this column", so the field the user cleared stayed as it was.
 *
 * The database's own nullability is still the authority: writing null to a NOT
 * NULL column fails there, as it should.
 */
type FillableAttributes<TDef extends ModelDefinition> = Partial<Pick<
  {
    [K in keyof ModelAttributes<TDef>]:
    // Already nullable: nothing to add.
    null extends ModelAttributes<TDef>[K]
      ? ModelAttributes<TDef>[K]
      // Optional, or a column the migration creates without NOT NULL: `null`
      // is how a write CLEARS it, which is different from omitting the key.
      : undefined extends ModelAttributes<TDef>[K]
        ? ModelAttributes<TDef>[K] | null
        : K extends NullableColumnKeys<TDef>
          ? ModelAttributes<TDef>[K] | null
          // Required: null stays rejected, as the NOT NULL column would reject it.
          : ModelAttributes<TDef>[K]
  } & BelongsToCamelColumns<TDef>,
  FillableKeys<TDef> | SnakeCase<FillableKeys<TDef>> | BelongsToKeys<TDef> | CamelCase<BelongsToKeys<TDef>>
>>

/**
 * Whether the migration generator creates this attribute's column without
 * NOT NULL. Mirrors `migrations.ts`: `nullable ?? !(required ?? validator
 * .required())`. A plain `schema.string()` infers `string`, not
 * `string | undefined`, so the check above never saw it as optional - and a
 * write clearing a nullable column (`{ cwd: null }`) was a type error against
 * a column the database had just been told could hold null.
 */
type IsNullableColumn<TAttr> =
  TAttr extends { nullable: true } ? true
    : TAttr extends { nullable: false } ? false
      : TAttr extends { required: true } ? false
        : TAttr extends { required: false } ? true
          : TAttr extends { validation: { rule: { readonly __isRequired: true } } } ? false
            : true

type NullableAttributeKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: IsNullableColumn<TDef['attributes'][K]> extends true ? K : never
}[AttributeKeys<TDef>]

// `belongsTo` FK columns are created nullable, like any unrequired column.
type NullableColumnKeys<TDef extends ModelDefinition> =
  | NullableAttributeKeys<TDef>
  | SnakeCase<NullableAttributeKeys<TDef>>
  | BelongsToKeys<TDef>

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<CamelCase<Tail>>}` : S

/**
 * `conversationId` as well as `conversation_id`: every write key is
 * normalized to snake_case before it reaches SQL (`normalizeAttributeKeys`),
 * so the camelCase spelling already worked at runtime - and declared
 * attributes accept both - but the type only admitted the column name.
 */
type BelongsToCamelColumns<TDef extends ModelDefinition> = {
  [K in Exclude<BelongsToKeys<TDef>, DeclaredColumns<TDef>> as CamelCase<K>]: number | null
}

// Numeric attribute columns - constrains aggregate methods (sum, avg, etc.)
type NumericColumns<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: InferAttributeType<TDef['attributes'][K]> extends number ? K : never
}[AttributeKeys<TDef>]

/**
 * Cardinality-aware value of a loaded relation as returned by
 * `ModelInstance.getRelation()`. Relations declared as to-many (hasMany,
 * belongsToMany, hasManyThrough) yield arrays; to-one relations (hasOne,
 * belongsTo, hasOneThrough) yield a single instance or null. `undefined`
 * means the relation was not eager-loaded.
 */
type LoadedRelationValue<TDef, R extends string> =
  'one' extends RelationCardinality<TDef, R>
    ? ModelInstance<any, any> | null | undefined
    : 'many' extends RelationCardinality<TDef, R>
      ? ModelInstance<any, any>[] | undefined
      : ModelInstance<any, any>[] | ModelInstance<any, any> | null | undefined

/** A hydrated model instance with its selected columns exposed as proxy properties. */
export type ModelRecord<
  TDef extends ModelDefinition,
  TSelected extends ColumnName<TDef> = ColumnName<TDef>,
> = ModelInstance<TDef, TSelected>
  & Pick<ModelAttributes<TDef>, Extract<TSelected, keyof ModelAttributes<TDef>>>
  & { [R in InferRelationNames<TDef>]?: LoadedRelationValue<TDef, R> }

type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'not like' | 'ilike' | 'not ilike' | 'in' | 'not in'

// --- Dialect-aware execution layer -------------------------------------------
//
// The model API historically ran every query through a hardcoded in-memory
// `bun:sqlite` Database, so projects configured for MySQL/Postgres had their
// model calls silently routed to a fresh, empty SQLite database — every query
// returned "no such table" (stacksjs/bun-query-builder#1021).
//
// All model queries go through an `OrmExecutor` chosen from the configured
// dialect, and every one of them answers where the query is written unless it
// has no way to:
//
//  - SQLite runs on its synchronous `bun:sqlite` engine.
//  - MySQL and Postgres run on Bun's `SQL` driver, held by a worker thread
//    that the caller waits on (sync-driver.ts). Same driver, same pool options,
//    same database as the shared `getOrCreateBunSql()` connection.
//  - A connection a caller injected, a libSQL server, and
//    `models.execution: 'async'` run on this thread's async connection and
//    answer with promises.
//
// That is why the model layer is written with `settle`/`wait` (settle.ts)
// rather than `async`/`await`: a method returns a plain value when its
// executor and its hooks did, and a promise only when one of them did.

type RunResult = { changes: number, lastInsertId: number | bigint | null }

/**
 * What an executor hands back: the value where the connection answers in
 * place (bun:sqlite, and the network dialects through sync-driver.ts), a
 * promise of it where the connection can only answer later. Callers read it
 * through `wait`, which takes either.
 */
type Answer<T> = T | Promise<T>

interface OrmExecutor {
  readonly dialect: SupportedDialect
  all: (sql: string, params: unknown[]) => Answer<Record<string, unknown>[]>
  get: (sql: string, params: unknown[]) => Answer<Record<string, unknown> | undefined>
  run: (sql: string, params: unknown[]) => Answer<RunResult>
  /** INSERT that resolves the new primary-key id in a dialect-aware way. */
  insert: (sql: string, params: unknown[], primaryKey: string) => Answer<RunResult>
  /** The underlying bun:sqlite Database, when (and only when) the dialect is sqlite. */
  readonly sqliteDb?: Database
}

/**
 * Rewrite `?` placeholders to Postgres `$1, $2, …` form.
 *
 * This was a bare `sql.replace(/\?/g, …)`, on the reasoning that the ORM only
 * emits `?` as a parameter marker. But `whereRaw` fragments are caller text, so
 * `whereRaw("name = '?'")` went out as `name = '$1'` and matched nothing, and a
 * `?` in a comment took a binding meant for a later placeholder. It now skips
 * literals, quoted identifiers and comments like `toDialectPlaceholders`.
 *
 * Memoized: query TEXT repeats heavily (values are placeholders), and this
 * regex pass runs on every Postgres query the ORM executes. Bounded; cleared
 * wholesale at the cap.
 */
const pgPlaceholderCache = new Map<string, string>()
const PG_PLACEHOLDER_CACHE_MAX = 500

function toPostgresPlaceholders(sql: string): string {
  const hit = pgPlaceholderCache.get(sql)
  if (hit !== undefined) return hit
  const out = toDialectPlaceholders(sql, 'postgres')
  if (pgPlaceholderCache.size >= PG_PLACEHOLDER_CACHE_MAX)
    pgPlaceholderCache.clear()
  pgPlaceholderCache.set(sql, out)
  return out
}

/**
 * Extract an affected-row count from a Bun SQL driver result.
 *
 * Verified against live Postgres (Bun 1.3): a non-RETURNING `UPDATE`/`DELETE`
 * returns an empty array carrying `{ count: <affected>, affectedRows: null,
 * command: 'UPDATE' }`. So `count` must be checked BEFORE the `Array.length`
 * fallback (which would be 0) — see stacksjs/bun-query-builder#1032. MySQL
 * surfaces `affectedRows` instead.
 */
/**
 * What a driver hands back after a write.
 *
 * Each one reports the affected count under its own name - and Postgres
 * returns an empty array carrying `count`, so the shape is genuinely a union
 * rather than one thing. Naming the fields beats `any`: a caller reading this
 * type learns which drivers report what.
 */
export interface WriteResultLike {
  /** MySQL. */
  affectedRows?: number
  /** Postgres command tag. */
  count?: number
  /** SQLite (bun:sqlite). */
  changes?: number
  lastInsertRowid?: number | bigint
  insertId?: number | bigint
  command?: string
  rows?: unknown[]
  [key: string]: unknown
}

export function extractChanges(res: WriteResultLike | null | undefined): number {
  if (res == null)
    return 0
  if (typeof res.affectedRows === 'number') // MySQL
    return res.affectedRows
  if (typeof res.count === 'number') // Postgres command tag (affected rows)
    return res.count
  if (Array.isArray(res))
    return res.length
  return 0
}

/** Extract a generated primary key from a Bun SQL driver result. */
export function extractInsertId(res: WriteResultLike | null | undefined): number | bigint | null {
  if (res == null || typeof res !== 'object')
    return null
  if ('insertId' in res && res.insertId != null) // MySQL
    return res.insertId
  if ('lastInsertRowid' in res && res.lastInsertRowid != null) // bun:sqlite
    return res.lastInsertRowid
  return null
}

class SqliteExecutor implements OrmExecutor {
  readonly dialect = 'sqlite' as const
  constructor(public readonly sqliteDb: Database) {}

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    return this.sqliteDb.query(sql).all(...(serializeBindings(params) as Bindings)) as Record<string, unknown>[]
  }

  get(sql: string, params: unknown[]): Record<string, unknown> | undefined {
    return (this.sqliteDb.query(sql).get(...(serializeBindings(params) as Bindings)) as Record<string, unknown> | null) ?? undefined
  }

  run(sql: string, params: unknown[]): RunResult {
    const r = this.sqliteDb.run(sql, serializeBindings(params) as Bindings)
    return { changes: r.changes, lastInsertId: r.lastInsertRowid }
  }

  insert(sql: string, params: unknown[]): RunResult {
    return this.run(sql, params)
  }
}

/** A connection as the executor uses it: one statement in, the driver's result out, now or later. */
interface StatementRunner {
  /** The rows, as an array that also carries what the driver reported about a write (see {@link WriteResultLike}). */
  unsafe: (sql: string, params: unknown[]) => unknown
}

class DriverExecutor implements OrmExecutor {
  /**
   * `synchronous` runs each statement on the worker-held connection and
   * returns its rows in place (sync-driver.ts). Without it the statement goes
   * to the shared connection on this thread, which answers with a promise.
   */
  constructor(public readonly dialect: SupportedDialect, private readonly synchronous = false) {}

  /** The live dialect-aware connection (handles its own reset/config-change). */
  private conn(): StatementRunner {
    if (this.synchronous) {
      const driver = syncDriverFor(connectionSignature(), networkConnectionTarget)
      // The async connection is wrapped so a Date binds as ISO text on
      // Postgres (bindings.ts). The worker's is a bare driver, so the same
      // serialization happens here, before the parameters cross over. MySQL
      // keeps its native Date binding, exactly as on the wrapped connection.
      const timeoutMs = config.models?.timeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
      const postgres = this.dialect === 'postgres'
      return { unsafe: (sql, params) => driver.unsafe(sql, postgres ? serializeBindings(params) : params, timeoutMs) }
    }
    return getOrCreateBunSql() as unknown as StatementRunner
  }

  private text(sql: string): string {
    return this.dialect === 'postgres' ? toPostgresPlaceholders(sql) : sql
  }

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    const self = this
    return settle(function* (): Generator<unknown, Record<string, unknown>[], unknown> {
      const rows = (yield* wait(self.conn().unsafe(self.text(sql), params)))
      return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
    })
  }

  get(sql: string, params: unknown[]): Record<string, unknown> | undefined {
    const self = this
    return settle(function* (): Generator<unknown, Record<string, unknown> | undefined, unknown> {
      const rows = (yield* wait(self.conn().unsafe(self.text(sql), params)))
      if (Array.isArray(rows))
        return (rows[0] as Record<string, unknown> | undefined) ?? undefined
      return (rows as Record<string, unknown> | undefined) ?? undefined
    })
  }

  run(sql: string, params: unknown[]): RunResult {
    const self = this
    return settle(function* (): Generator<unknown, RunResult, unknown> {
      const res = (yield* wait(self.conn().unsafe(self.text(sql), params))) as WriteResultLike
      return { changes: extractChanges(res), lastInsertId: extractInsertId(res) }
    })
  }

  insert(sql: string, params: unknown[], primaryKey: string): RunResult {
    const self = this
    return settle(function* (): Generator<unknown, RunResult, unknown> {
      if (self.dialect === 'postgres') {
        // Postgres has no auto-increment rowid to read back — RETURNING is the
        // portable way to recover the generated key.
        const rows = (yield* wait(self.conn().unsafe(`${toPostgresPlaceholders(sql)} RETURNING ${primaryKey}`, params)))
        const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | undefined
        return { changes: 1, lastInsertId: row ? ((row[primaryKey] as number | bigint | null | undefined) ?? null) : null }
      }
      // MySQL: no RETURNING — read the driver's insertId, falling back to
      // LAST_INSERT_ID() on the same connection. SQLite over libSQL reports the
      // rowid with the result itself; a follow-up `last_insert_rowid()` would run
      // on a different server connection and read 0, so there is no fallback.
      const res = (yield* wait(self.conn().unsafe(sql, params))) as WriteResultLike
      let id = extractInsertId(res)
      if (id == null && self.dialect !== 'sqlite') {
        const rows = (yield* wait(self.conn().unsafe('SELECT LAST_INSERT_ID() as id', [])))
        const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | undefined
        id = (row?.id as number | bigint | undefined) ?? null
      }
      return { changes: extractChanges(res) || 1, lastInsertId: id }
    })
  }
}

// Explicit sqlite Database supplied via configureOrm() — overrides the
// configured dialect and pins the model layer to that connection. Preserves
// the existing `configureOrm({ database })` contract for sqlite-only consumers
// and the test suite, which run against an in-memory database regardless of
// the (postgres) default dialect.
let globalDb: Database | null = null

/**
 * Whether `globalDb` is a handle this module opened, rather than one a caller
 * supplied. Only the former is ours to close in {@link releaseOrm}.
 */
let globalDbOwned = false

let _executor: OrmExecutor | null = null
let _executorForDb: Database | null = null
let _executorDialect: string | null = null
let _executorDatabase: string | null = null

export function configureOrm(options: { database?: string | Database; verbose?: boolean }): void {
  if (options.database instanceof Database) {
    // Caller-supplied connection: bring-your-own Database means
    // bring-your-own pragmas — never override their settings.
    globalDb = options.database
    globalDbOwned = false
  }
  else {
    globalDb = new Database(options.database || ':memory:', { create: true })
    globalDbOwned = true
    // This connection is what every Model.create()/save()/delete() writes
    // through — without the bootstrap it runs with foreign_keys OFF (orphan
    // rows insert silently) no matter what the query-builder connection was
    // configured with.
    applySqliteBootstrapPragmas(globalDb)
  }
  // Force the executor to rebind to the newly-supplied database.
  _executor = null
  _executorForDb = null
}

/**
 * Hand back the `configureOrm({ database })` override.
 *
 * `globalDb` outranks `setConfig()` in {@link getExecutor} and, until now, for
 * the rest of the process: `configureOrm` could repoint it but nothing could
 * remove it. In a runner that shares one process across many files - `bun test`
 * does - the last file to configure the ORM left every later one pinned to a
 * database it owned, and typically deleted in its own teardown. Everything
 * afterwards got `RangeError: Cannot use a closed database` from a connection
 * it never asked for (stacksjs/stacks#2415).
 *
 * After this call, resolution falls back to the dialect and database from
 * `setConfig()`, exactly as if `configureOrm` had never run.
 *
 * A handle opened from a path is closed, since this module opened it and
 * nothing else can. One passed in as a `Database` is left alone: bring your own
 * connection, keep your own lifetime.
 */
export function releaseOrm(): void {
  const owned = globalDbOwned
  const previous = globalDb

  globalDb = null
  globalDbOwned = false
  _executor = null
  _executorForDb = null
  _executorDialect = null
  _executorDatabase = null
  closeSyncDriver()

  if (owned && previous) {
    try {
      previous.close()
    }
    catch {
      // Already closed, or closed underneath us. Releasing is the point; the
      // handle being gone early is not a failure worth propagating.
    }
  }
}

/**
 * Resolve the executor for the active configuration.
 *
 * An explicit `configureOrm({ database })` always wins and keeps the model
 * layer on sqlite. Otherwise the dialect from `setConfig()` decides: sqlite
 * opens a `bun:sqlite` Database on the configured filename (or `:memory:`),
 * while mysql / postgres route through Bun's `SQL` driver, synchronously
 * unless something rules that out (see the note on the execution layer). The
 * executor is rebuilt whenever the dialect, the database or that choice
 * changes.
 */
let _warnedImplicitMemory = false

function getExecutor(): OrmExecutor {
  if (globalDb) {
    if (!_executor || _executorForDb !== globalDb) {
      _executor = new SqliteExecutor(globalDb)
      _executorForDb = globalDb
      _executorDialect = 'sqlite'
      _executorDatabase = null
    }
    return _executor
  }

  const dialect = config.dialect
  const database = config.database?.database ?? null
  // The libSQL URL is part of the identity: pointing the same `database` name
  // at a server instead of a file has to rebuild the executor.

  // A connection a caller supplied can only answer with promises, and so can
  // a libSQL server (its transport is `fetch`). `models.execution: 'async'`
  // asks for that path on purpose. All three are part of the identity: a test
  // that injects a connection, then drops it, must not keep the old executor.
  const synchronous = config.models?.execution !== 'async' && !hasInjectedSqlInstance() && !resolveLibSQLTarget()
  const identity = `${database ?? ''}|${resolveLibSQLTarget()?.url ?? ''}|${synchronous ? 'sync' : 'async'}`

  if (_executor && _executorForDb === null && _executorDialect === dialect && _executorDatabase === identity)
    return _executor

  _executorForDb = null
  _executorDialect = dialect
  _executorDatabase = identity

  // A libSQL server keeps the sqlite dialect but is not a file `bun:sqlite`
  // can open: the model layer writes through the shared async connection,
  // because its transport is `fetch` and that only answers later.
  if (dialect === 'sqlite' && resolveLibSQLTarget()) {
    _executor = new DriverExecutor(dialect)
  }
  else if (dialect === 'sqlite') {
    // No database named means an in-memory one, which is right for a test and
    // wrong everywhere else: every write succeeds and is gone when the process
    // exits. Said once, so a model layer that was never pointed at the app's
    // database is visible instead of looking like it works.
    if (!database && !_warnedImplicitMemory) {
      _warnedImplicitMemory = true
      console.warn(
        '[bun-query-builder] The model layer has no database configured, so it is using an in-memory '
        + 'SQLite database and nothing it writes will persist. Configure one with setConfig({ dialect, database }) '
        + 'or configureOrm({ database }), or name \':memory:\' explicitly to silence this.',
      )
    }
    const db = new Database(database || ':memory:', { create: true })
    // Same rationale as configureOrm: this lazily-created connection is the
    // model write path — it must get the per-connection bootstrap pragmas.
    applySqliteBootstrapPragmas(db)
    _executor = new SqliteExecutor(db)
  }
  else {
    _executor = new DriverExecutor(dialect, synchronous)
  }

  return _executor
}

/**
 * Return the underlying `bun:sqlite` Database backing the model layer.
 *
 * Only meaningful when the active dialect is sqlite (or a sqlite Database was
 * supplied via `configureOrm`). For mysql/postgres there is no `Database`
 * object — use the model API instead. Retained for backwards
 * compatibility with callers that reach for the raw sqlite handle (tests,
 * low-level table setup).
 */
export function getDatabase(): Database {
  const exec = getExecutor()
  if (exec.sqliteDb)
    return exec.sqliteDb
  throw new Error(
    `[bun-query-builder] getDatabase() is only available for the sqlite dialect; `
    + `the configured dialect is '${exec.dialect}'. Use the model API instead.`,
  )
}

/**
 * Bound parameters per bulk INSERT.
 *
 * Far under every dialect's ceiling (SQLite 32766; Postgres and MySQL 65535),
 * because the ceiling is not what limits it. Drivers cache each distinct
 * statement as a prepared statement for the life of the connection (Bun's SQL
 * does by default), and the database server keeps its parse and plan: about
 * 0.2 KB per parameter on Postgres. At 30000 a year of seed data in batches
 * grew one Postgres backend past 1.8 GB. Kept small, and with the row counts
 * below limited to powers of two, a table costs a few MB of cached statements
 * however much is written.
 */
const BULK_INSERT_MAX_PARAMS = 4096

/** Rows per jsonb batch on Postgres, where the whole batch is one parameter. */
const BULK_JSON_ROWS = 1000

/**
 * Whether rows can travel as one jsonb parameter without changing meaning.
 *
 * Only primitives and dates: JSON renders those exactly as the VALUES path
 * would bind them. A column declared json/jsonb stays on the VALUES path,
 * where a pre-serialized string is parsed as JSON; through jsonb it would
 * arrive as a JSON string scalar instead. So do binary values, which JSON
 * cannot carry.
 */
function jsonBatchable(definition: ModelDefinition, columns: string[], rows: Record<string, unknown>[]): boolean {
  const attributes = definition.attributes as Record<string, { type?: unknown }>
  const byColumn = new Map(Object.entries(attributes).map(([key, attr]) => [toSnakeCase(key), attr]))
  for (const column of columns) {
    const type = String(byColumn.get(column)?.type ?? '').toLowerCase()
    if (type === 'json' || type === 'jsonb')
      return false
  }
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column]
      if (value === null || value === undefined || value instanceof Date)
        continue
      const kind = typeof value
      if (kind !== 'string' && kind !== 'number' && kind !== 'boolean' && kind !== 'bigint')
        return false
    }
  }
  return true
}

/** JSON.stringify replacer: bigint as its decimal text, which Postgres casts back. */
function jsonValue(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** The largest power of two at most `n` (n >= 1). */
function floorPowerOfTwo(n: number): number {
  return 2 ** Math.floor(Math.log2(n))
}

/** The column soft deletes are tracked on (matches the migration + `delete()`). */
const SOFT_DELETE_COLUMN = 'deleted_at'

/**
 * Keys per statement when a query delete with hooks deletes the rows it read
 * by key. Far under every dialect's bound-parameter limit (SQLite 32766,
 * Postgres 65535).
 */
const DELETE_KEY_CHUNK = 500

/**
 * Alias prefix for the related table's columns in a belongsToMany SELECT, so a
 * same-named pivot column (`id`, `status`, `created_at`, …) can't overwrite the
 * related value when both tables are selected into one flat row. We alias the
 * RELATED side (fully known from its model definition) and keep `pivot.*`, so
 * this doesn't depend on the pivot's declared columns (which are empty for
 * `through:` models). See stacksjs/bun-query-builder#1036.
 */
const BTM_RELATED_ALIAS = '__btm_rel__'

/**
 * Whether a model has soft-deletes enabled. Accepts both `useSoftDeletes` and
 * the `softDeletable` alias (stacksjs/bun-query-builder#1031), in boolean or
 * object form.
 */
function softDeletesEnabled(definition: ModelDefinition): boolean {
  const t = definition.traits
  return Boolean(t?.useSoftDeletes || t?.softDeletable)
}

/**
 * Whether a model auto-manages `created_at`/`updated_at`. Accepts both
 * `useTimestamps` and the `timestampable` alias (stacksjs/bun-query-builder#1031),
 * in boolean or object form.
 */
function timestampsEnabled(definition: ModelDefinition): boolean {
  const t = definition.traits
  return Boolean(t?.useTimestamps || t?.timestampable)
}

/**
 * The SET list of an UPDATE on a timestamped model: the caller's columns, then
 * `updated_at` stamped with the time of the write.
 *
 * The write owns `updated_at`, as it does on insert, so a caller's own
 * `updated_at` is left out rather than sent next to the managed one. Sent both,
 * SQLite kept the rightmost and MySQL applied them in order, so the managed
 * time won quietly there, while Postgres refused the whole statement:
 * "multiple assignments to same column". An update naming only `updated_at`
 * still writes it, as the time of the write.
 */
function managedUpdateSet(entries: [string, unknown][], column: (name: string) => string): { sets: string, values: unknown[] } {
  // By column, so `updatedAt` (which the builder snake-cases) is caught too.
  const own = entries.filter(([k]) => column(k) !== 'updated_at')
  return {
    sets: [...own.map(([k]) => `${quoteSqlColumn(column(k))} = ?`), 'updated_at = ?'].join(', '),
    values: [...own.map(([, v]) => v), formatNow()],
  }
}

/**
 * Collect every `belongsToMany` relation key declared on a model definition.
 * Used by ModelInstance's Proxy to know which property reads should resolve
 * to a callable RelationBuilder.
 *
 * Cached per definition object: this runs in the ModelInstance CONSTRUCTOR,
 * i.e. once per hydrated row — without the cache a 10k-row result re-derived
 * the same Set 10k times.
 */
const btmKeysCache = new WeakMap<ModelDefinition, Set<string>>()

function collectBelongsToManyKeys(definition: ModelDefinition): Set<string> {
  const cached = btmKeysCache.get(definition)
  if (cached) return cached
  const keys = new Set<string>()
  const rel = definition.belongsToMany
  if (rel) {
    if (Array.isArray(rel)) {
      for (const item of rel) {
        if (typeof item === 'string') keys.add(item.toLowerCase())
        else if (item && typeof item === 'object' && (item as any).model) keys.add(((item as any).model as string).toLowerCase())
      }
    }
    else if (typeof rel === 'object') {
      for (const k of Object.keys(rel)) keys.add(k)
    }
  }
  btmKeysCache.set(definition, keys)
  return keys
}

/**
 * Convert every key of `data` to snake_case. Read paths (`find`, `get`, ...)
 * hydrate `_attributes` straight from raw SQL rows, which are always
 * snake_case (that's what the migration generator emits as column names —
 * see migrations.ts). Write paths (`create`, `update`, `.fill()`) previously
 * stored whatever casing the caller passed verbatim, with no normalization.
 * For a single-word attribute (`name`, `status`) camelCase and snake_case are
 * identical, so this went unnoticed; for any multi-word attribute
 * (`memberCount`/`member_count`, `checkIntervalSeconds`/`check_interval_seconds`)
 * the two write paths disagreed about which casing to check, and the value
 * was silently dropped from the INSERT/UPDATE regardless of which casing the
 * caller used (see the "Create" branch in `save()` and `fill()` below).
 * Normalizing at every entry point makes `_attributes` internally consistent
 * with what a read produces, independent of caller casing.
 */
function normalizeAttributeKeys(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[toSnakeCase(key)] = value
  }
  return result
}

/**
 * Hydration variant of `normalizeAttributeKeys` for rows the caller no longer
 * owns (a fresh SQL row, or an object we already copied).
 *
 * Read paths hydrate straight from SQL rows, which are ALREADY snake_case —
 * that's what the migration generator emits. Rebuilding an identical object
 * for every row was a wasted allocation and a wasted `toSnakeCase` per column
 * on the hottest path in the library: a 10k-row result did 10k object
 * allocations that changed nothing. Scan first, and only rebuild when a key
 * actually differs.
 */
function normalizeAttributeKeysInPlace(data: Record<string, unknown>): Record<string, unknown> {
  for (const key in data) {
    if (toSnakeCase(key) !== key)
      return normalizeAttributeKeys(data)
  }
  return data
}

/**
 * Find a declared attribute's definition regardless of whether `key` (as
 * passed by the caller) or the attribute's own declaration in the model
 * matches camelCase or snake_case.
 */
function findAttributeDef(attrs: Record<string, any>, key: string): any {
  if (attrs[key]) return attrs[key]
  const snake = toSnakeCase(key)
  if (attrs[snake]) return attrs[snake]
  for (const k of Object.keys(attrs)) {
    if (toSnakeCase(k) === snake) return attrs[k]
  }
  return undefined
}

/**
 * Model instance - represents a single database record
 */
class ModelInstance<
  TDef extends ModelDefinition,
  TSelected extends ColumnName<TDef> = ColumnName<TDef>
> {
  private _attributes: Record<string, unknown>
  private _original: Record<string, unknown> | null // null = copy-on-write (identical to _attributes)
  /**
   * Columns written through `forceFill()`, the documented mass-assignment
   * bypass. Tracked per column rather than as one instance-wide flag so a
   * later `fill()` cannot ride in on an earlier force. See save()'s create
   * branch, which is the only reader.
   */
  private _forced: Set<string> = new Set()
  private _definition: TDef
  private _hasSaved = false
  /**
   * Whether this instance is a row in the table: true when it was read from
   * the database or has been inserted, false for one built by `create()`,
   * `make()` or `replicate()` that has not been saved yet. save() branches on
   * this. It used to branch on whether the primary key was truthy, which sent
   * a caller-supplied key (`create({ id: 5 })`, or any string key) down the
   * UPDATE path, so nothing was inserted, and sent a loaded row whose key was
   * `0` down the INSERT path, so it was duplicated.
   */
  private _exists: boolean
  private _relations: Record<string, ModelInstance<any, any>[] | ModelInstance<any, any> | null> = {}

  constructor(definition: TDef, attributes: Partial<ModelAttributes<TDef>>, exists: boolean) {
    this._definition = definition
    this._exists = exists
    // The spread already gives us a private copy, so the normalizer may reuse
    // it instead of building a second object per hydrated row.
    this._attributes = normalizeAttributeKeysInPlace({ ...attributes })
    this._original = null // deferred — only copied on first mutation

    // Install a callable accessor for each declared `belongsToMany` relation:
    // `coach.athletes()` returns a fresh BelongsToManyRelationBuilder. Existing
    // methods on the class (get/set/save/...) take precedence — we only
    // intercept property names that don't already exist on the target.
    const btmKeys = collectBelongsToManyKeys(definition)
    if (btmKeys.size === 0) return
    const self = this
    // eslint-disable-next-line no-constructor-return
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && btmKeys.has(prop) && !(prop in target)) {
          return () => {
            const resolved = resolveRelation(definition as ModelDefinition, prop)
            if (!resolved || resolved.type !== 'belongsToMany') {
              throw new Error(`[orm] relation '${prop}' did not resolve to a belongsToMany on '${definition.name}'`)
            }
            const relatedModel = getModelFromRegistry(resolved.relatedModelName)
            const relatedDef = relatedModel?.getDefinition?.() || relatedModel?.definition
            if (!relatedDef) {
              throw new Error(`[orm] related model '${resolved.relatedModelName}' is not registered`)
            }
            return new BelongsToManyRelationBuilder(self, definition as ModelDefinition, resolved, relatedDef)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as any
  }

  /** Get the original attributes, creating the snapshot on first access after a mutation. */
  private getOriginalAttributes(): Record<string, unknown> {
    if (this._original === null) this._original = { ...this._attributes }
    return this._original
  }

  get<K extends TSelected>(key: K): K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : never {
    const getter = this._definition.get?.[key as string]
    if (getter) {
      // Defensive: a buggy computed accessor (throws, returns the validator
      // function source, etc.) shouldn't poison every read. Fall back to the
      // raw attribute value so the caller still sees something sensible.
      try {
        const v = getter(this._attributes as Record<string, unknown>)
        if (v !== undefined) return v as any
      }
      catch {
        // fall through to raw attribute
      }
    }
    // _attributes is always snake_case (see normalizeAttributeKeys) — accept
    // either casing from the caller.
    return this._attributes[toSnakeCase(key as string)] as any
  }

  /**
   * Read the raw column value, bypassing any computed `get:` accessor.
   *
   * Use when an accessor's name collides with an attribute (or a global
   * helper, in template engines that auto-import getter-shaped functions
   * by name) and you need the underlying database value.
   */
  getAttribute<K extends TSelected>(key: K): K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown {
    return this._attributes[toSnakeCase(key as string)] as any
  }

  /**
   * Plain-object snapshot of all attribute values. Method form so callers
   * can write `instance.getAttributes()` (Eloquent-style); `instance.attributes`
   * remains as a getter. Both return a shallow copy.
   *
   * **`hidden: true` is not applied here.** This is the raw accessor, and
   * dirty-tracking and diffing need the whole row. Use `toArray()` or
   * `toJSON()` for anything that leaves the process - both redact. Deliberate,
   * unlike the `toArray()` leak in stacksjs/bun-query-builder#1182.
   */
  getAttributes(): Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>> {
    return { ...this._attributes } as any
  }

  set<K extends ColumnName<TDef>>(
    key: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): void {
    // Snapshot original on first mutation (copy-on-write)
    if (this._original === null) this._original = { ...this._attributes }
    // Normalize — _attributes is always snake_case (see normalizeAttributeKeys).
    this._attributes[toSnakeCase(key as string)] = value
  }

  /**
   * Subset of attributes containing only the named columns. Mirrors Lodash
   * `pick` / Laravel's `Collection::only`. Useful for narrowing a model
   * down to a response shape without mutating it. The return type is the
   * exact Pick of the requested keys.
   */
  only<K extends TSelected>(keys: ReadonlyArray<K>): Pick<ModelAttributes<TDef>, K & keyof ModelAttributes<TDef>> {
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      // _attributes is always snake_case (see normalizeAttributeKeys) — accept
      // either casing from the caller, as get()/set() do. Reading the raw key
      // returned undefined for every camelCase column.
      out[k as string] = this._attributes[toSnakeCase(k as string)]
    }
    return out as Pick<ModelAttributes<TDef>, K & keyof ModelAttributes<TDef>>
  }

  /**
   * Inverse of `only` — every attribute *except* the named columns. Use
   * for stripping `password` / `remember_token` etc. without enumerating
   * the rest of the schema. The return type omits the dropped keys.
   */
  except<K extends TSelected>(keys: ReadonlyArray<K>): Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, K> {
    // Compare in the storage casing — _attributes keys are always snake_case.
    const drop = new Set<string>(keys.map(k => toSnakeCase(k as string)))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(this._attributes)) {
      if (!drop.has(k)) out[k] = this._attributes[k]
    }
    return out as Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, K>
  }

  /**
   * Get a loaded relation by name.
   * Returns the related instance(s) if the relation was loaded via .with(),
   * or undefined if the relation wasn't loaded.
   *
   * The relation name is narrowed to the relations declared on the model, and
   * the return type is cardinality-aware: hasMany/belongsToMany relations
   * return an array, hasOne/belongsTo return a single instance or null.
   */
  getRelation<R extends InferRelationNames<TDef> & string>(name: R): LoadedRelationValue<TDef, R> {
    return this._relations[name] as LoadedRelationValue<TDef, R>
  }

  /**
   * Set loaded relation data (used internally by eager loading).
   */
  setRelation(name: string, data: ModelInstance<any, any>[] | ModelInstance<any, any> | null): void {
    this._relations[name] = data
  }

  /**
   * Get all loaded relations.
   */
  getLoadedRelations(): Record<string, ModelInstance<any, any>[] | ModelInstance<any, any> | null> {
    return { ...this._relations }
  }

  get attributes(): Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>> {
    return { ...this._attributes } as any
  }

  get id(): number {
    const pk = this._definition.primaryKey || 'id'
    return this._attributes[pk] as number
  }

  isDirty(column?: ColumnName<TDef>): boolean {
    // If _original is null, no mutations have happened — nothing is dirty
    if (this._original === null) return false
    if (column) {
      // Normalize — _attributes/_original are always snake_case, so a
      // camelCase column name read as undefined on both sides and every
      // isDirty('memberCount') answered false.
      const key = toSnakeCase(column as string)
      return this._attributes[key] !== this._original![key]
    }
    return Object.keys(this._attributes).some(k => this._attributes[k] !== this._original![k])
  }

  isClean(column?: ColumnName<TDef>): boolean {
    return !this.isDirty(column)
  }

  getOriginal<K extends ColumnName<TDef>>(column: K): K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown {
    const orig = this.getOriginalAttributes()
    return orig[toSnakeCase(column as string)] as any
  }

  getChanges(): Partial<InferModelAttributes<TDef>> {
    if (this._original === null) return {} as any // no mutations
    const changes: Record<string, unknown> = {}
    for (const key of Object.keys(this._attributes)) {
      if (this._attributes[key] !== this._original[key]) {
        changes[key] = this._attributes[key]
      }
    }
    return changes as any
  }

  fill(data: FillableAttributes<TDef>): this {
    const attrs = this._definition.attributes
    for (const [key, value] of Object.entries(data)) {
      const attr = findAttributeDef(attrs, key)
      // A `belongsTo`-implied FK column (e.g. `monitor_id`) has no entry in
      // `attrs` at all — only the migration generator infers it, from
      // `belongsTo`, not from `attributes`. Mass assignment already lets
      // `_id`-suffixed keys through its own bypass, so accept them here too
      // rather than silently dropping the update. See the matching sweep
      // in save()'s create branch.
      const isImplicitForeignKey = !attr && toSnakeCase(key).endsWith('_id')
      if ((attr?.fillable && !attr?.guarded) || isImplicitForeignKey) {
        // Snapshot original on first mutation (copy-on-write) — same as
        // set(). Skipping this left getChanges() empty, so a save() after
        // fill()/update() on a clean instance SILENTLY SKIPPED the UPDATE
        // statement while the in-memory instance showed the new values.
        if (this._original === null) this._original = { ...this._attributes }
        // Normalize to snake_case — _attributes is always snake_case (see
        // normalizeAttributeKeys), independent of which casing `key` came
        // in as or which casing the attribute was declared with.
        this._attributes[toSnakeCase(key)] = value
      }
    }
    return this
  }

  forceFill(data: Partial<InferModelAttributes<TDef>>): this {
    if (this._original === null) this._original = { ...this._attributes }
    const normalized = normalizeAttributeKeys(data as Record<string, unknown>)
    Object.assign(this._attributes, normalized)
    // Remember which columns came in through the bypass, so save()'s create
    // branch writes them instead of dropping them as mass-assignment risk.
    for (const col of Object.keys(normalized)) this._forced.add(col)
    return this
  }

  /**
   * The row a create would INSERT, with every create-time rule applied:
   * mutators, declared and implied columns, a supplied key, timestamps, uuid,
   * and the `beforeCreate` hook. Shared by `save()` and `createMany()`, so a
   * bulk insert writes exactly what the same records would one at a time.
   *
   * @internal
   */
  _prepareInsert(): Record<string, unknown> {
    const self = this
    return settle(function* (): Generator<unknown, Record<string, unknown>, unknown> {
      yield* wait(self._applySetters())
      const pk = self._definition.primaryKey || 'id'
      const hooks = self._definition.hooks
      const attrs = self._definition.attributes
      const data: Record<string, unknown> = {}

      // Persist every declared attribute that's explicitly present on the
      // instance — not just `fillable` ones. Previously a non-fillable value
      // set via create() data / .set() / forceFill() (the common case for FK
      // columns like `user_id`) was dropped from the INSERT while remaining on
      // the in-memory instance, desyncing the two and breaking NOT-NULL FKs on
      // Postgres. `guarded` columns stay mass-assignment protected. See #1025.
      for (const [key, attr] of Object.entries(attrs)) {
        // A `guarded` column is dropped from the INSERT unless it was set
        // through `forceFill()`. Without that exception the documented
        // escape hatch did not escape: `forceFill({ apiKey })` on a guarded
        // NOT NULL column threw a constraint error, and on a nullable one it
        // silently wrote NULL. See #1025 for why guarded is filtered at all.
        if (attr.guarded && !self._forced.has(toSnakeCase(key))) continue
        // `attrs` keys are whatever casing the model declared them with
        // (commonly camelCase, e.g. `memberCount`) but `_attributes` is
        // always snake_case (see normalizeAttributeKeys) — same casing a
        // read produces. Normalize the lookup and write the column under
        // its real (snake_case) name, since that's what the table has.
        const col = toSnakeCase(key)
        if (self._attributes[col] !== undefined) {
          data[col] = self._attributes[col]
        }
      }

      // FK columns implied by a `belongsTo` relation (e.g. `monitor_id` on
      // a model that only declares `belongsTo: ['Monitor']`, with no
      // matching entry in `attributes`) are never in `attrs` above — the
      // migration generator infers them from `belongsTo` separately, but
      // that inference doesn't feed back into the runtime attribute map
      // this loop reads. Sweep any `_id`-suffixed key present on the
      // instance that the loop above didn't already pick up. Mass
      // assignment already gated these through its own `_id` bypass (see
      // applyMassAssignmentRules) before the value ever reached
      // `_attributes`, so no further guard is needed here.
      for (const key of Object.keys(self._attributes)) {
        if (key.endsWith('_id') && key !== pk && !(key in data)) {
          data[key] = self._attributes[key]
        }
      }

      // A key the caller supplied is written. Neither loop above picks it up
      // unless the model declares it as an attribute, and a string key has no
      // database default to fall back on.
      const suppliedKey = self._attributes[pk]
      const keyAttr = attrs[pk]
      const keyGuarded = keyAttr?.guarded && !self._forced.has(pk)
      if (suppliedKey != null && !(pk in data) && !keyGuarded)
        data[pk] = suppliedKey

      if (timestampsEnabled(self._definition)) {
        const now = formatNow()
        // An explicitly supplied `created_at` wins.
        //
        // `created_at` is contributed by the timestamps trait, not declared in
        // `attributes`, so the loop above never copies it out of
        // `_attributes` — and this block then wrote `now` unconditionally. A
        // caller that set it deliberately (importing historical records,
        // backfilling a migration, seeding a database whose dates carry
        // meaning) got the insert time instead, silently: the value was
        // accepted, no error was raised, and the row simply came back with the
        // wrong date. Note `update()` honoured the same field, so the two
        // paths disagreed about who owned the column.
        //
        // `updated_at` stays `now` on purpose — the row IS being written right
        // now, and a caller-supplied value there would be describing a write
        // that never happened. Matches the DynamoDB driver's rule, which has
        // always been `if (!item.createdAt) item.createdAt = now`.
        const supplied = self._attributes.created_at
        data.created_at = supplied === undefined || supplied === null ? now : supplied
        data.updated_at = now
      }

      if (self._definition.traits?.useUuid && !data.uuid) {
        data.uuid = crypto.randomUUID()
      }

      yield* wait(hooks?.beforeCreate?.(data))
      return data
    })
  }

  /**
   * Record a completed INSERT on the instance and run `afterCreate`.
   * `generatedKey` is the key the database assigned, when the row did not
   * supply one.
   *
   * @internal
   */
  _markInserted(data: Record<string, unknown>, generatedKey?: unknown): void {
    const self = this
    return settle(function* (): Generator<unknown, void, unknown> {
      const pk = self._definition.primaryKey || 'id'
      for (const [key, value] of Object.entries(data))
        self._attributes[key] = value
      if (!(pk in data) && generatedKey != null)
        self._attributes[pk] = generatedKey
      self._exists = true

      yield* wait(self._definition.hooks?.afterCreate?.(self as unknown as ModelHookInstance))

      self._original = { ...self._attributes }
      self._hasSaved = true
    })
  }

  /**
   * Run the model's `set` mutators over every dirty attribute.
   *
   * A mutator that answers in place is applied in place. One that answers
   * with a promise (a password hash made off the thread) is waited for, and
   * the write it belongs to becomes a promise: what must never happen is the
   * promise itself being bound as the column's value.
   */
  private _applySetters(): void | Promise<void> {
    const self = this
    return settle(function* (): Generator<unknown, void, unknown> {
      const setters = self._definition.set || {}
      for (const [key, setter] of Object.entries(setters)) {
        if (self.isDirty(key as ColumnName<TDef>)) {
          // Write back in the storage casing, or a camelCase mutator would add a
          // second key alongside the column it was meant to replace.
          self._attributes[toSnakeCase(key)] = yield* wait(setter(self._attributes as Record<string, unknown>))
        }
      }
    })
  }

  save(): Written<TDef, this> {
    const self = this
    const answer = settle(function* (): Generator<unknown, typeof self, unknown> {
      const exec = getExecutor()
      const pk = self._definition.primaryKey || 'id'
      const hooks = self._definition.hooks

      if (self._exists) {
        yield* wait(self._applySetters())
        // Update
        yield* wait(hooks?.beforeUpdate?.(self as unknown as ModelHookInstance, self.getChanges()))

        const changes = self.getChanges()
        const changeKeys = Object.keys(changes)
        if (changeKeys.length > 0) {
          // A row read without its key (`select('title')`) cannot be addressed.
          // This used to take the INSERT branch and write a copy of the row.
          if (self._attributes[pk] == null)
            throw new Error(`Cannot save a model without a primary key: '${pk}' was not selected`)
          if (timestampsEnabled(self._definition)) {
            // The write owns updated_at, so a changed one is not sent as well:
            // Postgres refuses a column assigned twice (see managedUpdateSet).
            const { sets, values } = managedUpdateSet(Object.entries(changes), k => k)
            yield* wait(exec.run(
              `UPDATE ${quotedTable(self._definition.table)} SET ${sets} WHERE ${pk} = ?`,
              [...values, self._attributes[pk]]
            ))
          }
          else {
            const sets = changeKeys.map(k => `${quoteSqlColumn(k)} = ?`).join(', ')
            yield* wait(exec.run(`UPDATE ${quotedTable(self._definition.table)} SET ${sets} WHERE ${pk} = ?`, [...Object.values(changes), self._attributes[pk]]))
          }
        }

        yield* wait(hooks?.afterUpdate?.(self as unknown as ModelHookInstance))
      }
      else {
        // Create
        const data = (yield* wait(self._prepareInsert()))
        const columns = Object.keys(data)
        const placeholders = columns.map(() => '?').join(', ')

        const result = (yield* wait(exec.insert(
          `INSERT INTO ${quotedTable(self._definition.table)} (${columns.map(quoteSqlColumn).join(', ')}) VALUES (${placeholders})`,
          Object.values(data),
          pk,
        )))

        // Only a generated key is read back. For a supplied one the driver's
        // insert id is the rowid (SQLite) or 0 (MySQL on a non-AUTO_INCREMENT
        // key), not the key.
        yield* wait(self._markInserted(data, pk in data ? undefined : result.lastInsertId))
        return self
      }

      self._original = { ...self._attributes }
      self._hasSaved = true
      return self
    })
    return answer as unknown as Written<TDef, this>
  }

  update(data: FillableAttributes<TDef>): Written<TDef, this> {
    const self = this
    const answer = settle(function* (): Generator<unknown, typeof self, unknown> {
      self.fill(data)
      yield* wait(self.save())
      return self
    })
    return answer as unknown as Written<TDef, this>
  }

  /**
   * Re-read this row from the database and return a *new* ModelInstance
   * with the latest values. Does NOT mutate the receiver — pair with
   * `.refresh()` if you want in-place update.
   *
   * @returns the freshly-fetched row, or `null` if the row no longer exists.
   */
  fresh(): ModelInstance<TDef, TSelected> | null {
    const self = this
    return settle(function* (): Generator<unknown, ModelInstance<TDef, TSelected> | null, unknown> {
      const exec = getExecutor()
      const pk = self._definition.primaryKey || 'id'
      const id = self._attributes[pk]
      if (id == null) return null
      const row = (yield* wait(exec.get(`SELECT * FROM ${quotedTable(self._definition.table)} WHERE ${pk} = ?`, [id])))
      if (!row) return null
      return new ModelInstance(self._definition, row as Partial<ModelAttributes<TDef>>, true)
    })
  }

  delete(): Written<TDef, boolean> {
    const self = this
    const answer = settle(function* (): Generator<unknown, boolean, unknown> {
      const exec = getExecutor()
      const pk = self._definition.primaryKey || 'id'
      const pkValue = self._attributes[pk]
      const hooks = self._definition.hooks

      // `== null`, not falsy: 0 and '' are primary keys a row can legitimately
      // carry, and rejecting them told the caller the instance had no key at all.
      if (pkValue == null) throw new Error('Cannot delete a model without a primary key')

      yield* wait(hooks?.beforeDelete?.(self as unknown as ModelHookInstance))

      if (softDeletesEnabled(self._definition)) {
        const now = formatNow()
        yield* wait(exec.run(
          `UPDATE ${quotedTable(self._definition.table)} SET deleted_at = ? WHERE ${pk} = ?`,
          [now, pkValue]
        ))
        // Reflect the soft delete on the in-memory instance so `trashed()` and
        // reads of `deleted_at` are consistent without a refresh. See #1024.
        self._attributes[SOFT_DELETE_COLUMN] = now
      }
      else {
        yield* wait(exec.run(`DELETE FROM ${quotedTable(self._definition.table)} WHERE ${pk} = ?`, [pkValue]))
      }

      yield* wait(hooks?.afterDelete?.(self as unknown as ModelHookInstance))

      return true
    })
    return answer as unknown as Written<TDef, boolean>
  }

  /**
   * Delete this row for good, even on a soft-deletable model.
   *
   * `delete()` marks a soft-deletable row instead of removing it, which leaves
   * no way to purge one row through an instance. Delete hooks run either way.
   */
  forceDelete(): Written<TDef, boolean> {
    const self = this
    const answer = settle(function* (): Generator<unknown, boolean, unknown> {
      const pk = self._definition.primaryKey || 'id'
      const pkValue = self._attributes[pk]
      const hooks = self._definition.hooks

      // `== null`, not falsy: 0 and '' are primary keys a row can legitimately
      // carry, and rejecting them told the caller the instance had no key at all.
      if (pkValue == null) throw new Error('Cannot delete a model without a primary key')

      yield* wait(hooks?.beforeDelete?.(self as unknown as ModelHookInstance))
      yield* wait(getExecutor().run(`DELETE FROM ${quotedTable(self._definition.table)} WHERE ${pk} = ?`, [pkValue]))
      yield* wait(hooks?.afterDelete?.(self as unknown as ModelHookInstance))

      return true
    })
    return answer as unknown as Written<TDef, boolean>
  }

  /**
   * Restore a soft-deleted row by clearing `deleted_at`. Throws if the model
   * doesn't use soft deletes. See stacksjs/bun-query-builder#1024.
   */
  restore(): this {
    const self = this
    return settle(function* (): Generator<unknown, typeof self, unknown> {
      if (!softDeletesEnabled(self._definition as ModelDefinition))
        throw new Error(`[orm] restore() requires soft deletes on '${self._definition.name}'`)
      const pk = self._definition.primaryKey || 'id'
      const pkValue = self._attributes[pk]
      if (!pkValue) throw new Error('Cannot restore a model without a primary key')
      yield* wait(getExecutor().run(
        `UPDATE ${quotedTable(self._definition.table)} SET ${SOFT_DELETE_COLUMN} = ? WHERE ${pk} = ?`,
        [null, pkValue],
      ))
      self._attributes[SOFT_DELETE_COLUMN] = null
      self._original = null
      return self
    })
  }

  /** Whether this instance is soft-deleted (has a non-null `deleted_at`). */
  trashed(): boolean {
    return this._attributes[SOFT_DELETE_COLUMN] != null
  }

  /**
   * In-place re-read of this row from the database.
   *
   * - On success: replaces `_attributes` AND clears the dirty snapshot, so
   *   `isDirty()` reports `false` afterwards. Returns `this`.
   * - On missing row: returns `null` instead of leaving the receiver in a
   *   stale state. Callers can `if (!post.refresh()) ...` to handle the
   *   between-fetches-deleted case.
   *
   * Throws only when the receiver has no primary key set.
   */
  refresh(): this | null {
    const self = this
    return settle(function* (): Generator<unknown, typeof self | null, unknown> {
      const exec = getExecutor()
      const pk = self._definition.primaryKey || 'id'
      const pkValue = self._attributes[pk]

      if (!pkValue) throw new Error('Cannot refresh a model without a primary key')

      const row = (yield* wait(exec.get(`SELECT * FROM ${quotedTable(self._definition.table)} WHERE ${pk} = ?`, [pkValue])))
      if (!row) return null
      self._attributes = row
      self._original = null // post-refresh, nothing is dirty
      return self
    })
  }

  /**
   * Create a copy of this model without the primary key (ready to save as new).
   *
   * @example
   * ```ts
   * const original = User.find(1)
   * const copy = original.replicate()
   * copy.set('email', 'new@example.com')
   * copy.save() // inserts as a new record
   * ```
   */
  replicate(): ModelInstance<TDef, TSelected> {
    const pk = this._definition.primaryKey || 'id'
    const attrs = { ...this._attributes }
    delete attrs[pk]
    delete attrs.uuid
    delete attrs.created_at
    delete attrs.updated_at
    return new ModelInstance<TDef, TSelected>(this._definition, attrs as any, false)
  }

  /**
   * The model as a plain object, with `hidden: true` attributes removed.
   *
   * It used to spread `_attributes` whole, so a `password` or `api_token`
   * marked hidden came out in full while `toJSON()`, written directly beneath
   * it, redacted the same field. Two serializers side by side with opposite
   * behaviour is the trap: this API takes its names from Eloquent, where
   * `toArray()` applies `$hidden` and `toJSON()` is defined in terms of it, so
   * the expectation someone arrives with is the wrong one. Relations are
   * serialized through `toArray()` too, which propagated the leak into every
   * eager-loaded payload - the same shape as #1093.
   *
   * `toJSON()` now delegates here, so the two cannot drift apart again.
   * stacksjs/bun-query-builder#1182
   */
  toArray(): Record<string, unknown> {
    const hidden = new Set<string>()
    for (const [key, attr] of Object.entries(this._definition.attributes)) {
      if (attr.hidden)
        hidden.add(key)
    }

    const values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this._attributes)) {
      if (!hidden.has(key))
        values[key] = value
    }

    for (const [relName, relData] of Object.entries(this._relations)) {
      if (Array.isArray(relData)) {
        values[relName] = relData.map(r => r.toArray())
      }
      else if (relData) {
        values[relName] = relData.toArray()
      }
      else {
        values[relName] = null
      }
    }

    return values
  }

  /**
   * Delegates to {@link toArray}, which applies the same `hidden` filter and
   * serializes relations the same way. Kept as one implementation so the two
   * cannot diverge again - they already had, and only `toJSON()` was redacting.
   * stacksjs/bun-query-builder#1182
   */
  toJSON(): Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, HiddenKeys<TDef>> {
    return this.toArray() as any
  }

}

// Memoization caches for hot-path string conversions and query plans
const snakeCaseCache = new Map<string, string>()
const tableNameCache = new Map<string, string>()
const relationCache = new Map<string, ReturnType<typeof resolveRelation>>()
// Cache keys include the caller-supplied relation name (`Model:relation`), so
// arbitrary/dynamic relation strings (e.g. from request params) would grow the
// map without bound. Declared relations in any real app number far below this.
const RELATION_CACHE_MAX = 1000

/**
 * A caller-supplied column name rendered in its real column casing.
 *
 * `ColumnName<TDef>` admits an attribute in the casing it was declared in AND
 * its snake_case form, because the migration generator snake_cases every
 * column name and `_attributes` is normalized the same way. The SQL builders
 * interpolated the caller's spelling verbatim, so `.where('activityType', …)`
 * type-checked and then failed at runtime with "no such column". Applied at
 * every point a column name reaches SQL.
 *
 * `table.column` (accepted by orderBy) survives: `.` is untouched by
 * `toSnakeCase`, so each side is converted independently.
 */
function sqlColumn(name: string): string {
  return toSnakeCase(name)
}

/**
 * A column reference as it is written into a statement.
 *
 * Delegates to {@link quoteIdentifierForDialect}, which `client.ts` uses for
 * the same job: the rule (back-quote everything on MySQL, quote only
 * ANSI_RESERVED_WORDS on SQLite and Postgres) and the word list used to live
 * here, and the two builders disagreed about which identifiers they would
 * quote. See #1207 and the header of `sql-fragments.ts`.
 */
function quoteSqlColumn(name: string): string {
  return quoteIdentifierForDialect(name, config.dialect)
}

/** `sqlColumn`, quoted for the dialect: what WHERE, ORDER BY, SELECT and SET interpolate. */
function quotedColumn(name: string): string {
  return quoteSqlColumn(sqlColumn(name))
}

/**
 * A table reference as a statement writes it.
 *
 * Tables take the same rule as columns ({@link quoteSqlColumn}): a model is
 * entitled to be backed by a table named `order` or `group`, or — Postgres
 * reserves it, SQLite does not — `user`. The migration drivers have quoted
 * table names all along (`SQLiteDriver.createTable` and its siblings), so the
 * generator would create a `"user"` table that every statement here then
 * failed to address: `near "order": syntax error` on each read and write, and
 * on Postgres a `table: 'user'` model that no query could touch. See #1207.
 *
 * NOT snake-cased on the way through, unlike `quotedColumn`: a table name is
 * taken from the definition verbatim (`table: 'user_profiles'`), and
 * `toTableName` has already done the conversion where one was derived from a
 * model name.
 */
function quotedTable(name: string): string {
  return quoteSqlColumn(name)
}

/**
 * Convert PascalCase model name to snake_case for foreign key convention.
 * e.g., 'OrderItem' -> 'order_item', 'User' -> 'user'
 */
function toSnakeCase(str: string): string {
  let cached = snakeCaseCache.get(str)
  if (cached !== undefined) return cached
  cached = str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
  snakeCaseCache.set(str, cached)
  return cached
}

/**
 * Convert PascalCase model name to its conventional table name (snake_case, pluralized).
 * e.g., 'OrderItem' -> 'order_items', 'User' -> 'users', 'Category' -> 'categories'
 */
function toTableName(modelName: string): string {
  let cached = tableNameCache.get(modelName)
  if (cached !== undefined) return cached
  // Delegated rather than re-implemented: this convention lived here AND, in a
  // naive `toLowerCase() + 's'` form, in the schema, meta and migration
  // layers, so a model without an explicit `table` was read from one table and
  // migrated into another. One implementation is what keeps them from drifting
  // apart again; the cache stays, since this is on the hot path.
  cached = sharedToTableName(modelName)
  tableNameCache.set(modelName, cached)
  return cached
}

/**
 * Resolve a relation from its name and the parent model's definition.
 * Uses the model registry to find the related model's definition.
 *
 * Supports both syntaxes:
 *   Array syntax:  hasMany: ['Order']        → relation name is 'order', model is 'Order'
 *   Object syntax: hasMany: { orders: 'Order' } → relation name is 'orders', model is 'Order'
 */
/**
 * Resolved-relation shape returned by `resolveRelation`. Pivot fields are
 * populated only for `belongsToMany` relations.
 */
interface ResolvedRelation {
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany' | 'hasManyThrough' | 'hasOneThrough' | 'morphMany' | 'morphOne'
  relatedModelName: string
  relatedTable: string
  foreignKey: string
  localKey: string
  /** Intermediate table name (has*Through only). */
  throughTable?: string
  /** FK on the through table pointing at the parent (has*Through only). */
  throughForeignKey?: string
  /** PK on the through table (has*Through only). */
  throughLocalKey?: string
  /** FK on the target table pointing at the through table (has*Through only). */
  targetForeignKey?: string
  /** Pivot table name (belongsToMany only). */
  pivotTable?: string
  /** FK on pivot pointing at the parent (belongsToMany only). */
  pivotFkParent?: string
  /** FK on pivot pointing at the related model (belongsToMany only). */
  pivotFkRelated?: string
  /**
   * The `<morphName>_type` column, and what the parent writes into it
   * (morph* only).
   *
   * A polymorphic child is a `hasMany` whose foreign key is shared with other
   * parent tables, so the type column is what keeps one parent's rows from
   * being handed to another's. The VALUE is the parent's TABLE name, which is
   * the convention the framework's own polymorphic traits already write -
   * `taggable_type: tableName` - so a model can be related to rows those traits
   * created.
   */
  morphTypeColumn?: string
  morphTypeValue?: string
  /** Declared pivot column names — excludes the two FKs (belongsToMany only). */
  pivotColumns?: string[]
  /** Pivot model name when declared via `through:` (Option B). */
  pivotModelName?: string
  /** Whether the pivot tracks `created_at`/`updated_at`. */
  pivotTimestamps?: boolean
}

/**
 * Relation kinds `resolveRelation` can actually resolve, and the ones a model
 * may declare. `ModelDefinition` accepts considerably more than the resolver
 * implements, which is the more confusing half of the silent-miss problem
 * below: a `morphMany` is accepted by the types, encouraged by autocomplete,
 * and then does nothing at all.
 */
const RESOLVABLE_RELATION_KINDS = ['hasMany', 'hasOne', 'belongsTo', 'belongsToMany', 'morphMany', 'morphOne'] as const
const DECLARABLE_RELATION_KINDS = [
  ...RESOLVABLE_RELATION_KINDS,
  'hasOneThrough',
  'hasManyThrough',
  'morphOne',
  'morphMany',
  'morphTo',
  'morphToMany',
  'morphedByMany',
] as const

/** Every relation name declared under `kind`, in declaration order. */
function relationNamesFor(definition: ModelDefinition, kind: string): string[] {
  const rel = (definition as unknown as Record<string, unknown>)[kind]
  if (!rel)
    return []
  if (Array.isArray(rel))
    return rel.map((item) => {
      const entry = normalizeRelationEntry(item)
      return entry?.relationName ?? entry?.model ?? ''
    }).filter(Boolean)
  if (typeof rel === 'object')
    return Object.keys(rel as Record<string, unknown>)
  if (typeof rel === 'string')
    return [rel]
  return []
}

/**
 * Why an eager load found nothing, phrased for the person who typed the name.
 *
 * `eagerLoadRelation` used to `return` here. A misspelled relation loaded
 * nothing and said nothing — indistinguishable from a relation that genuinely
 * has no rows — and so did every relation kind the resolver does not implement.
 * Both are mistakes worth surfacing, and they need different wording: one is a
 * typo, the other is a gap in this library that no amount of squinting at the
 * model will explain.
 */
function unresolvedRelationMessage(definition: ModelDefinition, relationName: string): string {
  const model = definition.name ?? definition.table ?? 'model'

  const declaredUnder = DECLARABLE_RELATION_KINDS.filter(kind =>
    relationNamesFor(definition, kind).some(n => n.toLowerCase() === relationName.toLowerCase()),
  )
  const unsupported = declaredUnder.filter(k => !(RESOLVABLE_RELATION_KINDS as readonly string[]).includes(k))

  if (unsupported.length > 0) {
    return `[orm] '${model}' declares '${relationName}' as ${unsupported.join('/')}, which eager loading does not support yet. `
      + `Supported kinds: ${RESOLVABLE_RELATION_KINDS.join(', ')}. `
      + `Load it with a manual query for now — see stacksjs/bun-query-builder#1068.`
  }

  const available = RESOLVABLE_RELATION_KINDS.flatMap(kind => relationNamesFor(definition, kind))
  return available.length > 0
    ? `[orm] '${model}' has no relation '${relationName}'. Available: ${available.join(', ')}.`
    : `[orm] '${model}' has no relation '${relationName}' — it declares no relations at all.`
}

function resolveRelation(definition: ModelDefinition, relationName: string): ResolvedRelation | null {
  const parentName = definition.name
  const parentTable = definition.table
  const parentPk = definition.primaryKey || 'id'

  /**
   * Search a relation field for a matching relation name.
   * Handles both array format (['Order']) and object format ({ orders: 'Order' }).
   * Returns the model name if found, or null otherwise.
   */
  function findModelName(
    rel: readonly (string | object)[] | Readonly<Record<string, string | object>> | undefined,
  ): string | null {
    if (!rel) return null

    // Array syntax: hasMany: ['Order'] → relation name is lowercased model name
    if (Array.isArray(rel)) {
      for (const item of rel) {
        const entry = normalizeRelationEntry(item)
        if (entry && (entry.relationName ?? entry.model).toLowerCase() === relationName.toLowerCase()) {
          return entry.model
        }
      }
      return null
    }

    // Object syntax: hasMany: { orders: 'Order' } → relation name is the key
    if (typeof rel === 'object') {
      for (const [key, value] of Object.entries(rel)) {
        if (key === relationName || key.toLowerCase() === relationName.toLowerCase()) {
          return typeof value === 'string' ? value : (value as any)?.model || (value as any)?.target || key
        }
      }
    }

    return null
  }

  /**
   * The raw `belongsTo` entry for this relation name, so the resolver can read
   * a custom `foreignKey`. `findModelName` flattens the entry down to a model
   * name, which threw away the FK override the migration generator honors
   * (see `normalizeRelationEntry`) — eager loading a belongsTo declared as
   * `{ owner: { model: 'User', foreignKey: 'owner_id' } }` queried a
   * non-existent `user_id` column.
   */
  function findBelongsToEntry(): { model: string, foreignKey?: string } | null {
    const rel = definition.belongsTo
    if (!rel) return null
    const lower = relationName.toLowerCase()
    const unwrap = (entry: unknown): { model: string, foreignKey?: string } | null => {
      if (typeof entry === 'string') return { model: entry }
      if (entry && typeof entry === 'object' && typeof (entry as any).model === 'string')
        return { model: (entry as any).model, foreignKey: (entry as any).foreignKey }
      return null
    }
    if (Array.isArray(rel)) {
      // Array form: an explicit alias wins; otherwise use the model name.
      for (const item of rel) {
        const e = unwrap(item)
        if (e && (normalizeRelationEntry(item)?.relationName ?? e.model).toLowerCase() === lower) return e
      }
      return null
    }
    if (typeof rel === 'object') {
      // Record form: the relation name is the key.
      for (const [key, value] of Object.entries(rel)) {
        if (key === relationName || key.toLowerCase() === lower) return unwrap(value)
      }
    }
    return null
  }

  /** Find the BelongsToManyConfig object (if any) for this relation. */
  function findBelongsToManyEntry():
    | { entry: string | { model: string, through?: string, table?: string, foreignKey?: string, relatedKey?: string, pivot?: { columns?: Record<string, any>, timestamps?: boolean, uniques?: string[][] } } }
    | null {
    const rel = definition.belongsToMany
    if (!rel) return null
    if (Array.isArray(rel)) {
      for (const item of rel) {
        if (typeof item === 'string') {
          if (item.toLowerCase() === relationName.toLowerCase()) return { entry: item }
        }
        else if (item && typeof item === 'object' && (item as any).model) {
          if (((item as any).model as string).toLowerCase() === relationName.toLowerCase()) return { entry: item as any }
        }
      }
      return null
    }
    if (typeof rel === 'object') {
      for (const [key, value] of Object.entries(rel)) {
        if (key === relationName || key.toLowerCase() === relationName.toLowerCase()) {
          return { entry: value as any }
        }
      }
    }
    return null
  }

  /**
   * The morph name a polymorphic relation writes its columns under.
   *
   * Declared explicitly (`{ model: 'Comment', morphName: 'commentable' }`), or
   * derived from the relation name the way Laravel does - the relation IS the
   * morph name for a record-form declaration like
   * `morphMany: { commentable: 'Comment' }`.
   */
  function findMorphEntry(kind: 'morphMany' | 'morphOne'): { model: string, morphName: string } | null {
    const rel = (definition as unknown as Record<string, unknown>)[kind]
    if (!rel)
      return null

    const lower = relationName.toLowerCase()

    if (Array.isArray(rel)) {
      for (const item of rel) {
        const model = typeof item === 'string' ? item : String((item as any)?.model ?? '')
        if (!model || model.toLowerCase() !== lower)
          continue
        const declared = typeof item === 'object' ? (item as any)?.morphName : undefined
        // No declared name: fall back to the parent's own morph name, which is
        // what a single-parent polymorphic table is usually keyed by.
        return { model, morphName: String(declared ?? `${toSnakeCase(parentName)}able`) }
      }
      return null
    }

    if (typeof rel === 'object') {
      for (const [key, value] of Object.entries(rel as Record<string, unknown>)) {
        const model = typeof value === 'string' ? value : String((value as any)?.model ?? '')
        if (key.toLowerCase() !== lower && model.toLowerCase() !== lower)
          continue
        const declared = typeof value === 'object' ? (value as any)?.morphName : undefined
        return { model, morphName: String(declared ?? key) }
      }
    }

    return null
  }

  for (const kind of ['morphMany', 'morphOne'] as const) {
    const entry = findMorphEntry(kind)
    if (!entry)
      continue

    const relatedModel = getModelFromRegistry(entry.model)
    const relatedTable = relatedModel?.getTable?.() || toTableName(entry.model)

    return {
      type: kind,
      relatedModelName: entry.model,
      relatedTable,
      foreignKey: `${entry.morphName}_id`,
      localKey: parentPk,
      morphTypeColumn: `${entry.morphName}_type`,
      // The parent's TABLE, matching what the polymorphic traits write.
      morphTypeValue: parentTable,
    }
  }

  // Check hasMany
  const hasManyModel = findModelName(definition.hasMany)
  if (hasManyModel) {
    const relatedModel = getModelFromRegistry(hasManyModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(hasManyModel)
    const foreignKey = toSnakeCase(parentName) + '_id'
    return { type: 'hasMany', relatedModelName: hasManyModel, relatedTable, foreignKey, localKey: parentPk }
  }

  // Check hasOne
  const hasOneModel = findModelName(definition.hasOne)
  if (hasOneModel) {
    const relatedModel = getModelFromRegistry(hasOneModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(hasOneModel)
    const foreignKey = toSnakeCase(parentName) + '_id'
    return { type: 'hasOne', relatedModelName: hasOneModel, relatedTable, foreignKey, localKey: parentPk }
  }

  // Check belongsTo
  const belongsToEntry = findBelongsToEntry()
  if (belongsToEntry) {
    const belongsToModel = belongsToEntry.model
    const relatedModel = getModelFromRegistry(belongsToModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(belongsToModel)
    const relatedPk = relatedModel?.getDefinition?.()?.primaryKey || 'id'
    // An explicit `foreignKey` wins — same precedence the migration generator
    // uses, so the column the resolver queries is the column that was created.
    const foreignKey = belongsToEntry.foreignKey || `${toSnakeCase(belongsToModel)}_id`
    return { type: 'belongsTo', relatedModelName: belongsToModel, relatedTable, foreignKey, localKey: relatedPk }
  }

  // Check belongsToMany — supports Option A (inline pivot) and Option B (`through:`).
  const found = findBelongsToManyEntry()
  if (found) {
    const isConfig = typeof found.entry === 'object'
    const relatedModelName = isConfig ? (found.entry as any).model : (found.entry as string)
    const relatedModel = getModelFromRegistry(relatedModelName)
    const relatedTable = relatedModel?.getTable?.() || toTableName(relatedModelName)
    const config: any = isConfig ? found.entry : null

    // Pivot table: explicit > through-model.table > legacy [a,b].sort().join('_')
    let pivotTable: string
    let pivotModelName: string | undefined
    if (config?.table) {
      pivotTable = config.table
    }
    else if (config?.through) {
      pivotModelName = config.through
      const throughModel = getModelFromRegistry(config.through)
      if (!throughModel) {
        throw new Error(`[orm] belongsToMany relation '${relationName}' on '${parentName}' references unknown through model '${config.through}'. Make sure '${config.through}' is registered.`)
      }
      pivotTable = throughModel.getTable?.() || throughModel.getDefinition?.()?.table || toTableName(config.through)
    }
    else {
      const a = singularizeWord(parentTable)
      const b = singularizeWord(relatedTable)
      pivotTable = [a, b].sort().join('_')
    }

    const pivotFkParent = config?.foreignKey || `${singularizeWord(parentTable)}_id`
    const pivotFkRelated = config?.relatedKey || `${singularizeWord(relatedTable)}_id`

    // Pivot columns from inline config + (when applicable) the through model.
    const pivotColumns: string[] = []
    if (config?.pivot?.columns) {
      for (const k of Object.keys(config.pivot.columns)) pivotColumns.push(k)
    }
    if (pivotModelName) {
      const throughModel = getModelFromRegistry(pivotModelName)
      const throughDef = throughModel?.getDefinition?.() || throughModel?.definition
      const attrs = throughDef?.attributes ?? {}
      const throughPk = throughDef?.primaryKey ?? 'id'
      for (const k of Object.keys(attrs)) {
        if (k === pivotFkParent || k === pivotFkRelated || k === throughPk) continue
        if (!pivotColumns.includes(k)) pivotColumns.push(k)
      }
    }

    return {
      type: 'belongsToMany',
      relatedModelName,
      relatedTable,
      foreignKey: pivotFkParent,
      localKey: parentPk,
      pivotTable,
      pivotFkParent,
      pivotFkRelated,
      pivotColumns,
      pivotModelName,
      pivotTimestamps: Boolean(config?.pivot?.timestamps),
    }
  }

  // Check hasOneThrough / hasManyThrough. Declared as
  // `{ <relation>: { through: ThroughModel, target: TargetModel } }`.
  // Chain: parent.pk → through.<singular(parent)>_id, through.pk →
  // target.<singular(through)>_id. Mirrors the JOIN convention used by the
  // schema-level builder's `.with()`.
  const resolveThrough = (
    field: unknown,
    type: 'hasOneThrough' | 'hasManyThrough',
  ): ResolvedRelation | null => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null
    const entry = (field as Record<string, any>)[relationName]
      ?? (field as Record<string, any>)[Object.keys(field as object).find(k => k.toLowerCase() === relationName.toLowerCase()) ?? '']
    if (!entry || typeof entry !== 'object') return null
    const throughModelName: string = entry.through
    const targetModelName: string = entry.target
    if (!throughModelName || !targetModelName) return null

    const throughModel = getModelFromRegistry(throughModelName)
    const throughDef = throughModel?.getDefinition?.() || throughModel?.definition
    const throughTable = throughModel?.getTable?.() || throughDef?.table || toTableName(throughModelName)
    const throughPk = throughDef?.primaryKey || 'id'

    const targetModel = getModelFromRegistry(targetModelName)
    const targetTable = targetModel?.getTable?.() || toTableName(targetModelName)

    return {
      type,
      relatedModelName: targetModelName,
      relatedTable: targetTable,
      foreignKey: `${toSnakeCase(parentName)}_id`, // unused for through, kept for shape
      localKey: parentPk,
      throughTable,
      throughForeignKey: `${toSnakeCase(parentName)}_id`, // FK on through → parent
      throughLocalKey: throughPk,
      targetForeignKey: `${singularizeWord(throughTable)}_id`, // FK on target → through
    }
  }

  const hmt = resolveThrough(definition.hasManyThrough, 'hasManyThrough')
  if (hmt) return hmt
  const hot = resolveThrough(definition.hasOneThrough, 'hasOneThrough')
  if (hot) return hot

  return null
}

/**
 * The distinct, non-null primary keys of a hydrated result set.
 *
 * These become the `IN (...)` list of an eager-load batch query, so duplicates
 * are pure waste: a page whose parent ids repeat sent one placeholder and one
 * bound parameter per ROW rather than per distinct value, and made the database
 * dedupe them again. Single pass, no intermediate arrays — the belongsTo branch
 * already worked this way.
 */
function distinctParentIds(instances: ReadonlyArray<{ get: (key: any) => unknown }>, pk: string): unknown[] {
  const seen = new Set<unknown>()
  for (const i of instances) {
    const v = i.get(pk)
    if (v != null) seen.add(v)
  }
  return [...seen]
}

/** Singularize a table name for FK derivation, honoring the configured strategy. */
function singularizeWord(table: string): string {
  return singularizerFor(config.relations?.singularizeStrategy)(table)
}

/**
 * # `BelongsToManyRelationBuilder`
 *
 * Per-instance relation builder returned by callable accessors on a
 * `ModelInstance`. Combines a query side (read pivot-joined related rows,
 * filter by pivot columns) with a mutation side (attach/detach/sync/
 * updateExistingPivot/toggle).
 *
 * Constructed lazily — `coach.athletes` returns a function that, when called,
 * returns a fresh builder; chained methods return `this` so a single builder
 * is reused per call.
 */
export class BelongsToManyRelationBuilder<TRel extends ModelDefinition> {
  private _parent: ModelInstance<any, any>
  private _parentDef: ModelDefinition
  private _resolved: ResolvedRelation
  private _relatedDef: TRel
  private _wheres: { sql: string, params: unknown[] }[] = []
  private _pivotWheres: { sql: string, params: unknown[] }[] = []
  private _orderBy: string[] = []
  private _limit?: number
  private _offset?: number

  constructor(parent: ModelInstance<any, any>, parentDef: ModelDefinition, resolved: ResolvedRelation, relatedDef: TRel) {
    this._parent = parent
    this._parentDef = parentDef
    this._resolved = resolved
    this._relatedDef = relatedDef
  }

  private get parentId(): unknown {
    const pk = this._parentDef.primaryKey || 'id'
    return (this._parent as any).get(pk)
  }

  private get pivotTable(): string { return this._resolved.pivotTable! }
  private get fkParent(): string { return this._resolved.pivotFkParent! }
  private get fkRelated(): string { return this._resolved.pivotFkRelated! }
  private get relatedTable(): string { return this._resolved.relatedTable }
  private get relatedPk(): string { return this._relatedDef.primaryKey || 'id' }

  // --- query side -----------------------------------------------------------

  /**
   * Filter by a column on the related table.
   *
   * Both slots are validated. The SQL below already qualifies the column with
   * the table, so it must be a bare name, and the operator is interpolated
   * raw. Unvalidated, the column slot escaped the relation's own parent
   * scope: `wherePivot("role = 'primary' OR 1=1 OR role", 'primary')` returned
   * another parent's rows, with the placeholder count preserved so nothing
   * downstream noticed. `orderBy` below has validated since stacksjs/stacks#1858;
   * this family was left out.
   */
  where(column: string, opOrValue: unknown, value?: unknown): this {
    assertValidIdentifier(column, 'where(column)')
    if (value === undefined) {
      this._wheres.push({ sql: `${quotedTable(this.relatedTable)}.${quoteSqlColumn(column)} = ?`, params: [opOrValue] })
    }
    else {
      const op = assertValidComparisonOperator(opOrValue, 'where(operator)')
      this._wheres.push({ sql: `${quotedTable(this.relatedTable)}.${quoteSqlColumn(column)} ${op} ?`, params: [value] })
    }
    return this
  }

  /** Filter by a column on the pivot table. */
  wherePivot(column: string, opOrValue: unknown, value?: unknown): this {
    assertValidIdentifier(column, 'wherePivot(column)')
    if (value === undefined) {
      this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} = ?`, params: [opOrValue] })
    }
    else {
      const op = assertValidComparisonOperator(opOrValue, 'wherePivot(operator)')
      this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} ${op} ?`, params: [value] })
    }
    return this
  }

  wherePivotIn(column: string, values: unknown[]): this {
    assertValidIdentifier(column, 'wherePivotIn(column)')
    if (!values.length) return this
    const placeholders = values.map(() => '?').join(', ')
    this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} IN (${placeholders})`, params: [...values] })
    return this
  }

  wherePivotNotIn(column: string, values: unknown[]): this {
    assertValidIdentifier(column, 'wherePivotNotIn(column)')
    if (!values.length) return this
    const placeholders = values.map(() => '?').join(', ')
    this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} NOT IN (${placeholders})`, params: [...values] })
    return this
  }

  wherePivotNull(column: string): this {
    assertValidIdentifier(column, 'wherePivotNull(column)')
    this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} IS NULL`, params: [] })
    return this
  }

  wherePivotNotNull(column: string): this {
    assertValidIdentifier(column, 'wherePivotNotNull(column)')
    this._pivotWheres.push({ sql: `${quotedTable(this.pivotTable)}.${quoteSqlColumn(column)} IS NOT NULL`, params: [] })
    return this
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    assertValidOrderByColumn(column, 'orderBy(column)')
    if (direction !== 'asc' && direction !== 'desc')
      throw new TypeError(`[bun-query-builder] orderBy(direction): expected 'asc' or 'desc', got '${direction}'`)
    // assertValidOrderByColumn accepts a qualified `table.column`, which
    // quoteSqlColumn splits and quotes on each side.
    this._orderBy.push(`${quoteSqlColumn(column)} ${direction.toUpperCase()}`)
    return this
  }

  limit(n: number): this {
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
      throw new TypeError(`[bun-query-builder] limit(n): expected non-negative integer, got ${n}`)
    this._limit = n
    return this
  }

  offset(n: number): this {
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
      throw new TypeError(`[bun-query-builder] offset(n): expected non-negative integer, got ${n}`)
    this._offset = n
    return this
  }

  /** Build the SELECT SQL for query-side execution. */
  /** All known columns of the related model (pk + attributes + trait columns). */
  private relatedSelectColumns(): string[] {
    const cols = new Set<string>([this.relatedPk, ...Object.keys(this._relatedDef.attributes ?? {})])
    const t = this._relatedDef.traits
    if (t?.useTimestamps || t?.timestampable) {
      cols.add('created_at')
      cols.add('updated_at')
    }
    if (t?.useSoftDeletes || t?.softDeletable) cols.add('deleted_at')
    if (t?.useUuid) cols.add('uuid')
    return [...cols]
  }

  private buildSelect(): { sql: string, params: unknown[] } {
    const params: unknown[] = []
    // Alias the related columns (`related.col AS __btm_rel__col`) and keep
    // `pivot.*`, so a same-named pivot column can't overwrite a related one.
    // Aliasing the related side avoids depending on the pivot's declared
    // columns (empty for `through:` models). See #1036.
    const relatedSelect = this.relatedSelectColumns()
      .map(c => `${quotedTable(this.relatedTable)}.${quoteSqlColumn(c)} AS ${BTM_RELATED_ALIAS}${c}`)
      .join(', ')
    let sql = `SELECT ${relatedSelect}, ${quotedTable(this.pivotTable)}.* FROM ${quotedTable(this.relatedTable)}`
    sql += ` INNER JOIN ${quotedTable(this.pivotTable)} ON ${quotedTable(this.pivotTable)}.${quoteSqlColumn(this.fkRelated)} = ${quotedTable(this.relatedTable)}.${quoteSqlColumn(this.relatedPk)}`
    sql += ` WHERE ${quotedTable(this.pivotTable)}.${quoteSqlColumn(this.fkParent)} = ?`
    params.push(this.parentId)
    for (const w of this._pivotWheres) {
      sql += ` AND ${w.sql}`
      params.push(...w.params)
    }
    for (const w of this._wheres) {
      sql += ` AND ${w.sql}`
      params.push(...w.params)
    }
    if (this._orderBy.length > 0) sql += ` ORDER BY ${this._orderBy.join(', ')}`
    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`
    return { sql, params }
  }

  /** Hydrate raw rows into related ModelInstances with `.pivot` extras. */
  private hydrateRows(rows: Record<string, unknown>[]): ModelInstance<TRel, any>[] {
    // Related columns are uniquely aliased (`__btm_rel__col`); everything else
    // is a pivot column (minus the two FKs). See #1036.
    const fkParent = this.fkParent
    const fkRelated = this.fkRelated
    return rows.map((raw) => {
      const relatedRow: Record<string, unknown> = {}
      const pivotExtras: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith(BTM_RELATED_ALIAS))
          relatedRow[k.slice(BTM_RELATED_ALIAS.length)] = v
        else if (k !== fkParent && k !== fkRelated)
          pivotExtras[k] = v
      }
      const inst = new ModelInstance(this._relatedDef, relatedRow as any, true)
      ;(inst as any).pivot = pivotExtras
      return inst
    })
  }

  get(): ModelInstance<TRel, any>[] {
    const self = this
    return settle(function* (): Generator<unknown, ModelInstance<TRel, any>[], unknown> {
      const exec = getExecutor()
      const { sql, params } = self.buildSelect()
      const rows = (yield* wait(exec.all(sql, params)))
      return self.hydrateRows(rows)
    })
  }

  first(): ModelInstance<TRel, any> | undefined {
    const self = this
    return settle(function* (): Generator<unknown, ModelInstance<TRel, any> | undefined, unknown> {
      self._limit = 1
      return ((yield* wait(self.get())))[0]
    })
  }

  count(): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      let sql = `SELECT COUNT(*) as count FROM ${quotedTable(self.pivotTable)} WHERE ${quoteSqlColumn(self.fkParent)} = ?`
      const params: unknown[] = [self.parentId]
      for (const w of self._pivotWheres) {
        sql += ` AND ${w.sql}`
        params.push(...w.params)
      }
      const row = (yield* wait(exec.get(sql, params)))
      return Number((row as { count: number } | undefined)?.count ?? 0)
    })
  }

  exists(): boolean {
    const self = this
    return settle(function* (): Generator<unknown, boolean, unknown> {
      return ((yield* wait(self.count()))) > 0
    })
  }

  // --- mutation side --------------------------------------------------------

  private now(): string { return formatNow() }

  /**
   * Attach one or more related rows to the parent. `extras` populate any
   * declared pivot columns (Option A `pivot.columns` or Option B through-model
   * attributes). Timestamps are auto-filled when `pivot.timestamps: true`.
   *
   * Returns the count of inserted rows.
   */
  attach(idOrIds: unknown | unknown[], extras: Record<string, unknown> = {}): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
      if (ids.length === 0) return 0
      const ts = self._resolved.pivotTimestamps ? self.now() : null
      let inserted = 0
      for (const relatedId of ids) {
        const row: Record<string, unknown> = {
          [self.fkParent]: self.parentId,
          [self.fkRelated]: relatedId,
          ...extras,
        }
        if (ts) {
          if (row.created_at === undefined) row.created_at = ts
          if (row.updated_at === undefined) row.updated_at = ts
        }
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        const sql = `INSERT INTO ${quotedTable(self.pivotTable)} (${cols.map(quoteSqlColumn).join(', ')}) VALUES (${placeholders})`
        const params = cols.map(c => row[c])
        yield* wait(exec.run(sql, params))
        inserted++
      }
      return inserted
    })
  }

  /**
   * Detach related rows from the parent. With no argument, detaches all.
   * Returns the count of deleted rows.
   */
  detach(idOrIds?: unknown | unknown[]): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      let sql = `DELETE FROM ${quotedTable(self.pivotTable)} WHERE ${quoteSqlColumn(self.fkParent)} = ?`
      const params: unknown[] = [self.parentId]
      if (idOrIds !== undefined && idOrIds !== null) {
        const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
        if (ids.length === 0) return 0
        const placeholders = ids.map(() => '?').join(', ')
        sql += ` AND ${quoteSqlColumn(self.fkRelated)} IN (${placeholders})`
        params.push(...ids)
      }
      return ((yield* wait(exec.run(sql, params)))).changes
    })
  }

  /**
   * Update extras on an existing pivot row, identified by the related id.
   * Returns the number of pivot rows updated (0 or 1).
   */
  updateExistingPivot(relatedId: unknown, extras: Record<string, unknown>): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      const updates = { ...extras }
      if (self._resolved.pivotTimestamps && updates.updated_at === undefined) {
        updates.updated_at = self.now()
      }
      const cols = Object.keys(updates)
      if (cols.length === 0) return 0
      const setClause = cols.map(c => `${quoteSqlColumn(c)} = ?`).join(', ')
      const sql = `UPDATE ${quotedTable(self.pivotTable)} SET ${setClause} WHERE ${quoteSqlColumn(self.fkParent)} = ? AND ${quoteSqlColumn(self.fkRelated)} = ?`
      const params = [...cols.map(c => updates[c]), self.parentId, relatedId]
      return ((yield* wait(exec.run(sql, params)))).changes
    })
  }

  /**
   * Reconcile the pivot to exactly match `items`. Pivot rows whose related id
   * is missing from `items` are detached; rows that exist remain (and are
   * updated when extras differ); rows that don't yet exist are attached.
   *
   * `items` may be a list of plain ids (no extras) or `{ id, ...extras }`
   * objects.
   */
  sync(items: Array<unknown | { id: unknown, [key: string]: unknown }>): { attached: unknown[], detached: unknown[], updated: unknown[] } {
    const self = this
    return settle(function* (): Generator<unknown, { attached: unknown[], detached: unknown[], updated: unknown[] }, unknown> {
      const exec = getExecutor()
      const desired = new Map<unknown, Record<string, unknown>>()
      for (const item of items) {
        if (item != null && typeof item === 'object' && 'id' in (item as any)) {
          const { id, ...extras } = item as { id: unknown, [key: string]: unknown }
          desired.set(id, extras)
        }
        else {
          desired.set(item, {})
        }
      }

      // Read current pivot rows for this parent.
      const current = (yield* wait(exec.all(
        `SELECT * FROM ${quotedTable(self.pivotTable)} WHERE ${quoteSqlColumn(self.fkParent)} = ?`,
        [self.parentId],
      )))
      const currentIds = new Set(current.map(r => r[self.fkRelated]))

      const attached: unknown[] = []
      const detached: unknown[] = []
      const updated: unknown[] = []

      // Detach missing
      const toDetach = [...currentIds].filter(id => !desired.has(id))
      if (toDetach.length > 0) {
        yield* wait(self.detach(toDetach))
        detached.push(...toDetach)
      }

      // Attach or update
      for (const [id, extras] of desired) {
        if (!currentIds.has(id)) {
          yield* wait(self.attach(id, extras))
          attached.push(id)
        }
        else if (Object.keys(extras).length > 0) {
          yield* wait(self.updateExistingPivot(id, extras))
          updated.push(id)
        }
      }

      return { attached, detached, updated }
    })
  }

  /**
   * For each id, attach if currently detached, detach if currently attached.
   * Returns `{ attached, detached }`.
   */
  toggle(idOrIds: unknown | unknown[]): { attached: unknown[], detached: unknown[] } {
    const self = this
    return settle(function* (): Generator<unknown, { attached: unknown[], detached: unknown[] }, unknown> {
      const exec = getExecutor()
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
      if (ids.length === 0) return { attached: [], detached: [] }
      const placeholders = ids.map(() => '?').join(', ')
      const present = (yield* wait(exec.all(
        `SELECT ${quoteSqlColumn(self.fkRelated)} FROM ${quotedTable(self.pivotTable)} WHERE ${quoteSqlColumn(self.fkParent)} = ? AND ${quoteSqlColumn(self.fkRelated)} IN (${placeholders})`,
        [self.parentId, ...ids],
      )))
      const presentIds = new Set(present.map(r => r[self.fkRelated]))

      const toAttach = ids.filter(id => !presentIds.has(id))
      const toDetach = ids.filter(id => presentIds.has(id))
      if (toAttach.length > 0) yield* wait(self.attach(toAttach))
      if (toDetach.length > 0) yield* wait(self.detach(toDetach))
      return { attached: toAttach, detached: toDetach }
    })
  }
}

/**
 * Cursors for `ModelQueryBuilder.cursorPaginate()`.
 *
 * A cursor handed to a client is an opaque token, not a raw column value, for
 * three reasons that raw values cannot meet:
 *
 * - **Direction.** A "previous page" link has to run the query backwards from
 *   the first row of this page. A bare value cannot say which way to go, so the
 *   old prev cursor (the first row's value) re-ran the forward query and
 *   returned this page less one row rather than the page before it.
 * - **Types.** A timestamp comes back as a Date under Postgres. Stringified
 *   with `JSON.stringify` it keeps its quotes and the next page compared the
 *   column with a quoted string. The token tags dates and bigints so they come
 *   back as what they were.
 * - **Ordering.** The token records the columns and direction it was issued
 *   for, so replaying it against a different ordering fails loudly instead of
 *   skipping or repeating rows.
 *
 * A raw value (or tuple, for several columns) is still accepted as a forward
 * cursor, which keeps `cursorPaginate(15, lastId)` working.
 */
type CursorDirection = 'next' | 'prev'

export interface CursorToken {
  values: unknown[]
  direction: CursorDirection
  columns: string[]
  order: 'asc' | 'desc'
}

const CURSOR_PREFIX = 'c1.'

/** @internal Exported for tests. */
export function encodeCursor(token: CursorToken): string {
  const json = JSON.stringify({ v: token.values, d: token.direction, c: token.columns, o: token.order }, function (this: any, key: string, value: unknown) {
    const original = this[key]
    if (original instanceof Date) return { $date: original.toISOString() }
    if (typeof original === 'bigint') return { $bigint: original.toString() }
    return value
  })
  return CURSOR_PREFIX + Buffer.from(json, 'utf8').toString('base64url')
}

/** @internal Exported for tests. */
export function decodeCursor(cursor: unknown): CursorToken | null {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null
  const body = cursor.slice(CURSOR_PREFIX.length)
  if (!/^[\w-]+$/.test(body)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'), (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (typeof value.$date === 'string') return new Date(value.$date)
        if (typeof value.$bigint === 'string') return BigInt(value.$bigint)
      }
      return value
    })
    if (!parsed || !Array.isArray(parsed.v) || !Array.isArray(parsed.c)) return null
    if (parsed.d !== 'next' && parsed.d !== 'prev') return null
    if (parsed.o !== 'asc' && parsed.o !== 'desc') return null
    return { values: parsed.v, direction: parsed.d, columns: parsed.c.map(String), order: parsed.o }
  }
  catch {
    return null
  }
}


/**
 * Query builder with precise type narrowing
 */
class ModelQueryBuilder<
  TDef extends ModelDefinition,
  TSelected extends ColumnName<TDef> = ColumnName<TDef>
> {
  private _definition: TDef
  private _wheres: { column?: string; operator?: WhereOperator; value?: unknown; boolean: 'and' | 'or'; raw?: string; rawParams?: unknown[]; caseInsensitive?: boolean }[] = []
  private _orderBy: { column: string; direction: 'asc' | 'desc' }[] = []
  private _limit?: number
  private _offset?: number
  private _select: string[] = ['*']
  private _withRelations: string[] = []
  // Soft-delete scope: 'exclude' (default — hide trashed), 'include' (withTrashed), 'only' (onlyTrashed).
  private _trashed: 'exclude' | 'include' | 'only' = 'exclude'

  constructor(definition: TDef) {
    this._definition = definition
  }

  /**
   * Include soft-deleted rows in the results. No-op on models without soft
   * deletes. See stacksjs/bun-query-builder#1024.
   */
  withTrashed(): ModelQueryBuilder<TDef, TSelected> {
    this._trashed = 'include'
    return this
  }

  /** Return ONLY soft-deleted rows. No-op on models without soft deletes. */
  onlyTrashed(): ModelQueryBuilder<TDef, TSelected> {
    this._trashed = 'only'
    return this
  }

  // Two-arg form: .where('column', value)
  where<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Three-arg form with a set operator: .where('column', 'in', [values])
  // `in` and `not in` take a LIST, not a scalar - without this overload the
  // general three-arg form below types the value as the column's own type and
  // rejects the array, even though the runtime handles it (and `whereIn`
  // itself is implemented as `where(column, 'in', values)`).
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: 'in' | 'not in',
    value: ReadonlyArray<K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown>
  ): ModelQueryBuilder<TDef, TSelected>

  // Three-arg form: .where('column', operator, value)
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Implementation signature (hidden from consumers):
  where<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | unknown,
    value?: unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'and' })
    }
    else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'and' })
    }
    return this
  }

  // Two-arg form: .orWhere('column', value)
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Three-arg form: .orWhere('column', operator, value)
  // Set operators take a list here too.
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operator: 'in' | 'not in',
    value: ReadonlyArray<K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown>
  ): ModelQueryBuilder<TDef, TSelected>

  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Implementation signature (hidden from consumers):
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | unknown,
    value?: unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'or' })
    }
    else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'or' })
    }
    return this
  }

  whereIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'in', value: values, boolean: 'and' })
    return this
  }

  orWhereIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'in', value: values, boolean: 'or' })
    return this
  }

  whereNotIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not in', value: values, boolean: 'and' })
    return this
  }

  orWhereNotIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not in', value: values, boolean: 'or' })
    return this
  }

  whereNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    assertValidIdentifier(column, 'whereNull(column)')
    this._wheres.push({ column: column as string, operator: '=', value: null, boolean: 'and' })
    return this
  }

  orWhereNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    assertValidIdentifier(column, 'orWhereNull(column)')
    this._wheres.push({ column: column as string, operator: '=', value: null, boolean: 'or' })
    return this
  }

  whereNotNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    assertValidIdentifier(column, 'whereNotNull(column)')
    this._wheres.push({ column: column as string, operator: '!=', value: null, boolean: 'and' })
    return this
  }

  orWhereNotNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    assertValidIdentifier(column, 'orWhereNotNull(column)')
    this._wheres.push({ column: column as string, operator: '!=', value: null, boolean: 'or' })
    return this
  }

  whereLike<K extends ColumnName<TDef>>(column: K, pattern: string, caseSensitive = false): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'and', caseInsensitive: !caseSensitive })
    return this
  }

  orWhereLike<K extends ColumnName<TDef>>(column: K, pattern: string, caseSensitive = false): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'or', caseInsensitive: !caseSensitive })
    return this
  }

  /** Case-insensitive LIKE: native `ILIKE` on PostgreSQL, `LOWER()` elsewhere. */
  whereILike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'ilike', value: pattern, boolean: 'and' })
    return this
  }

  orWhereILike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'ilike', value: pattern, boolean: 'or' })
    return this
  }

  whereNotILike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not ilike', value: pattern, boolean: 'and' })
    return this
  }

  orWhereNotILike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not ilike', value: pattern, boolean: 'or' })
    return this
  }

  whereNotLike<K extends ColumnName<TDef>>(column: K, pattern: string, caseSensitive = false): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not like', value: pattern, boolean: 'and', caseInsensitive: !caseSensitive })
    return this
  }

  orWhereNotLike<K extends ColumnName<TDef>>(column: K, pattern: string, caseSensitive = false): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not like', value: pattern, boolean: 'or', caseInsensitive: !caseSensitive })
    return this
  }

  /**
   * Append a raw SQL fragment as a WHERE clause, with optional positional
   * `?` bindings. Use this when you need a nested OR-group or any SQL the
   * builder doesn't expose directly.
   *
   * Bindings may be passed as separate arguments or as one array; the two
   * calls below are the same query. A lone array is always the bindings list,
   * so on Postgres an array meant as one json/jsonb value is wrapped:
   * `whereRaw('tags @> ?', [['bun']])`.
   *
   * @example
   * ```ts
   * Car.query()
   *   .where('status', 'active')
   *   .whereRaw('(LOWER(make) LIKE ? OR LOWER(model) LIKE ?)', '%tesla%', '%tesla%')
   *   .get()
   *
   * Car.query()
   *   .where('status', 'active')
   *   .whereRaw('(LOWER(make) LIKE ? OR LOWER(model) LIKE ?)', ['%tesla%', '%tesla%'])
   *   .get()
   * ```
   */
  whereRaw(fragment: string, bindings: readonly unknown[]): ModelQueryBuilder<TDef, TSelected>
  whereRaw(fragment: string, ...bindings: unknown[]): ModelQueryBuilder<TDef, TSelected>
  whereRaw(fragment: string, ...params: unknown[]): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ raw: fragment, rawParams: resolveRawBindings(fragment, params), boolean: 'and' })
    return this
  }

  /**
   * OR-connected counterpart of {@link whereRaw}, taking bindings the same two
   * ways.
   */
  orWhereRaw(fragment: string, bindings: readonly unknown[]): ModelQueryBuilder<TDef, TSelected>
  orWhereRaw(fragment: string, ...bindings: unknown[]): ModelQueryBuilder<TDef, TSelected>
  orWhereRaw(fragment: string, ...params: unknown[]): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ raw: fragment, rawParams: resolveRawBindings(fragment, params), boolean: 'or' })
    return this
  }

  /**
   * Apply a parenthesised group of conditions, ANDed against the rest of
   * the query. The callback receives a fresh builder; any where/orWhere
   * calls on it are wrapped in `( ... )` and joined with the surrounding
   * conditions, which is the only way to express AND/OR precedence
   * correctly without raw SQL.
   *
   * @example
   * ```ts
   * Car.query()
   *   .where('status', 'active')
   *   .whereGroup(b => b
   *     .whereLike('make', '%tesla%')
   *     .orWhereLike('model', '%tesla%'))
   *   .get()
   * // → WHERE status = ? AND (make LIKE ? OR model LIKE ?)
   * ```
   */
  whereGroup(callback: (builder: ModelQueryBuilder<TDef, TSelected>) => unknown): ModelQueryBuilder<TDef, TSelected> {
    return this._addGroup('and', callback)
  }

  orWhereGroup(callback: (builder: ModelQueryBuilder<TDef, TSelected>) => unknown): ModelQueryBuilder<TDef, TSelected> {
    return this._addGroup('or', callback)
  }

  private _addGroup(
    boolean: 'and' | 'or',
    callback: (builder: ModelQueryBuilder<TDef, TSelected>) => unknown,
  ): ModelQueryBuilder<TDef, TSelected> {
    const sub = new ModelQueryBuilder<TDef, TSelected>(this._definition)
    callback(sub)
    if (sub._wheres.length === 0) return this
    const groupParams: unknown[] = []
    const inner = sub.buildWhereClauses(groupParams)
    if (!inner) return this
    this._wheres.push({ raw: `(${inner})`, rawParams: groupParams, boolean })
    return this
  }

  whereBetween<K extends ColumnName<TDef>>(
    column: K,
    range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown],
  ): ModelQueryBuilder<TDef, TSelected> {
    assertValidIdentifier(column, 'whereBetween(column)')
    this._wheres.push({ column: column as string, operator: '>=', value: range[0], boolean: 'and' })
    this._wheres.push({ column: column as string, operator: '<=', value: range[1], boolean: 'and' })
    return this
  }

  whereNotBetween<K extends ColumnName<TDef>>(
    column: K,
    range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown],
  ): ModelQueryBuilder<TDef, TSelected> {
    // `NOT BETWEEN` is `(col < min OR col > max)`. The previous shape
    // pushed two flat clauses with `boolean: 'and'` then `boolean:
    // 'or'`, which the builder joined as `... AND col < min OR col >
    // max` — and SQL's AND/OR precedence makes `OR col > max` a
    // top-level disjunction that bypasses every prior WHERE filter.
    // Using a raw grouped clause keeps the operator inside its own
    // parenthesised scope. See stacksjs/stacks#1862 #10.
    assertValidIdentifier(column, 'whereNotBetween(column)')
    const col = quotedColumn(column as string)
    this._wheres.push({
      raw: `(${col} < ? OR ${col} > ?)`,
      rawParams: [range[0], range[1]],
      boolean: 'and',
    })
    return this
  }

  /**
   * Conditionally apply a query modification.
   * When the condition is truthy, the callback is invoked with the builder.
   *
   * @example
   * ```ts
   * User.query()
   *   .when(status, (q) => q.where('status', status))
   *   .when(search, (q) => q.whereLike('name', `%${search}%`))
   *   .get()
   * ```
   */
  when(
    condition: unknown,
    callback: (builder: ModelQueryBuilder<TDef, TSelected>) => ModelQueryBuilder<TDef, TSelected>,
  ): ModelQueryBuilder<TDef, TSelected> {
    if (condition) {
      return callback(this)
    }
    return this
  }

  orderBy<K extends ColumnName<TDef>>(column: K, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TDef, TSelected> {
    assertValidOrderByColumn(column, 'orderBy(column)')
    if (direction !== 'asc' && direction !== 'desc')
      throw new TypeError(`[bun-query-builder] orderBy(direction): expected 'asc' or 'desc', got '${direction}'`)
    this._orderBy.push({ column: column as string, direction })
    return this
  }

  orderByDesc<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'desc')
  }

  orderByAsc<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'asc')
  }

  latest(column: ColumnName<TDef> = 'created_at' as ColumnName<TDef>): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'desc')
  }

  oldest(column: ColumnName<TDef> = 'created_at' as ColumnName<TDef>): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'asc')
  }

  limit(count: number): ModelQueryBuilder<TDef, TSelected> {
    this._limit = count
    return this
  }

  take(count: number): ModelQueryBuilder<TDef, TSelected> {
    return this.limit(count)
  }

  offset(count: number): ModelQueryBuilder<TDef, TSelected> {
    this._offset = count
    return this
  }

  skip(count: number): ModelQueryBuilder<TDef, TSelected> {
    return this.offset(count)
  }

  select<K extends ColumnName<TDef>>(...columns: K[]): ModelQueryBuilder<TDef, K> {
    this._select = columns as string[]
    return this as unknown as ModelQueryBuilder<TDef, K>
  }

  /**
   * Eager-load the named relations. Accumulates across calls — chaining
   * `.with('posts').with('team')` loads BOTH, matching Eloquent. Replacing the
   * list meant an earlier `.with()` (often applied by a scope or a shared base
   * query) was silently dropped by a later one. Duplicates are collapsed so a
   * relation named twice is still loaded once.
   */
  with<R extends InferRelationNames<TDef>>(
    ...relations: R[]
  ): ModelQueryBuilder<TDef, TSelected> {
    for (const r of relations as string[]) {
      if (!this._withRelations.includes(r))
        this._withRelations.push(r)
    }
    return this
  }

  getWithRelations(): string[] {
    return this._withRelations
  }

  /**
   * Build WHERE clause string and push params into the given array.
   * Shared by buildQuery, count, aggregates, delete, and update.
   */
  private buildWhereClauses(params: unknown[]): string {
    const terms: WhereTerm[] = []
    for (const w of this._wheres) {
      let clause: string

      if (w.raw) {
        clause = w.raw
        if (w.rawParams && w.rawParams.length > 0) params.push(...w.rawParams)
      }
      else if (w.value === null) {
        const col = quotedColumn(w.column!)
        clause = w.operator === '=' ? `${col} IS NULL` : `${col} IS NOT NULL`
      }
      else if (w.operator === 'in' || w.operator === 'not in') {
        // `IN ()` is a syntax error on Postgres and MySQL while SQLite parses
        // it, so the empty case renders as a constant predicate instead — see
        // renderInPredicate for why the NOT IN mirror is TRUE, not FALSE.
        const arr = w.value as unknown[]
        clause = renderInPredicate(quotedColumn(w.column!), arr, w.operator === 'not in', arr.map(() => '?').join(', '))
        params.push(...arr)
      }
      else if (w.operator === 'like' || w.operator === 'not like' || w.operator === 'ilike' || w.operator === 'not ilike') {
        clause = renderLikePredicate(quotedColumn(w.column!), w.operator, w.caseInsensitive === true)
        params.push(w.value)
      }
      else {
        clause = `${quotedColumn(w.column!)} ${w.operator} ?`
        params.push(w.value)
      }

      terms.push({ conn: w.boolean === 'or' ? 'OR' : 'AND', sql: clause })
    }
    // Was a flat join: `clauses.push(i === 0 ? clause : `${BOOL} ${clause}`)`.
    // SQL binds AND tighter than OR, so `.where(a).whereLike(b).orWhereLike(c)`
    // meant `(a AND b) OR c` and returned every row `a` was meant to exclude.
    // renderWhereTerms brackets each OR-run instead. See #1083.
    return renderWhereTerms(terms)
  }

  /**
   * The soft-delete predicate for the current `_trashed` scope, or '' when the
   * model isn't soft-deletable or trashed rows are explicitly included.
   */
  private softDeleteClause(): string {
    if (this._trashed === 'include' || !softDeletesEnabled(this._definition as ModelDefinition))
      return ''
    return this._trashed === 'only'
      ? `${SOFT_DELETE_COLUMN} IS NOT NULL`
      : `${SOFT_DELETE_COLUMN} IS NULL`
  }

  /**
   * Build the full WHERE body (no `WHERE` keyword), combining user clauses with
   * the soft-delete predicate. User clauses are parenthesised when both are
   * present so a top-level `OR` can't escape the soft-delete filter.
   */
  /**
   * Refuse a destructive statement that carries clauses it will not emit.
   *
   * `delete()`, `update()` and `increment()` read none of `_limit`, `_offset`
   * or `_orderBy`, so `query().where(...).orderBy('id').limit(1).delete()`
   * quietly deleted every matching row rather than one — the caller's cap was
   * dropped on the floor. LIMIT on an UPDATE/DELETE is not portable (Postgres
   * has no such form), so these cannot simply be emitted; being loud is the
   * honest option. See #1111.
   */
  private assertNoUnappliedClauses(method: string): void {
    const ignored: string[] = []
    if (this._limit !== undefined)
      ignored.push('limit()')
    if (this._offset !== undefined)
      ignored.push('offset()')
    if (this._orderBy.length > 0)
      ignored.push('orderBy()')

    if (ignored.length > 0) {
      throw new TypeError(
        `[orm] ${method}() cannot apply ${ignored.join(', ')} — an UPDATE/DELETE takes no ORDER BY or LIMIT on every supported dialect. `
        + `Previously these were ignored, so the statement affected every matching row. Narrow it with where() instead.`,
      )
    }
  }

  private composeWhere(params: unknown[]): string {
    const userClause = this._wheres.length > 0 ? this.buildWhereClauses(params) : ''
    const sd = this.softDeleteClause()
    if (userClause && sd)
      return `(${userClause}) AND ${sd}`
    return userClause || sd
  }

  private buildQuery(): { sql: string; params: unknown[] } {
    const params: unknown[] = []
    const cols = this._select.map(c => (c === '*' ? c : quotedColumn(c)))
    let sql = `SELECT ${cols.join(', ')} FROM ${quotedTable(this._definition.table)}`

    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    if (this._orderBy.length > 0) {
      sql += ` ORDER BY ${this._orderBy.map(o => `${quotedColumn(o.column)} ${o.direction.toUpperCase()}`).join(', ')}`
    }

    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`

    return { sql, params }
  }

  /**
   * Return the raw SQL and parameters for debugging without executing.
   *
   * @example
   * ```ts
   * const { sql, params } = User.where('active', true).toSql()
   * console.log(sql) // SELECT * FROM users WHERE active = ?
   * ```
   */
  toSql(): { sql: string; params: unknown[] } {
    return this.buildQuery()
  }

  /**
   * Eager load relations onto a set of already-fetched instances.
   * Uses separate queries per relation (N+1 prevention via batch loading).
   *
   * Relations are loaded CONCURRENTLY. Each one reads the same parent set and
   * writes to its own relation slot, so there is no ordering dependency
   * between them — awaiting them in sequence made `.with('a', 'b', 'c')` cost
   * the SUM of three round trips instead of the slowest one.
   */
  private eagerLoadRelations(instances: ModelInstance<TDef, TSelected>[]): void {
    const self = this
    return settle(function* (): Generator<unknown, void, unknown> {
      if (instances.length === 0 || self._withRelations.length === 0) return
      yield* wait(waitAll(self._withRelations.map(r => self.eagerLoadRelation(r, instances))))
    })
  }

  private eagerLoadRelation(relationName: string, instances: ModelInstance<TDef, TSelected>[]): void {
    const self = this
    return settle(function* (): Generator<unknown, void, unknown> {
      const exec = getExecutor()
      const pk = self._definition.primaryKey || 'id'

      // Cache relation resolution per model+relation pair
      const cacheKey = `${self._definition.name}:${relationName}`
      let rel = relationCache.get(cacheKey)
      if (rel === undefined) {
        rel = resolveRelation(self._definition as ModelDefinition, relationName)
        if (relationCache.size >= RELATION_CACHE_MAX)
          relationCache.clear()
        relationCache.set(cacheKey, rel)
      }
      if (!rel)
        throw new Error(unresolvedRelationMessage(self._definition as ModelDefinition, relationName))

      const single = rel.type === 'hasOne' || rel.type === 'morphOne'
      if (rel.type === 'hasMany' || rel.type === 'hasOne' || rel.type === 'morphMany' || rel.type === 'morphOne') {
        // Get parent IDs
        const parentIds = distinctParentIds(instances, pk)
        if (parentIds.length === 0) return

        const placeholders = parentIds.map(() => '?').join(', ')
        // A polymorphic child shares its foreign key with every other parent
        // table, so the type column is the only thing keeping one parent's rows
        // out of another's relation.
        const morphFilter = rel.morphTypeColumn ? ` AND ${rel.morphTypeColumn} = ?` : ''
        const rows = (yield* wait(exec.all(
          `SELECT * FROM ${rel.relatedTable} WHERE ${rel.foreignKey} IN (${placeholders})${morphFilter}`,
          rel.morphTypeColumn ? [...parentIds, rel.morphTypeValue] : parentIds,
        )))

        // Try to get the related model's definition for proper instances
        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || self._definition

        if (!single) {
          // Group by foreign key
          const grouped = new Map<unknown, Record<string, unknown>[]>()
          for (const row of rows) {
            const fkVal = row[rel.foreignKey]
            if (!grouped.has(fkVal)) grouped.set(fkVal, [])
            grouped.get(fkVal)!.push(row)
          }
          for (const instance of instances) {
            const related = grouped.get(instance.get(pk as any)) || []
            instance.setRelation(relationName, related.map(r => new ModelInstance(relDef as any, r as any, true)))
          }
        }
        else {
          // hasOne / morphOne - single record per parent. First row wins: the rows arrive
          // in the database's order, and overwriting on each hit handed back the
          // LAST match, which is the opposite of what `hasOne` means when a
          // parent has stray duplicates.
          const byFk = new Map<unknown, Record<string, unknown>>()
          for (const row of rows) {
            const k = row[rel.foreignKey]
            if (!byFk.has(k)) byFk.set(k, row)
          }
          for (const instance of instances) {
            const row = byFk.get(instance.get(pk as any))
            instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any, true) : null)
          }
        }
      }

      if (rel.type === 'belongsTo') {
        // Get distinct foreign key values in one pass (no intermediate arrays)
        const fkSet = new Set<unknown>()
        for (const i of instances) {
          const v = (i as any)._attributes[rel.foreignKey]
          if (v != null) fkSet.add(v)
        }
        const uniqueFkValues = [...fkSet]
        if (uniqueFkValues.length === 0) {
          for (const instance of instances) instance.setRelation(relationName, null)
          return
        }

        const placeholders = uniqueFkValues.map(() => '?').join(', ')
        const rows = (yield* wait(exec.all(
          `SELECT * FROM ${rel.relatedTable} WHERE ${rel.localKey} IN (${placeholders})`,
          uniqueFkValues,
        )))

        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || self._definition

        const byPk = new Map<unknown, Record<string, unknown>>()
        for (const row of rows) {
          byPk.set(row[rel.localKey], row)
        }

        for (const instance of instances) {
          const fkVal = (instance as any)._attributes[rel.foreignKey]
          const row = byPk.get(fkVal)
          instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any, true) : null)
        }
      }

      if (rel.type === 'belongsToMany') {
        const parentIds = distinctParentIds(instances, pk)
        if (parentIds.length === 0) return
        if (!rel.pivotTable || !rel.pivotFkParent || !rel.pivotFkRelated) return

        // 1) Fetch pivot rows for these parents.
        const pivotPlaceholders = parentIds.map(() => '?').join(', ')
        const pivotRows = (yield* wait(exec.all(
          `SELECT * FROM ${rel.pivotTable} WHERE ${rel.pivotFkParent} IN (${pivotPlaceholders})`,
          parentIds,
        )))

        if (pivotRows.length === 0) {
          for (const instance of instances) instance.setRelation(relationName, [])
          return
        }

        // 2) Fetch related rows in one batch (distinct ids in one pass).
        const relatedIdSet = new Set<unknown>()
        for (const p of pivotRows) {
          const v = p[rel.pivotFkRelated!]
          if (v != null) relatedIdSet.add(v)
        }
        const relatedIds = [...relatedIdSet]
        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || self._definition
        const relatedPk = relDef?.primaryKey || 'id'

        let relatedRows: Record<string, unknown>[] = []
        if (relatedIds.length > 0) {
          const relPlaceholders = relatedIds.map(() => '?').join(', ')
          relatedRows = (yield* wait(exec.all(
            `SELECT * FROM ${rel.relatedTable} WHERE ${relatedPk} IN (${relPlaceholders})`,
            relatedIds,
          )))
        }
        const relatedByPk = new Map<unknown, Record<string, unknown>>()
        for (const r of relatedRows) relatedByPk.set(r[relatedPk], r)

        // 3) Group pivot rows by parent id and assemble related instances per parent.
        const pivotByParent = new Map<unknown, Record<string, unknown>[]>()
        for (const p of pivotRows) {
          const key = p[rel.pivotFkParent!]
          if (!pivotByParent.has(key)) pivotByParent.set(key, [])
          pivotByParent.get(key)!.push(p)
        }

        // Pivot extras = pivot row minus the two FKs and the pivot pk.
        const pivotKnownKeys = new Set([rel.pivotFkParent, rel.pivotFkRelated])

        for (const instance of instances) {
          const parentVal = instance.get(pk as any)
          const myPivots = pivotByParent.get(parentVal) || []
          const relatedInstances = myPivots
            .map((p) => {
              const relRow = relatedByPk.get(p[rel.pivotFkRelated!])
              if (!relRow) return null
              const inst = new ModelInstance(relDef as any, relRow as any, true)
              // Attach pivot extras under instance.pivot
              const extras: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(p)) {
                if (!pivotKnownKeys.has(k)) extras[k] = v
              }
              ;(inst as any).pivot = extras
              return inst
            })
            .filter((x): x is ModelInstance<any, any> => x !== null)
          instance.setRelation(relationName, relatedInstances)
        }
      }

      if (rel.type === 'hasManyThrough' || rel.type === 'hasOneThrough') {
        // parent.pk → through.<throughForeignKey>, through.pk →
        // target.<targetForeignKey>. Two batched IN queries, no N+1.
        const parentIds = distinctParentIds(instances, pk)
        if (parentIds.length === 0) return

        // 1) through rows linking parents to the intermediate table.
        const throughPk = rel.throughLocalKey || 'id'
        const throughPh = parentIds.map(() => '?').join(', ')
        const throughRows = (yield* wait(exec.all(
          `SELECT ${throughPk}, ${rel.throughForeignKey} FROM ${rel.throughTable} WHERE ${rel.throughForeignKey} IN (${throughPh})`,
          parentIds,
        )))
        if (throughRows.length === 0) {
          for (const instance of instances)
            instance.setRelation(relationName, rel.type === 'hasManyThrough' ? [] : null)
          return
        }
        // throughId → parentId
        const throughToParent = new Map<unknown, unknown>()
        for (const t of throughRows) throughToParent.set(t[throughPk], t[rel.throughForeignKey!])

        // 2) target rows in one batch.
        const throughIds = [...new Set(throughRows.map(t => t[throughPk]))]
        const targetPh = throughIds.map(() => '?').join(', ')
        const targetRows = (yield* wait(exec.all(
          `SELECT * FROM ${rel.relatedTable} WHERE ${rel.targetForeignKey} IN (${targetPh})`,
          throughIds,
        )))

        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || self._definition

        // Group target rows by parent (target.targetFk → throughId → parentId).
        const byParent = new Map<unknown, ModelInstance<any, any>[]>()
        for (const row of targetRows) {
          const parentVal = throughToParent.get(row[rel.targetForeignKey!])
          if (parentVal == null) continue
          if (!byParent.has(parentVal)) byParent.set(parentVal, [])
          byParent.get(parentVal)!.push(new ModelInstance(relDef as any, row as any, true))
        }

        for (const instance of instances) {
          const group = byParent.get(instance.get(pk as any)) || []
          instance.setRelation(relationName, rel.type === 'hasManyThrough' ? group : (group[0] ?? null))
        }
      }
    })
  }

  get(): ModelRecord<TDef, TSelected>[] {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected>[], unknown> {
      const exec = getExecutor()
      const { sql, params } = self.buildQuery()
      const rows = (yield* wait(exec.all(sql, params)))
      const instances = rows.map(row => new ModelInstance<TDef, TSelected>(self._definition, row as any, true))

      // Eager load relations
      if (self._withRelations.length > 0) {
        yield* wait(self.eagerLoadRelations(instances))
      }

      return instances as ModelRecord<TDef, TSelected>[]
    })
  }

  first(): ModelRecord<TDef, TSelected> | undefined {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected> | undefined, unknown> {
      self._limit = 1
      return ((yield* wait(self.get())))[0]
    })
  }

  firstOrFail(): ModelRecord<TDef, TSelected> {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected>, unknown> {
      const result = (yield* wait(self.first()))
      if (!result) throw new Error(`No ${self._definition.name} found`)
      return result
    })
  }

  /**
   * The row with this primary key that also satisfies the query's other
   * constraints, including its soft-delete scope. `defineModel()` models were
   * typed with the browser builder's `query().find()`, which compiled on the
   * server and then threw because this builder had none.
   */
  find(id: number | string): ModelRecord<TDef, TSelected> | undefined {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected> | undefined, unknown> {
      const pk = (self._definition.primaryKey || 'id') as ColumnName<TDef>
      return self.where(pk, id as any).first()
    })
  }

  findOrFail(id: number | string): ModelRecord<TDef, TSelected> {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected>, unknown> {
      const result = (yield* wait(self.find(id)))
      if (!result) throw new Error(`${self._definition.name} with id ${id} not found`)
      return result
    })
  }

  last(): ModelRecord<TDef, TSelected> | undefined {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected> | undefined, unknown> {
      const pk = self._definition.primaryKey || 'id'
      self._orderBy = [{ column: pk, direction: 'desc' }]
      self._limit = 1
      return ((yield* wait(self.get())))[0]
    })
  }

  count(): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      const params: unknown[] = []
      let sql = `SELECT COUNT(*) as count FROM ${quotedTable(self._definition.table)}`

      const whereBody = self.composeWhere(params)
      if (whereBody) {
        sql += ` WHERE ${whereBody}`
      }

      const row = (yield* wait(exec.get(sql, params)))
      return Number((row as { count: number } | undefined)?.count ?? 0)
    })
  }

  exists(): boolean {
    const self = this
    return settle(function* (): Generator<unknown, boolean, unknown> {
      return ((yield* wait(self.count()))) > 0
    })
  }

  doesntExist(): boolean {
    const self = this
    return settle(function* (): Generator<unknown, boolean, unknown> {
      return ((yield* wait(self.count()))) === 0
    })
  }

  /**
   * Get a single record, throwing if zero or more than one match.
   *
   * @example
   * ```ts
   * const admin = User.where('role', 'admin').sole()
   * ```
   */
  sole(): ModelRecord<TDef, TSelected> {
    const self = this
    return settle(function* (): Generator<unknown, ModelRecord<TDef, TSelected>, unknown> {
      self._limit = 2 // fetch 2 to detect duplicates
      const results = (yield* wait(self.get()))
      if (results.length === 0) throw new Error(`No ${self._definition.name} found`)
      if (results.length > 1) throw new Error(`Expected one ${self._definition.name}, found multiple`)
      return results[0]
    })
  }

  /**
   * Increment a numeric column by the given amount.
   *
   * @example
   * ```ts
   * Post.where('id', 1).increment('views')
   * Post.where('id', 1).increment('views', 5)
   * ```
   */
  increment<K extends NumericColumns<TDef>>(column: K, amount = 1): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      assertValidIdentifier(column, 'increment(column)')
      self.assertNoUnappliedClauses('increment')
      const exec = getExecutor()
      const params: unknown[] = [amount]

      // quotedColumn, not sqlColumn: a column the model has every right to name
      // `order` or `group` is a syntax error unquoted. See quoteSqlColumn.
      const incCol = quotedColumn(column as string)
      let sql = `UPDATE ${quotedTable(self._definition.table)} SET ${incCol} = ${incCol} + ?`

      if (timestampsEnabled(self._definition)) {
        sql += `, updated_at = ?`
        params.push(formatNow())
      }

      // See delete(): composeWhere is the only path that adds the soft-delete
      // predicate, so a scoped counter bump has to go through it. #1111.
      const whereBody = self.composeWhere(params)
      if (whereBody) {
        sql += ` WHERE ${whereBody}`
      }

      return ((yield* wait(exec.run(sql, params)))).changes
    })
  }

  /**
   * Decrement a numeric column by the given amount.
   *
   * @example
   * ```ts
   * Product.where('id', 1).decrement('stock')
   * Product.where('id', 1).decrement('stock', 3)
   * ```
   */
  decrement<K extends NumericColumns<TDef>>(column: K, amount = 1): number {
    return this.increment(column, -amount)
  }

  /**
   * Process results in chunks to avoid memory issues with large datasets.
   *
   * @example
   * ```ts
   * User.query().chunk(100, (users) => {
   *   for (const user of users) { ... }
   * })
   * ```
   */
  chunk(size: number, callback: (items: ModelInstance<TDef, TSelected>[]) => void | false | Promise<void | false>): void {
    const self = this
    return settle(function* (): Generator<unknown, void, unknown> {
      let page = 0
      while (true) {
        const builder = new ModelQueryBuilder<TDef, TSelected>(self._definition)
        // Copy wheres, orders, and relations
        builder._wheres = [...self._wheres]
        builder._orderBy = [...self._orderBy]
        builder._select = [...self._select]
        builder._withRelations = [...self._withRelations]
        builder._trashed = self._trashed
        builder._limit = size
        builder._offset = page * size

        const results = (yield* wait(builder.get()))
        if (results.length === 0) break

        const result = (yield* wait(callback(results)))
        if (result === false) break
        if (results.length < size) break

        page++
      }
    })
  }

  paginate(page: number | PaginateOptions = 1, perPage = 15): {
    data: ModelInstance<TDef, TSelected>[]
    total: number
    page: number
    perPage: number
    lastPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
    meta: { perPage: number, page: number, total: number, lastPage: number }
  } {
    const self = this
    return settle(function* (): Generator<unknown, {
    data: ModelInstance<TDef, TSelected>[]
    total: number
    page: number
    perPage: number
    lastPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
    meta: { perPage: number, page: number, total: number, lastPage: number }
  }, unknown> {
      // Options form: `paginate({ page, perPage })`. This API is (page, perPage)
      // and the query builder's is (perPage, page); both arguments are numbers,
      // so transposing them returns a different page rather than raising
      // anything. Naming them cannot be got wrong. See #1092.
      if (typeof page === 'object' && page !== null) {
        const options = page
        perPage = options.perPage ?? 15
        page = options.page ?? 1
      }
      const total = (yield* wait(self.count()))
      const lastPage = Math.ceil(total / perPage)
      self._limit = perPage
      self._offset = (page - 1) * perPage
      const data = (yield* wait(self.get()))
      return {
        data,
        total,
        page,
        perPage,
        lastPage,
        hasMorePages: page < lastPage,
        isEmpty: data.length === 0,
        from: data.length > 0 ? (page - 1) * perPage + 1 : null,
        to: data.length > 0 ? (page - 1) * perPage + data.length : null,
        // Mirrors the query builder's result, which nests under `meta`. The flat
        // fields above stay exactly as they were, so this is additive: code
        // written against either shape now works against both, and a helper that
        // reads `result.meta.total` stops depending on which API produced it.
        // See #1092.
        meta: { perPage, page, total, lastPage },
      }
    })
  }

  /**
   * A copy of this query that can take its own LIMIT, OFFSET, ORDER BY and
   * WHERE without touching the original, which the caller may still be
   * holding. `paginate()` sets its limit on the builder itself; the two
   * methods below do not.
   */
  private fork(): ModelQueryBuilder<TDef, TSelected> {
    const copy = new ModelQueryBuilder<TDef, TSelected>(this._definition)
    copy._wheres = [...this._wheres]
    copy._orderBy = [...this._orderBy]
    copy._limit = this._limit
    copy._offset = this._offset
    copy._select = [...this._select]
    copy._withRelations = [...this._withRelations]
    copy._trashed = this._trashed
    return copy
  }

  /**
   * One page without the COUNT: fetches `perPage + 1` rows to learn whether a
   * next page exists. Use it where the total is expensive or not wanted.
   *
   * Arguments follow the query builder (`perPage`, then `page`); the options
   * form names them, so they cannot be transposed.
   *
   * @example
   * ```ts
   * const { data, hasMorePages } = await Post.where('published', true).simplePaginate(15, 2)
   * await Post.query().simplePaginate({ perPage: 15, page: 2 })
   * ```
   */
  simplePaginate(perPage: number | PaginateOptions = 15, page = 1): {
    data: ModelRecord<TDef, TSelected>[]
    page: number
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
    meta: { perPage: number, page: number, hasMore: boolean }
  } {
    const self = this
    return settle(function* (): Generator<unknown, {
    data: ModelRecord<TDef, TSelected>[]
    page: number
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
    meta: { perPage: number, page: number, hasMore: boolean }
  }, unknown> {
      if (typeof perPage === 'object' && perPage !== null) {
        const options = perPage
        page = options.page ?? 1
        perPage = options.perPage ?? 15
      }
      if (!Number.isInteger(perPage) || perPage <= 0)
        throw new TypeError(`[orm] simplePaginate(perPage): expected positive integer, got ${perPage}`)
      if (!Number.isInteger(page) || page < 1)
        throw new TypeError(`[orm] simplePaginate(page): expected integer >= 1, got ${page}`)

      const query = self.fork()
      query._limit = perPage + 1
      query._offset = (page - 1) * perPage
      const rows = (yield* wait(query.get()))
      const hasMore = rows.length > perPage
      const data = hasMore ? rows.slice(0, perPage) : rows
      return {
        data,
        page,
        perPage,
        hasMorePages: hasMore,
        isEmpty: data.length === 0,
        from: data.length > 0 ? (page - 1) * perPage + 1 : null,
        to: data.length > 0 ? (page - 1) * perPage + data.length : null,
        meta: { perPage, page, hasMore },
      }
    })
  }

  /**
   * Keyset pagination: each page continues after the last row of the one
   * before, so it stays correct while rows are inserted or deleted and costs
   * the same on page 10,000 as on page 1.
   *
   * The query is ordered by `column` (one name, or several for a composite
   * order) in `direction`; the cursor is only meaningful in that order, so a
   * query that already has `orderBy()` is refused rather than silently
   * re-ordered. The columns together must identify a row (end a composite with
   * the primary key) and cannot be NULL, or rows at a page boundary are
   * skipped or repeated.
   *
   * `nextCursor` and `prevCursor` are opaque strings: hand them back as
   * `cursor` for the following or the preceding page. `null` means there is no
   * such page. A raw column value (or tuple) is also accepted and continues
   * forward.
   *
   * @example
   * ```ts
   * const first = await Post.where('published', true).cursorPaginate(15)
   * const second = await Post.where('published', true).cursorPaginate(15, first.meta.nextCursor)
   * const back = await Post.where('published', true).cursorPaginate(15, second.meta.prevCursor)
   *
   * // newest first, with the id as tie-breaker
   * await Post.query().cursorPaginate(15, cursor, ['created_at', 'id'], 'desc')
   * ```
   */
  cursorPaginate(
    perPage: number = 15,
    cursor?: unknown,
    column: string | string[] = this._definition.primaryKey || 'id',
    direction: 'asc' | 'desc' = 'asc',
  ): {
    data: ModelRecord<TDef, TSelected>[]
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    meta: { perPage: number, nextCursor: string | null, prevCursor: string | null }
  } {
    const self = this
    return settle(function* (): Generator<unknown, {
    data: ModelRecord<TDef, TSelected>[]
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    meta: { perPage: number, nextCursor: string | null, prevCursor: string | null }
  }, unknown> {
      if (!Number.isInteger(perPage) || perPage <= 0)
        throw new TypeError(`[orm] cursorPaginate(perPage): expected positive integer, got ${perPage}`)
      if (direction !== 'asc' && direction !== 'desc')
        throw new TypeError(`[orm] cursorPaginate(direction): expected 'asc' or 'desc', got ${String(direction)}`)
      const columns = (Array.isArray(column) ? column : [column]).map(String)
      if (columns.length === 0)
        throw new TypeError('[orm] cursorPaginate(column): expected at least one column')
      for (const name of columns) assertValidIdentifier(name, 'cursorPaginate(column)')
      if (self._orderBy.length > 0) {
        throw new TypeError(
          `[orm] cursorPaginate() cannot be combined with orderBy(): it orders by ${columns.map(c => `${c} ${direction}`).join(', ')} itself, `
          + `and a cursor is only meaningful in that order. Remove the orderBy(), or pass the column and direction to cursorPaginate().`,
        )
      }
      if (!self._select.includes('*')) {
        for (const name of columns) {
          if (!self._select.includes(name))
            throw new TypeError(`[orm] cursorPaginate(): select cursor column ${name} in the result`)
        }
      }

      // Work out which way this cursor points and which values it carries.
      let backwards = false
      let values: unknown[] | null = null
      const token = decodeCursor(cursor)
      if (token) {
        if (token.columns.length !== columns.length || token.columns.some((c, i) => c !== columns[i]) || token.order !== direction) {
          throw new TypeError(
            `[orm] cursorPaginate(): this cursor was issued for ${token.columns.join(', ')} ${token.order}, `
            + `not ${columns.join(', ')} ${direction}. Request the first page again.`,
          )
        }
        backwards = token.direction === 'prev'
        values = token.values
      }
      else if (cursor !== undefined && cursor !== null) {
        values = Array.isArray(cursor) ? cursor : [cursor]
        if (values.length !== columns.length) {
          throw new TypeError(`[orm] cursorPaginate(): expected ${columns.length} cursor value(s) for ${columns.join(', ')}, got ${values.length}`)
        }
      }

      // Forwards in `direction`, or the opposite way when paging back; a backward
      // page is read in reverse and put back in order afterwards.
      const reading: 'asc' | 'desc' = backwards ? (direction === 'asc' ? 'desc' : 'asc') : direction
      const compare = reading === 'asc' ? '>' : '<'
      const params: unknown[] = []
      const existing = self.composeWhere(params)
      const query = new ModelQueryBuilder<TDef, TSelected>(self._definition)
      query._select = [...self._select]
      query._withRelations = [...self._withRelations]
      // composeWhere has already applied the soft-delete scope.
      query._trashed = 'include'
      if (existing) query._wheres.push({ raw: `(${existing})`, rawParams: params, boolean: 'and' })
      if (values) {
        const quoted = columns.map(quotedColumn)
        const marks = values.map(() => '?').join(', ')
        const predicate = quoted.length === 1 ? `${quoted[0]} ${compare} ?` : `(${quoted.join(', ')}) ${compare} (${marks})`
        query._wheres.push({ raw: predicate, rawParams: values, boolean: 'and' })
      }
      query._orderBy = columns.map(name => ({ column: name, direction: reading }))
      query._limit = perPage + 1

      const rows = (yield* wait(query.get()))
      const more = rows.length > perPage
      const page = more ? rows.slice(0, perPage) : rows
      if (backwards) page.reverse()

      const cursorFor = (row: ModelRecord<TDef, TSelected>, pointing: CursorDirection): string => {
        const picked = columns.map((name) => {
          const value = (row as any).getAttribute(name)
          if (value === undefined)
            throw new TypeError(`[orm] cursorPaginate(): select cursor column ${name} in the result`)
          return value
        })
        return encodeCursor({ values: picked, direction: pointing, columns, order: direction })
      }
      const first = page[0]
      const last = page[page.length - 1]

      // Reading forwards, "more" is the next page and a prior page exists whenever
      // a cursor brought us here. Reading backwards it is the other way round, and
      // the page we came from is always after this one.
      const hasNext = backwards ? page.length > 0 : more
      const hasPrev = backwards ? more : values !== null && page.length > 0
      return {
        data: page,
        perPage,
        hasMorePages: hasNext,
        isEmpty: page.length === 0,
        meta: {
          perPage,
          nextCursor: hasNext && last ? cursorFor(last, 'next') : null,
          prevCursor: hasPrev && first ? cursorFor(first, 'prev') : null,
        },
      }
    })
  }

  pluck<K extends ColumnName<TDef>>(
    column: K
  ): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[] {
    const self = this
    return settle(function* (): Generator<unknown, (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[], unknown> {
      assertValidIdentifier(column, 'pluck(column)')
      // Raw query — avoid creating ModelInstance objects just to extract one column
      const exec = getExecutor()
      const params: unknown[] = []
      // Two spellings of the same column: the statement needs it quoted (an
      // `order` or `group` column is a syntax error bare), while the result key
      // every driver hands back is the unquoted name.
      const pluckCol = sqlColumn(column as string)
      let sql = `SELECT ${quotedColumn(column as string)} FROM ${quotedTable(self._definition.table)}`

      const whereBody = self.composeWhere(params)
      if (whereBody) {
        sql += ` WHERE ${whereBody}`
      }
      if (self._orderBy.length > 0) {
        sql += ` ORDER BY ${self._orderBy.map(o => `${quotedColumn(o.column)} ${o.direction.toUpperCase()}`).join(', ')}`
      }
      if (self._limit !== undefined) sql += ` LIMIT ${self._limit}`
      if (self._offset !== undefined) sql += ` OFFSET ${self._offset}`

      const rows = (yield* wait(exec.all(sql, params)))
      return rows.map(r => r[pluckCol]) as any
    })
  }

  private aggregate(fn: string, column: string): unknown {
    const self = this
    return settle(function* (): Generator<unknown, unknown, unknown> {
      // The aggregate function name comes from internal call sites
      // (max/min/avg/sum below) so it's bounded — but validate column
      // since callers pass user-derived field names to those wrappers.
      assertValidIdentifier(column, `${fn}(column)`)
      const exec = getExecutor()
      const params: unknown[] = []
      // quotedColumn: `MAX(order)` is a syntax error, `MAX("order")` is not.
      let sql = `SELECT ${fn}(${quotedColumn(column)}) as v FROM ${quotedTable(self._definition.table)}`

      const whereBody = self.composeWhere(params)
      if (whereBody) {
        sql += ` WHERE ${whereBody}`
      }

      const row = (yield* wait(exec.get(sql, params))) as { v: unknown } | undefined
      const v = row?.v
      if (v == null) return null
      // Postgres returns numeric aggregates (and bigint COUNT) as strings via
      // the driver — coerce those. But MAX/MIN on a TEXT column legitimately
      // yields text: the previous unconditional Number() turned it into NaN.
      // Genuinely numeric-looking text values still coerce; that ambiguity is
      // inherent to the driver's string transport.
      if (typeof v === 'string') {
        const n = Number(v)
        return v.trim() !== '' && !Number.isNaN(n) ? n : v
      }
      return v
    })
  }

  max<K extends ColumnName<TDef>>(column: K): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null {
    return this.aggregate('MAX', column as string) as (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null
  }

  min<K extends ColumnName<TDef>>(column: K): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null {
    return this.aggregate('MIN', column as string) as (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null
  }

  avg<K extends NumericColumns<TDef>>(column: K): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      return Number((yield* wait(self.aggregate('AVG', column as string))) ?? 0) || 0
    })
  }

  sum<K extends NumericColumns<TDef>>(column: K): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      return Number((yield* wait(self.aggregate('SUM', column as string))) ?? 0) || 0
    })
  }

  /**
   * Delete the matching rows the way `instance.delete()` would: a model with
   * `useSoftDeletes` has them marked, any other has them removed, and
   * `beforeDelete`/`afterDelete` run for each row. Resolves to the number of
   * rows affected.
   *
   * This was a bare `DELETE` on every model, with no hooks. On a soft-deletable
   * model `Post.where(...).delete()` permanently removed live rows that
   * `Post.delete(id)` would have marked.
   *
   * `onlyTrashed().delete()` still purges the trash (#1111), since marking rows
   * that are already marked would do nothing. `forceDelete()` purges any scope.
   */
  delete(): Written<TDef, number> {
    const self = this
    const answer = settle(function* (): Generator<unknown, number, unknown> {
      self.assertNoUnappliedClauses('delete')
      const mark = softDeletesEnabled(self._definition as ModelDefinition) && self._trashed !== 'only'
      return self.deleteMatching(mark)
    })
    return answer as unknown as Written<TDef, number>
  }

  /**
   * Remove the matching rows for good, soft deletes or not. Delete hooks run
   * for each row. Resolves to the number of rows removed.
   */
  forceDelete(): Written<TDef, number> {
    const self = this
    const answer = settle(function* (): Generator<unknown, number, unknown> {
      self.assertNoUnappliedClauses('forceDelete')
      return self.deleteMatching(false)
    })
    return answer as unknown as Written<TDef, number>
  }

  private deleteMatching(mark: boolean): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      const exec = getExecutor()
      const table = quotedTable(self._definition.table)
      const hooks = self._definition.hooks

      // composeWhere, not buildWhereClauses: the soft-delete predicate is added
      // only by composeWhere, so building the WHERE here meant a scope that
      // exists purely as that predicate contributed nothing to the statement.
      // `onlyTrashed().delete()` — purge the trash — emitted a bare DELETE and
      // removed every row, live ones included. See #1111.
      const params: unknown[] = []
      let whereBody = self.composeWhere(params)
      // withTrashed() reaches rows that are already marked. Marking them again
      // would move their deleted_at, so they are left as they are.
      if (mark && self._trashed === 'include')
        whereBody = whereBody ? `(${whereBody}) AND ${SOFT_DELETE_COLUMN} IS NULL` : `${SOFT_DELETE_COLUMN} IS NULL`
      const where = whereBody ? ` WHERE ${whereBody}` : ''
      const now = mark ? formatNow() : undefined

      if (!hooks?.beforeDelete && !hooks?.afterDelete) {
        return mark
          ? ((yield* wait(exec.run(`UPDATE ${table} SET ${SOFT_DELETE_COLUMN} = ?${where}`, [now, ...params])))).changes
          : ((yield* wait(exec.run(`DELETE FROM ${table}${where}`, params)))).changes
      }

      // Hooks take the row, so the rows are read first and then deleted by key:
      // the hooks and the statement see the same set. Every beforeDelete runs
      // before anything is written, so one that throws stops the whole delete.
      const pk = self._definition.primaryKey || 'id'
      const rows = (yield* wait(exec.all(`SELECT * FROM ${table}${where}`, params)))
      const instances = rows.map(row => new ModelInstance<TDef>(self._definition, row as Partial<ModelAttributes<TDef>>, true))
      const keys = instances.map(i => (i as any)._attributes[pk] as unknown)
      if (keys.some(k => k == null))
        throw new Error(`Cannot delete a model without a primary key: '${pk}' is missing from a matching row`)

      for (const instance of instances)
        yield* wait(hooks.beforeDelete?.(instance as unknown as ModelHookInstance))

      let changes = 0
      for (let i = 0; i < keys.length; i += DELETE_KEY_CHUNK) {
        const chunk = keys.slice(i, i + DELETE_KEY_CHUNK)
        const inList = `${pk} IN (${chunk.map(() => '?').join(', ')})`
        changes += mark
          ? ((yield* wait(exec.run(`UPDATE ${table} SET ${SOFT_DELETE_COLUMN} = ? WHERE ${inList}`, [now, ...chunk])))).changes
          : ((yield* wait(exec.run(`DELETE FROM ${table} WHERE ${inList}`, chunk)))).changes
      }

      for (const instance of instances) {
        // As instance.delete() does, so trashed() in afterDelete is accurate.
        if (mark)
          (instance as any)._attributes[SOFT_DELETE_COLUMN] = now
        yield* wait(hooks.afterDelete?.(instance as unknown as ModelHookInstance))
      }
      return changes
    })
  }

  update(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): number {
    const self = this
    return settle(function* (): Generator<unknown, number, unknown> {
      self.assertNoUnappliedClauses('update')
      const exec = getExecutor()
      const entries = Object.entries(data)
      const { sets, values } = timestampsEnabled(self._definition)
        ? managedUpdateSet(entries, sqlColumn)
        : { sets: entries.map(([k]) => `${quotedColumn(k)} = ?`).join(', '), values: entries.map(([, v]) => v) }
      const params: unknown[] = [...values]

      let sql = `UPDATE ${quotedTable(self._definition.table)} SET ${sets}`

      // See delete(): composeWhere is the only path that adds the soft-delete
      // predicate, so a scoped update has to go through it. #1111.
      const whereBody = self.composeWhere(params)
      if (whereBody) {
        sql += ` WHERE ${whereBody}`
      }

      return ((yield* wait(exec.run(sql, params)))).changes
    })
  }
}

/**
 * Overloaded where/orWhere signatures for static model methods.
 * Object literals cannot have overloaded methods, so we express them as an interface
 * and intersect with the concrete model object via a type assertion.
 */
interface StaticWhereOverloads<TDef extends ModelDefinition> {
  where<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
  // `Model.where('id', 'in', ids)` - the list form, which the scalar overload
  // below cannot express. This is the one most callers hit, since a static
  // `Model.where(...)` is how a query starts.
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: 'in' | 'not in',
    value: ReadonlyArray<K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown>
  ): ModelQueryBuilder<TDef>
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>

  orWhere<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
}

/** The fully inferred static model API produced from a model definition. */
export type ModelStatic<TDef extends ModelDefinition> = StaticWhereOverloads<TDef> & {
  query: () => ModelQueryBuilder<TDef>
  whereIn: <K extends ColumnName<TDef>>(column: K, values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]) => ModelQueryBuilder<TDef>
  whereNotIn: <K extends ColumnName<TDef>>(column: K, values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]) => ModelQueryBuilder<TDef>
  whereNull: <K extends ColumnName<TDef>>(column: K) => ModelQueryBuilder<TDef>
  whereNotNull: <K extends ColumnName<TDef>>(column: K) => ModelQueryBuilder<TDef>
  whereLike: <K extends ColumnName<TDef>>(column: K, pattern: string) => ModelQueryBuilder<TDef>
  orderBy: <K extends ColumnName<TDef>>(column: K, direction?: 'asc' | 'desc') => ModelQueryBuilder<TDef>
  orderByDesc: <K extends ColumnName<TDef>>(column: K) => ModelQueryBuilder<TDef>
  select: <K extends ColumnName<TDef>>(...columns: K[]) => ModelQueryBuilder<TDef, K>
  with: <R extends InferRelationNames<TDef>>(...relations: R[]) => ModelQueryBuilder<TDef>
  limit: (count: number) => ModelQueryBuilder<TDef>
  take: (count: number) => ModelQueryBuilder<TDef>
  skip: (count: number) => ModelQueryBuilder<TDef>
  withTrashed: () => ModelQueryBuilder<TDef>
  onlyTrashed: () => ModelQueryBuilder<TDef>
  find: (id: number | string) => ModelRecord<TDef> | undefined
  findOrFail: (id: number | string) => ModelRecord<TDef>
  findMany: (ids: (number | string)[]) => ModelRecord<TDef>[]
  all: () => ModelRecord<TDef>[]
  first: () => ModelRecord<TDef> | undefined
  firstOrFail: () => ModelRecord<TDef>
  last: () => ModelRecord<TDef> | undefined
  count: () => number
  exists: () => boolean
  doesntExist: () => boolean
  paginate: (page?: number | PaginateOptions, perPage?: number) => {
    data: ModelRecord<TDef>[]
    total: number
    page: number
    perPage: number
    lastPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
  }
  simplePaginate: (perPage?: number | PaginateOptions, page?: number) => {
    data: ModelRecord<TDef>[]
    page: number
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
    meta: { perPage: number, page: number, hasMore: boolean }
  }
  cursorPaginate: (perPage?: number, cursor?: unknown, column?: string | string[], direction?: 'asc' | 'desc') => {
    data: ModelRecord<TDef>[]
    perPage: number
    hasMorePages: boolean
    isEmpty: boolean
    meta: { perPage: number, nextCursor: string | null, prevCursor: string | null }
  }
  whereBetween: <K extends ColumnName<TDef>>(column: K, range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown]) => ModelQueryBuilder<TDef>
  whereNotBetween: <K extends ColumnName<TDef>>(column: K, range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown]) => ModelQueryBuilder<TDef>
  create: (data: FillableAttributes<TDef>) => Written<TDef, ModelRecord<TDef>>
  createMany: (items: FillableAttributes<TDef>[]) => Written<TDef, ModelRecord<TDef>[]>
  updateOrCreate: (search: Partial<ModelAttributes<TDef>>, data: FillableAttributes<TDef>) => Written<TDef, ModelRecord<TDef>>
  firstOrCreate: (search: Partial<ModelAttributes<TDef>>, data?: FillableAttributes<TDef>) => Written<TDef, ModelRecord<TDef>>
  update: (id: number | string, data: FillableAttributes<TDef>) => Written<TDef, ModelRecord<TDef>>
  delete: (id: number | string) => Written<TDef, boolean>
  destroy: (id: number | string) => Written<TDef, boolean>
  forceDelete: (id: number | string) => Written<TDef, boolean>
  remove: (id: number | string) => Written<TDef, boolean>
  truncate: () => void
  getDefinition: () => TDef
  getTable: () => string
  make: (data?: Partial<ModelAttributes<TDef>>) => ModelInstance<TDef>
  latest: (column?: ColumnName<TDef>) => ModelQueryBuilder<TDef>
  oldest: (column?: ColumnName<TDef>) => ModelQueryBuilder<TDef>
  max: <K extends ColumnName<TDef>>(column: K) => (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) | null
  min: <K extends ColumnName<TDef>>(column: K) => (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) | null
  avg: <K extends NumericColumns<TDef>>(column: K) => number
  sum: <K extends NumericColumns<TDef>>(column: K) => number
  pluck: <K extends ColumnName<TDef>>(column: K) => (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
} & {
  [K in AttributeKeys<TDef> as `where${Capitalize<K>}`]: (value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) => ModelQueryBuilder<TDef>
}

/**
 * Create a model class from a definition with full type inference
 */
function createModelInternal<const TDef extends ModelDefinition>(definition: TDef): ModelStatic<TDef> {
  type Attrs = ModelAttributes<TDef>
  type Cols = ColumnName<TDef>
  type AttrKeys = AttributeKeys<TDef>
  type Fillable = FillableKeys<TDef>
  type Numeric = NumericColumns<TDef>

  const model = {
    query: () => new ModelQueryBuilder<TDef>(definition),

    where(
      column: Cols,
      operatorOrValue: unknown,
      value?: unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).where(column, operatorOrValue as any, value as any)
    },

    orWhere(
      column: Cols,
      operatorOrValue: unknown,
      value?: unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).orWhere(column, operatorOrValue as any, value as any)
    },

    whereIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new ModelQueryBuilder<TDef>(definition).whereIn(column, values)
    },

    whereNotIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new ModelQueryBuilder<TDef>(definition).whereNotIn(column, values)
    },

    whereNull<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).whereNull(column)
    },

    whereNotNull<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).whereNotNull(column)
    },

    whereLike<K extends Cols>(column: K, pattern: string) {
      return new ModelQueryBuilder<TDef>(definition).whereLike(column, pattern)
    },

    orderBy<K extends Cols>(column: K, direction: 'asc' | 'desc' = 'asc') {
      return new ModelQueryBuilder<TDef>(definition).orderBy(column, direction)
    },

    orderByDesc<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).orderByDesc(column)
    },

    select<K extends Cols>(...columns: K[]) {
      return new ModelQueryBuilder<TDef>(definition).select(...columns)
    },

    with<R extends InferRelationNames<TDef>>(...relations: R[]) {
      return new ModelQueryBuilder<TDef>(definition).with(...relations)
    },

    limit: (count: number) => new ModelQueryBuilder<TDef>(definition).limit(count),
    take: (count: number) => new ModelQueryBuilder<TDef>(definition).take(count),
    skip: (count: number) => new ModelQueryBuilder<TDef>(definition).skip(count),

    /** Start a query that includes soft-deleted rows. See #1024. */
    withTrashed: () => new ModelQueryBuilder<TDef>(definition).withTrashed(),
    /** Start a query restricted to soft-deleted rows. See #1024. */
    onlyTrashed: () => new ModelQueryBuilder<TDef>(definition).onlyTrashed(),

    find(id: number | string): ModelRecord<TDef> | undefined {
      return settle(function* (): Generator<unknown, ModelRecord<TDef> | undefined, unknown> {
        const exec = getExecutor()
        const pk = definition.primaryKey || 'id'
        // Exclude soft-deleted rows by default (use withTrashed()/query() to override).
        const sd = softDeletesEnabled(definition) ? ` AND ${SOFT_DELETE_COLUMN} IS NULL` : ''
        const row = (yield* wait(exec.get(`SELECT * FROM ${quotedTable(definition.table)} WHERE ${pk} = ?${sd}`, [id])))
        return row ? new ModelInstance<TDef>(definition, row as any, true) as ModelRecord<TDef> : undefined
      })
    },

    findOrFail(id: number | string): ModelRecord<TDef> {
      return settle(function* (): Generator<unknown, ModelRecord<TDef>, unknown> {
        const result = (yield* wait(model.find(id)))
        if (!result) throw new Error(`${definition.name} with id ${id} not found`)
        return result
      })
    },

    findMany(ids: (number | string)[]): ModelRecord<TDef>[] {
      return settle(function* (): Generator<unknown, ModelRecord<TDef>[], unknown> {
        const exec = getExecutor()
        const pk = definition.primaryKey || 'id'
        const sd = softDeletesEnabled(definition) ? ` AND ${SOFT_DELETE_COLUMN} IS NULL` : ''
        const rows = (yield* wait(exec.all(`SELECT * FROM ${quotedTable(definition.table)} WHERE ${pk} IN (${ids.map(() => '?').join(', ')})${sd}`, ids)))
        return rows.map(row => new ModelInstance<TDef>(definition, row as any, true) as ModelRecord<TDef>)
      })
    },

    all: () => new ModelQueryBuilder<TDef>(definition).get(),
    first: () => new ModelQueryBuilder<TDef>(definition).first(),
    firstOrFail: () => new ModelQueryBuilder<TDef>(definition).firstOrFail(),
    last: () => new ModelQueryBuilder<TDef>(definition).last(),
    count: () => new ModelQueryBuilder<TDef>(definition).count(),
    exists: () => new ModelQueryBuilder<TDef>(definition).exists(),
    doesntExist: () => new ModelQueryBuilder<TDef>(definition).doesntExist(),
    paginate: (page?: number | PaginateOptions, perPage?: number) => new ModelQueryBuilder<TDef>(definition).paginate(page as any, perPage),
    simplePaginate: (perPage?: number | PaginateOptions, page?: number) => new ModelQueryBuilder<TDef>(definition).simplePaginate(perPage as any, page),
    cursorPaginate: (perPage?: number, cursor?: unknown, column?: string | string[], direction?: 'asc' | 'desc') => new ModelQueryBuilder<TDef>(definition).cursorPaginate(perPage, cursor, column, direction),

    whereBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereBetween(column, range as any)
    },

    whereNotBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereNotBetween(column, range as any)
    },

    create(data: FillableAttributes<TDef>): ModelRecord<TDef> {
      return settle(function* (): Generator<unknown, ModelRecord<TDef>, unknown> {
        const instance = new ModelInstance<TDef>(definition, data as any, false)
        yield* wait(instance.save())
        return instance as ModelRecord<TDef>
      })
    },

    /**
     * Insert many records in as few statements as the database allows.
     *
     * This was a loop of `create()`, one INSERT and one round trip per row,
     * which put seeding and importing tens of thousands of rows into minutes.
     * Every record still goes through the same create path as `create()` —
     * mass assignment, mutators, timestamps, uuid, `beforeCreate` and
     * `afterCreate` run per record — and only the write is batched: records
     * that set the same columns share a multi-row INSERT, chunked under the
     * bound-parameter limit of every dialect.
     *
     * Keys a record supplies are written as given. Keys the database
     * generates are read back with RETURNING on Postgres and SQLite; MySQL has
     * no RETURNING, so records there without a key are inserted one at a time
     * to read each id, exactly as before.
     */
    createMany(items: FillableAttributes<TDef>[]): ModelRecord<TDef>[] {
      return settle(function* (): Generator<unknown, ModelRecord<TDef>[], unknown> {
        const instances = items.map(data => new ModelInstance<TDef>(definition, data as any, false))
        if (!instances.length)
          return []

        const exec = getExecutor()
        const pk = definition.primaryKey || 'id'
        const rows: Record<string, unknown>[] = []
        for (const instance of instances)
          rows.push((yield* wait(instance._prepareInsert())))

        // Rectangular statements: group records by the columns they set, in
        // first-seen order so the common case (one shape) is one group.
        const groups = new Map<string, number[]>()
        rows.forEach((row, i) => {
          const shape = Object.keys(row).join('\u0000')
          const group = groups.get(shape)
          if (group)
            group.push(i)
          else
            groups.set(shape, [i])
        })

        for (const [shape, indexes] of groups) {
          const columns = shape ? shape.split('\u0000') : []
          const generated = !columns.includes(pk)

          if (!columns.length || (generated && exec.dialect === 'mysql')) {
            for (const i of indexes) {
              const row = rows[i]!
              const cols = Object.keys(row)
              const result = (yield* wait(exec.insert(
                cols.length
                  ? `INSERT INTO ${quotedTable(definition.table)} (${cols.map(quoteSqlColumn).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
                  : `INSERT INTO ${quotedTable(definition.table)} DEFAULT VALUES`,
                Object.values(row),
                pk,
              )))
              yield* wait(instances[i]!._markInserted(row, generated ? result.lastInsertId : undefined))
            }
            continue
          }

          // Postgres: the batch goes as ONE jsonb parameter, typed by the table's
          // own row type. Drivers cache a prepared statement per query text AND
          // per parameter types (Bun infers them from the values, and a null is
          // a different type), and never free one. A multi-row VALUES insert of
          // rows with optional columns is a new type signature nearly every
          // execution, so a year of seeded analytics left thousands of cached
          // statements on one connection and grew its Postgres backend past
          // 1.8 GB. One jsonb parameter is one signature per column shape.
          if (exec.dialect === 'postgres' && jsonBatchable(definition, columns, indexes.map(i => rows[i]!))) {
            const table = quotedTable(definition.table)
            // Quoted on both sides of the statement: the INSERT target list and
            // the SELECT off the record set name the same columns, and a reserved
            // one has to be spelled the same way in each.
            const list = columns.map(quoteSqlColumn).join(', ')
            // Bound as text and cast on the server: typed as jsonb, the driver
            // JSON-encodes the parameter itself and the batch arrives as one
            // JSON string rather than an array.
            const sql = `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, (?::text)::jsonb)`
            for (let start = 0; start < indexes.length; start += BULK_JSON_ROWS) {
              const chunk = indexes.slice(start, start + BULK_JSON_ROWS)
              const payload = JSON.stringify(chunk.map(i => Object.fromEntries(columns.map(c => [c, rows[i]![c] ?? null]))), jsonValue)
              if (!generated) {
                yield* wait(exec.run(sql, [payload]))
                for (const i of chunk)
                  yield* wait(instances[i]!._markInserted(rows[i]!))
                continue
              }
              // Inserted in recordset order; integer keys are sorted too, which
              // is a sequence's allocation order, so the pairing holds either way.
              const returned = ((yield* wait(exec.all(`${sql} RETURNING ${pk}`, [payload])))).map(r => r[pk])
              const keys = returned.every(k => typeof k === 'number' || typeof k === 'bigint')
                ? [...returned].sort((a, b) => (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0)
                : returned
              for (let j = 0; j < chunk.length; j++)
                yield* wait(instances[chunk[j]!]!._markInserted(rows[chunk[j]!]!, keys[j]))
            }
            continue
          }

          // Every statement's row count is a power of two, so however many
          // records arrive and however the caller batches them, one column shape
          // produces at most log2(perStatement) + 1 distinct statements to cache.
          // Sizing each chunk to "whatever is left" made every remainder a new
          // statement: a year of daily batches was over a thousand of them.
          const perStatement = floorPowerOfTwo(Math.max(1, Math.floor(BULK_INSERT_MAX_PARAMS / columns.length)))
          for (let start = 0; start < indexes.length;) {
            const size = Math.min(perStatement, floorPowerOfTwo(indexes.length - start))
            const chunk = indexes.slice(start, start + size)
            start += size
            const sql = `INSERT INTO ${quotedTable(definition.table)} (${columns.map(quoteSqlColumn).join(', ')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}`
            const params = chunk.flatMap(i => columns.map(c => rows[i]![c]))

            if (!generated) {
              yield* wait(exec.run(sql, params))
              for (const i of chunk)
                yield* wait(instances[i]!._markInserted(rows[i]!))
              continue
            }

            // Generated keys come back in the order the VALUES were written on
            // both Postgres and SQLite. Integer keys are also sorted, which is
            // the allocation order of a sequence or rowid, so the pairing holds
            // even if a future engine returns them in another order.
            const returned = ((yield* wait(exec.all(`${sql} RETURNING ${pk}`, params)))).map(r => r[pk])
            const keys = returned.every(k => typeof k === 'number' || typeof k === 'bigint')
              ? [...returned].sort((a, b) => (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0)
              : returned
            for (let j = 0; j < chunk.length; j++)
              yield* wait(instances[chunk[j]!]!._markInserted(rows[chunk[j]!]!, keys[j]))
          }
        }

        return instances as ModelRecord<TDef>[]
      })
    },

    updateOrCreate(
      search: Partial<Attrs>,
      data: FillableAttributes<TDef>
    ): ModelRecord<TDef> {
      const self = this
      return settle(function* (): Generator<unknown, ModelRecord<TDef>, unknown> {
        let query = new ModelQueryBuilder<TDef>(definition)
        for (const [key, value] of Object.entries(search)) {
          query = query.where(key as Cols, value as any)
        }
        const existing = (yield* wait(query.first()))
        if (existing) {
          yield* wait(existing.update(data))
          return existing
        }
        return self.create({ ...search, ...data } as any)
      })
    },

    firstOrCreate(
      search: Partial<Attrs>,
      data: FillableAttributes<TDef>
    ): ModelRecord<TDef> {
      const self = this
      return settle(function* (): Generator<unknown, ModelRecord<TDef>, unknown> {
        let query = new ModelQueryBuilder<TDef>(definition)
        for (const [key, value] of Object.entries(search)) {
          query = query.where(key as Cols, value as any)
        }
        const existing = (yield* wait(query.first()))
        return existing || self.create({ ...search, ...data } as any)
      })
    },

    /**
     * Update the row with this primary key and return it, running the same
     * fill, timestamps and hooks as `instance.update()`. Throws when no such row
     * exists. `defineModel()` typed this browser-model method on the server,
     * where it was missing.
     */
    update(id: number | string, data: FillableAttributes<TDef>): ModelRecord<TDef> {
      return settle(function* (): Generator<unknown, ModelRecord<TDef>, unknown> {
        const record = (yield* wait(model.findOrFail(id)))
        yield* wait(record.update(data))
        return record
      })
    },

    /**
     * Delete the row with this primary key through `instance.delete()`, so a
     * soft-deletable model is soft-deleted and delete hooks run. False when no
     * such row exists. `defineModel()` typed this browser-model method on the
     * server, where it was missing.
     */
    delete(id: number | string): boolean {
      return settle(function* (): Generator<unknown, boolean, unknown> {
        const record = (yield* wait(model.find(id)))
        return record ? (yield* wait(record.delete())) : false
      })
    },

    /**
     * Delete the row with this primary key, the way `instance.delete()` does:
     * a soft-deletable model is soft-deleted, and delete hooks run.
     *
     * This used to issue a bare `DELETE` on every model, so `destroy()` removed
     * rows that `delete()` on the same model would have kept, and no hook saw
     * it. `forceDelete()` is the spelling for a permanent one.
     */
    destroy(id: number | string): boolean {
      return model.delete(id)
    },

    /**
     * Delete the row with this primary key for good, soft deletes or not.
     * Delete hooks run. `remove()` is the same call — the name the client
     * builder's `db.remove(table, id)` already uses for a real DELETE.
     */
    forceDelete(id: number | string): boolean {
      return settle(function* (): Generator<unknown, boolean, unknown> {
        const record = (yield* wait(model.withTrashed().find(id)))
        return record ? (yield* wait(record.forceDelete())) : false
      })
    },

    remove(id: number | string): boolean {
      return model.forceDelete(id)
    },

    truncate(): void {
      return settle(function* (): Generator<unknown, void, unknown> {
        yield* wait(getExecutor().run(`DELETE FROM ${quotedTable(definition.table)}`, []))
      })
    },

    getDefinition: () => definition,
    getTable: () => definition.table,

    make(data: Partial<Attrs> = {}): ModelInstance<TDef> {
      return new ModelInstance<TDef>(definition, data as any, false)
    },

    latest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderByDesc(column),
    oldest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderBy(column, 'asc'),

    max: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).max(column),
    min: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).min(column),
    avg: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).avg(column),
    sum: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).sum(column),

    pluck<K extends ColumnName<TDef>>(column: K): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[] {
      return new ModelQueryBuilder<TDef>(definition).pluck(column)
    },
  }

  // Wrap in Proxy to support dynamic whereColumn methods (e.g., whereEmail, whereName)
  return new Proxy(model, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('where') && prop.length > 5) {
        const columnPascal = prop.slice(5)
        const column = columnPascal.charAt(0).toLowerCase() + columnPascal.slice(1)

        if (column in definition.attributes || column === 'id' || column === definition.primaryKey) {
          return (value: unknown) => new ModelQueryBuilder<TDef>(definition).where(column as ColumnName<TDef>, value as any)
        }
      }
      return Reflect.get(target, prop)
    },
  }) as unknown as ModelStatic<TDef>
}

/** Create a model class from a definition with full type inference. */
export function createModel<const TDef extends ModelDefinition>(definition: TDef): ModelStatic<TDef> {
  const model = createModelInternal(definition)
  // Make the model findable by name, so a relation pointing at it reads its
  // declared `table` instead of guessing one. See #1093 and localModels above.
  if (definition?.name)
    registerLocalModel(definition.name, model)
  return model
}

export function createTableFromModel(definition: ModelDefinition): void {
  return settle(function* (): Generator<unknown, void, unknown> {
    const exec = getExecutor()
    const pk = toSnakeCase(definition.primaryKey || 'id')
    const columns: string[] = []
    const emitted = new Set<string>([pk])

    // Every column name is quoted for the dialect, as the migration drivers
    // already do (see SQLiteDriver.createTable). This helper emitted them bare,
    // so a model with an `order`, `group` or `when` column — names the read and
    // write paths quote and therefore support — could not have its table created
    // at all: `near "order": syntax error`. `emitted` still keys off the
    // UNQUOTED name, since that is what the column is called.
    columns.push(definition.autoIncrement !== false
      ? `${quoteSqlColumn(pk)} INTEGER PRIMARY KEY AUTOINCREMENT`
      : `${quoteSqlColumn(pk)} INTEGER PRIMARY KEY`)

    if (definition.traits?.useUuid) {
      columns.push('uuid TEXT UNIQUE')
      emitted.add('uuid')
    }

    for (const [attrName, attr] of Object.entries(definition.attributes)) {
      // Column names are snake_case — that is what the migration generator emits
      // (see snakeCase() in migrations.ts) and what every ORM read/write path
      // normalizes to (see normalizeAttributeKeys). Emitting the raw declaration
      // key created a `escalationCount` column that no query ever addressed, so
      // any insert touching a camelCase attribute failed with "no such column".
      const name = toSnakeCase(attrName)
      if (emitted.has(name)) continue
      emitted.add(name)
      // Same mapping the migration path uses. This understood only `number` and
      // `boolean` and sent everything else to TEXT, so `type: 'integer'` — the
      // spelling in this library's own docs — created a TEXT column and integers
      // read back as strings. See #1094 and column-types.ts.
      const declaredType = normalizeAttributeType(attr.type)
      let colType: string = sqliteAffinityFor(declaredType)
      // Safety net: a numeric foreign-key column stores as INTEGER, so float
      // storage cannot corrupt an id (11.0 for 11). Conditional on the declared
      // type, matching SQLiteDriver.getColumnType: external ids are frequently
      // strings (tickers, wallet addresses, hashes) and a declared text type has
      // to win over a name heuristic. An attribute that declares no type at all
      // keeps the old INTEGER default rather than silently changing shape.
      if (name.endsWith('_id') && (declaredType === undefined || isNumericPlanType(declaredType)))
        colType = 'INTEGER'
      let colDef = `${quoteSqlColumn(name)} ${colType}`
      if (attr.unique) colDef += ' UNIQUE'
      // Inline FK constraints for SQLite CREATE TABLE
      if (typeof attr.foreignKey === 'object' && attr.foreignKey !== null) {
        const fk = attr.foreignKey as import('./schema').ForeignKeyConfig
        colDef += ` REFERENCES ${fk.table}(${quoteSqlColumn(fk.column ?? 'id')})`
        if (fk.onDelete)
          colDef += ` ON DELETE ${fk.onDelete.toUpperCase()}`
        if (fk.onUpdate)
          colDef += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`
      }
      columns.push(colDef)
    }

    // belongsTo puts an FK on THIS table — the migration generator emits these
    // (see normalizeRelationList in migrations.ts), so the helper must too or a
    // model that relies on the implied column can't be created from its own
    // definition. Explicitly declared FK attributes already won above.
    for (const rel of normalizeRelationList(definition.belongsTo)) {
      const name = rel.foreignKey ?? `${toSnakeCase(rel.model)}_id`
      if (emitted.has(name)) continue
      emitted.add(name)
      columns.push(`${quoteSqlColumn(name)} INTEGER`)
    }

    if (timestampsEnabled(definition)) {
      for (const c of ['created_at', 'updated_at']) {
        if (emitted.has(c)) continue
        emitted.add(c)
        columns.push(`${c} TEXT`)
      }
    }
    if (softDeletesEnabled(definition) && !emitted.has('deleted_at')) {
      emitted.add('deleted_at')
      columns.push('deleted_at TEXT')
    }

    yield* wait(exec.run(`CREATE TABLE IF NOT EXISTS ${quotedTable(definition.table)} (${columns.join(', ')})`, []))
  })
}

export function seedModel(definition: ModelDefinition, count?: number, faker?: Record<string, unknown>): void {
  return settle(function* (): Generator<unknown, void, unknown> {
    const exec = getExecutor()
    const seeder = definition.traits?.useSeeder
    const seedCount = count ?? (typeof seeder === 'object' && seeder ? seeder.count : 10)

    if (!faker) {
      try {
        const tsFaker = (yield* wait(import('@stacksjs/ts-faker' as string) as Promise<{ faker: Record<string, unknown> }>))
        faker = createFakerCompatLayer(tsFaker.faker) as unknown as Record<string, unknown>
      }
      catch {
        console.warn('@stacksjs/ts-faker not found. Install it for seeding support.')
        return
      }
    }

    for (let i = 0; i < seedCount; i++) {
      const data: Record<string, unknown> = {}

      for (const [name, attr] of Object.entries(definition.attributes)) {
        // Column names are snake_case everywhere else (migration generator,
        // createTableFromModel, normalizeAttributeKeys) — seeding a camelCase
        // attribute under its raw name targeted a column that doesn't exist.
        if (attr.factory) data[toSnakeCase(name)] = (attr.factory as (_f: unknown) => unknown)(faker)
      }

      if (timestampsEnabled(definition)) {
        const now = formatNow()
        data.created_at = now
        data.updated_at = now
      }

      if (definition.traits?.useUuid) data.uuid = crypto.randomUUID()

      const columns = Object.keys(data)
      yield* wait(exec.run(
        `INSERT INTO ${quotedTable(definition.table)} (${columns.map(quoteSqlColumn).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        Object.values(data)
      ))
    }
  })
}

export type {
  ModelInstance,
  ModelQueryBuilder,
  ModelAttributes,
  InferModelAttributes,
  InferAttributeType,
  SystemFields,
  ColumnName,
  AttributeKeys,
  FillableKeys,
  HiddenKeys,
}
