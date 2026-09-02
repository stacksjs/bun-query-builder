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
import type { RelationCardinality } from './type-inference'
import { isNumericPlanType, normalizeAttributeType, sqliteAffinityFor } from './column-types'
import { config, isMysqlLike } from './config'
import type { DriverConnection } from './db'
import { getOrCreateBunSql } from './db'
import { applySqliteBootstrapPragmas } from './sqlite-pragmas'
import { createFakerCompatLayer } from './faker-compat'
import { normalizeRelationList } from './relation-utils'
import { singularizerFor, toTableName as sharedToTableName } from './inflect'
import type { WhereTerm } from './sql-fragments'
import { renderInPredicate, renderWhereTerms } from './sql-fragments'

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
      // Optional, so the column is nullable in the database: `null` is how a
      // write CLEARS it, which is different from omitting the key.
      : undefined extends ModelAttributes<TDef>[K]
        ? ModelAttributes<TDef>[K] | null
        // Required: null stays rejected, as the NOT NULL column would reject it.
        : ModelAttributes<TDef>[K]
  },
  FillableKeys<TDef> | SnakeCase<FillableKeys<TDef>> | BelongsToKeys<TDef>
>>

// Numeric attribute columns - constrains aggregate methods (sum, avg, etc.)
type NumericColumns<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: InferAttributeType<TDef['attributes'][K]> extends number ? K : never
}[AttributeKeys<TDef>]

// Infer relation names from model definition (supports both array and object syntax)

/**
 * Relation names of one relation declaration. Array form lowercases the
 * (unwrapped) model name; record form uses the keys. The array case MUST be
 * checked first: a tuple also structurally matches `Readonly<Record<...>>`
 * and would otherwise leak its own keys ('length', indices, ...) into the
 * relation-name union.
 */
type RelationKeyOf<V> =
  V extends string
    ? Lowercase<V>
    : V extends readonly (infer E)[]
      ? E extends string ? Lowercase<E>
        : E extends { model: infer M extends string } ? Lowercase<M>
          : never
      : V extends Readonly<Record<infer K, unknown>>
        ? K & string
        : never

type InferBelongsToNames<TDef> = TDef extends { belongsTo: infer V } ? RelationKeyOf<V> : never

type InferHasManyNames<TDef> = TDef extends { hasMany: infer V } ? RelationKeyOf<V> : never

type InferHasOneNames<TDef> = TDef extends { hasOne: infer V } ? RelationKeyOf<V> : never

type InferBelongsToManyNames<TDef> = TDef extends { belongsToMany: infer V } ? RelationKeyOf<V> : never

type InferHasOneThroughNames<TDef> = TDef extends { hasOneThrough: infer V } ? RelationKeyOf<V> : never

type InferHasManyThroughNames<TDef> = TDef extends { hasManyThrough: infer V } ? RelationKeyOf<V> : never

type InferMorphOneNames<TDef> = TDef extends { morphOne: infer V } ? RelationKeyOf<V> : never

type InferMorphManyNames<TDef> = TDef extends { morphMany: infer V } ? RelationKeyOf<V> : never

type InferMorphToManyNames<TDef> = TDef extends { morphToMany: infer V } ? RelationKeyOf<V> : never

type InferMorphedByManyNames<TDef> = TDef extends { morphedByMany: infer V } ? RelationKeyOf<V> : never

export type InferRelationNames<TDef> =
  | InferBelongsToNames<TDef>
  | InferHasManyNames<TDef>
  | InferHasOneNames<TDef>
  | InferBelongsToManyNames<TDef>
  | InferHasOneThroughNames<TDef>
  | InferHasManyThroughNames<TDef>
  | InferMorphOneNames<TDef>
  | InferMorphManyNames<TDef>
  | InferMorphToManyNames<TDef>
  | InferMorphedByManyNames<TDef>

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

type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'not like' | 'in' | 'not in'

// --- Dialect-aware execution layer -------------------------------------------
//
// The model API historically ran every query through a hardcoded in-memory
// `bun:sqlite` Database, so projects configured for MySQL/Postgres had their
// model calls silently routed to a fresh, empty SQLite database — every query
// returned "no such table" (stacksjs/bun-query-builder#1021).
//
// All model queries now go through an `OrmExecutor` chosen from the configured
// dialect. SQLite keeps its synchronous `bun:sqlite` engine (wrapped in
// resolved Promises); MySQL/Postgres route through Bun's async `SQL` driver via
// the shared `getOrCreateBunSql()` connection — the same path the direct
// `selectFrom(...)` builder already uses. Because the network drivers are
// async-only, every model read/write method now returns a Promise.

type RunResult = { changes: number, lastInsertId: number | bigint | null }

interface OrmExecutor {
  readonly dialect: SupportedDialect
  all: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  get: (sql: string, params: unknown[]) => Promise<Record<string, unknown> | undefined>
  run: (sql: string, params: unknown[]) => Promise<RunResult>
  /** INSERT that resolves the new primary-key id in a dialect-aware way. */
  insert: (sql: string, params: unknown[], primaryKey: string) => Promise<RunResult>
  /** The underlying bun:sqlite Database, when (and only when) the dialect is sqlite. */
  readonly sqliteDb?: Database
}

/**
 * Rewrite `?` placeholders to Postgres `$1, $2, …` form. The ORM only ever
 * emits `?` as a bound-parameter marker (values are always parameterised and
 * identifiers are validated), so a sequential left-to-right pass is safe.
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
  let i = 0
  const out = sql.replace(/\?/g, () => `$${++i}`)
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

  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return Promise.resolve(this.sqliteDb.query(sql).all(...(params as Bindings)) as Record<string, unknown>[])
  }

  get(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
    return Promise.resolve((this.sqliteDb.query(sql).get(...(params as Bindings)) as Record<string, unknown> | null) ?? undefined)
  }

  run(sql: string, params: unknown[]): Promise<RunResult> {
    const r = this.sqliteDb.run(sql, params as Bindings)
    return Promise.resolve({ changes: r.changes, lastInsertId: r.lastInsertRowid })
  }

  insert(sql: string, params: unknown[]): Promise<RunResult> {
    return this.run(sql, params)
  }
}

class DriverExecutor implements OrmExecutor {
  constructor(public readonly dialect: SupportedDialect) {}

  /** The live dialect-aware connection (handles its own reset/config-change). */
  private conn(): DriverConnection {
    return getOrCreateBunSql() as unknown as DriverConnection
  }

  private text(sql: string): string {
    return this.dialect === 'postgres' ? toPostgresPlaceholders(sql) : sql
  }

  async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const rows = await this.conn().unsafe(this.text(sql), params)
    return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
  }

  async get(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
    const rows = await this.conn().unsafe(this.text(sql), params)
    if (Array.isArray(rows))
      return (rows[0] as Record<string, unknown> | undefined) ?? undefined
    return (rows as Record<string, unknown> | undefined) ?? undefined
  }

  async run(sql: string, params: unknown[]): Promise<RunResult> {
    const res = await this.conn().unsafe(this.text(sql), params)
    return { changes: extractChanges(res), lastInsertId: extractInsertId(res) }
  }

  async insert(sql: string, params: unknown[], primaryKey: string): Promise<RunResult> {
    if (this.dialect === 'postgres') {
      // Postgres has no auto-increment rowid to read back — RETURNING is the
      // portable way to recover the generated key.
      const rows = await this.conn().unsafe(`${toPostgresPlaceholders(sql)} RETURNING ${primaryKey}`, params)
      const row = Array.isArray(rows) ? rows[0] : rows
      return { changes: 1, lastInsertId: row ? (row[primaryKey] ?? null) : null }
    }
    // MySQL: no RETURNING — read the driver's insertId, falling back to
    // LAST_INSERT_ID() on the same connection.
    const res = await this.conn().unsafe(sql, params)
    let id = extractInsertId(res)
    if (id == null) {
      const rows = await this.conn().unsafe('SELECT LAST_INSERT_ID() as id', [])
      const row = Array.isArray(rows) ? rows[0] : rows
      id = (row?.id as number | bigint | undefined) ?? null
    }
    return { changes: extractChanges(res) || 1, lastInsertId: id }
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
 * while mysql / postgres route through the shared async `SQL` driver. The
 * executor is rebuilt whenever the dialect or database name changes.
 */
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

  if (_executor && _executorForDb === null && _executorDialect === dialect && _executorDatabase === database)
    return _executor

  _executorForDb = null
  _executorDialect = dialect
  _executorDatabase = database

  if (dialect === 'sqlite') {
    const db = new Database(database || ':memory:', { create: true })
    // Same rationale as configureOrm: this lazily-created connection is the
    // model write path — it must get the per-connection bootstrap pragmas.
    applySqliteBootstrapPragmas(db)
    _executor = new SqliteExecutor(db)
  }
  else {
    _executor = new DriverExecutor(dialect)
  }

  return _executor
}

/**
 * Return the underlying `bun:sqlite` Database backing the model layer.
 *
 * Only meaningful when the active dialect is sqlite (or a sqlite Database was
 * supplied via `configureOrm`). For mysql/postgres there is no `Database`
 * object — use the async model API instead. Retained for backwards
 * compatibility with callers that reach for the raw sqlite handle (tests,
 * low-level table setup).
 */
export function getDatabase(): Database {
  const exec = getExecutor()
  if (exec.sqliteDb)
    return exec.sqliteDb
  throw new Error(
    `[bun-query-builder] getDatabase() is only available for the sqlite dialect; `
    + `the configured dialect is '${exec.dialect}'. Use the async model API instead.`,
  )
}

/** The column soft deletes are tracked on (matches the migration + `delete()`). */
const SOFT_DELETE_COLUMN = 'deleted_at'

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
  private _relations: Record<string, ModelInstance<any, any>[] | ModelInstance<any, any> | null> = {}

  constructor(definition: TDef, attributes: Partial<ModelAttributes<TDef>> = {}) {
    this._definition = definition
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

  async save(): Promise<this> {
    const exec = getExecutor()
    const pk = this._definition.primaryKey || 'id'
    const hooks = this._definition.hooks

    const setters = this._definition.set || {}
    for (const [key, setter] of Object.entries(setters)) {
      if (this.isDirty(key as ColumnName<TDef>)) {
        // Write back in the storage casing, or a camelCase mutator would add a
        // second key alongside the column it was meant to replace.
        this._attributes[toSnakeCase(key)] = setter(this._attributes as Record<string, unknown>)
      }
    }

    if (this._attributes[pk]) {
      // Update
      await hooks?.beforeUpdate?.(this as unknown as ModelHookInstance, this.getChanges())

      const changes = this.getChanges()
      const changeKeys = Object.keys(changes)
      if (changeKeys.length > 0) {
        const sets = changeKeys.map(k => `${k} = ?`).join(', ')
        const values = [...Object.values(changes), this._attributes[pk]]

        if (timestampsEnabled(this._definition)) {
          const now = formatNow()
          await exec.run(
            `UPDATE ${this._definition.table} SET ${sets}, updated_at = ? WHERE ${pk} = ?`,
            [...Object.values(changes), now, this._attributes[pk]]
          )
        }
        else {
          await exec.run(`UPDATE ${this._definition.table} SET ${sets} WHERE ${pk} = ?`, values)
        }
      }

      await hooks?.afterUpdate?.(this as unknown as ModelHookInstance)
    }
    else {
      // Create
      const attrs = this._definition.attributes
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
        if (attr.guarded && !this._forced.has(toSnakeCase(key))) continue
        // `attrs` keys are whatever casing the model declared them with
        // (commonly camelCase, e.g. `memberCount`) but `_attributes` is
        // always snake_case (see normalizeAttributeKeys) — same casing a
        // read produces. Normalize the lookup and write the column under
        // its real (snake_case) name, since that's what the table has.
        const col = toSnakeCase(key)
        if (this._attributes[col] !== undefined) {
          data[col] = this._attributes[col]
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
      for (const key of Object.keys(this._attributes)) {
        if (key.endsWith('_id') && key !== pk && !(key in data)) {
          data[key] = this._attributes[key]
        }
      }

      if (timestampsEnabled(this._definition)) {
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
        const supplied = this._attributes.created_at
        data.created_at = supplied === undefined || supplied === null ? now : supplied
        data.updated_at = now
      }

      if (this._definition.traits?.useUuid && !data.uuid) {
        data.uuid = crypto.randomUUID()
      }

      await hooks?.beforeCreate?.(data)

      const columns = Object.keys(data)
      const placeholders = columns.map(() => '?').join(', ')

      const result = await exec.insert(
        `INSERT INTO ${this._definition.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        Object.values(data),
        pk,
      )

      for (const [key, value] of Object.entries(data)) {
        this._attributes[key] = value
      }
      if (result.lastInsertId != null)
        this._attributes[pk] = result.lastInsertId

      await hooks?.afterCreate?.(this as unknown as ModelHookInstance)
    }

    this._original = { ...this._attributes }
    this._hasSaved = true
    return this
  }

  async update(data: FillableAttributes<TDef>): Promise<this> {
    this.fill(data)
    return this.save()
  }

  /**
   * Re-read this row from the database and return a *new* ModelInstance
   * with the latest values. Does NOT mutate the receiver — pair with
   * `.refresh()` if you want in-place update.
   *
   * @returns the freshly-fetched row, or `null` if the row no longer exists.
   */
  async fresh(): Promise<ModelInstance<TDef, TSelected> | null> {
    const exec = getExecutor()
    const pk = this._definition.primaryKey || 'id'
    const id = this._attributes[pk]
    if (id == null) return null
    const row = await exec.get(`SELECT * FROM ${this._definition.table} WHERE ${pk} = ?`, [id])
    if (!row) return null
    return new ModelInstance(this._definition, row as Partial<ModelAttributes<TDef>>)
  }

  async delete(): Promise<boolean> {
    const exec = getExecutor()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk]
    const hooks = this._definition.hooks

    if (!pkValue) throw new Error('Cannot delete a model without a primary key')

    await hooks?.beforeDelete?.(this as unknown as ModelHookInstance)

    if (softDeletesEnabled(this._definition)) {
      const now = formatNow()
      await exec.run(
        `UPDATE ${this._definition.table} SET deleted_at = ? WHERE ${pk} = ?`,
        [now, pkValue]
      )
      // Reflect the soft delete on the in-memory instance so `trashed()` and
      // reads of `deleted_at` are consistent without a refresh. See #1024.
      this._attributes[SOFT_DELETE_COLUMN] = now
    }
    else {
      await exec.run(`DELETE FROM ${this._definition.table} WHERE ${pk} = ?`, [pkValue])
    }

    await hooks?.afterDelete?.(this as unknown as ModelHookInstance)

    return true
  }

  /**
   * Restore a soft-deleted row by clearing `deleted_at`. Throws if the model
   * doesn't use soft deletes. See stacksjs/bun-query-builder#1024.
   */
  async restore(): Promise<this> {
    if (!softDeletesEnabled(this._definition as ModelDefinition))
      throw new Error(`[orm] restore() requires soft deletes on '${this._definition.name}'`)
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk]
    if (!pkValue) throw new Error('Cannot restore a model without a primary key')
    await getExecutor().run(
      `UPDATE ${this._definition.table} SET ${SOFT_DELETE_COLUMN} = ? WHERE ${pk} = ?`,
      [null, pkValue],
    )
    this._attributes[SOFT_DELETE_COLUMN] = null
    this._original = null
    return this
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
  async refresh(): Promise<this | null> {
    const exec = getExecutor()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk]

    if (!pkValue) throw new Error('Cannot refresh a model without a primary key')

    const row = await exec.get(`SELECT * FROM ${this._definition.table} WHERE ${pk} = ?`, [pkValue])
    if (!row) return null
    this._attributes = row
    this._original = null // post-refresh, nothing is dirty
    return this
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
    return new ModelInstance<TDef, TSelected>(this._definition, attrs as any)
  }

  toArray(): Record<string, unknown> {
    const values: Record<string, unknown> = { ...this._attributes }

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

  toJSON(): Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, HiddenKeys<TDef>> {
    const hidden = new Set<string>()
    for (const [key, attr] of Object.entries(this._definition.attributes)) {
      if (attr.hidden) hidden.add(key)
    }

    const json: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this._attributes)) {
      if (!hidden.has(key)) json[key] = value
    }

    for (const [relName, relData] of Object.entries(this._relations)) {
      if (Array.isArray(relData)) {
        json[relName] = relData.map(r => r.toJSON())
      }
      else if (relData) {
        json[relName] = relData.toJSON()
      }
      else {
        json[relName] = null
      }
    }

    return json as any
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
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany' | 'hasManyThrough' | 'hasOneThrough'
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
const RESOLVABLE_RELATION_KINDS = ['hasMany', 'hasOne', 'belongsTo', 'belongsToMany'] as const
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
    return rel.map(item => (typeof item === 'string' ? item : String((item as any)?.model ?? ''))).filter(Boolean)
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
        const modelName = typeof item === 'string' ? item : (item as any)?.model || ''
        if (modelName && modelName.toLowerCase() === relationName.toLowerCase()) {
          return modelName
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
      // Array form: the relation name IS the (lowercased) model name.
      for (const item of rel) {
        const e = unwrap(item)
        if (e && e.model.toLowerCase() === lower) return e
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

  /** Filter by a column on the related table. */
  where(column: string, opOrValue: unknown, value?: unknown): this {
    if (value === undefined) {
      this._wheres.push({ sql: `${this.relatedTable}.${column} = ?`, params: [opOrValue] })
    }
    else {
      this._wheres.push({ sql: `${this.relatedTable}.${column} ${String(opOrValue)} ?`, params: [value] })
    }
    return this
  }

  /** Filter by a column on the pivot table. */
  wherePivot(column: string, opOrValue: unknown, value?: unknown): this {
    if (value === undefined) {
      this._pivotWheres.push({ sql: `${this.pivotTable}.${column} = ?`, params: [opOrValue] })
    }
    else {
      this._pivotWheres.push({ sql: `${this.pivotTable}.${column} ${String(opOrValue)} ?`, params: [value] })
    }
    return this
  }

  wherePivotIn(column: string, values: unknown[]): this {
    if (!values.length) return this
    const placeholders = values.map(() => '?').join(', ')
    this._pivotWheres.push({ sql: `${this.pivotTable}.${column} IN (${placeholders})`, params: [...values] })
    return this
  }

  wherePivotNotIn(column: string, values: unknown[]): this {
    if (!values.length) return this
    const placeholders = values.map(() => '?').join(', ')
    this._pivotWheres.push({ sql: `${this.pivotTable}.${column} NOT IN (${placeholders})`, params: [...values] })
    return this
  }

  wherePivotNull(column: string): this {
    this._pivotWheres.push({ sql: `${this.pivotTable}.${column} IS NULL`, params: [] })
    return this
  }

  wherePivotNotNull(column: string): this {
    this._pivotWheres.push({ sql: `${this.pivotTable}.${column} IS NOT NULL`, params: [] })
    return this
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    assertValidOrderByColumn(column, 'orderBy(column)')
    if (direction !== 'asc' && direction !== 'desc')
      throw new TypeError(`[bun-query-builder] orderBy(direction): expected 'asc' or 'desc', got '${direction}'`)
    this._orderBy.push(`${column} ${direction.toUpperCase()}`)
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
      .map(c => `${this.relatedTable}.${c} AS ${BTM_RELATED_ALIAS}${c}`)
      .join(', ')
    let sql = `SELECT ${relatedSelect}, ${this.pivotTable}.* FROM ${this.relatedTable}`
    sql += ` INNER JOIN ${this.pivotTable} ON ${this.pivotTable}.${this.fkRelated} = ${this.relatedTable}.${this.relatedPk}`
    sql += ` WHERE ${this.pivotTable}.${this.fkParent} = ?`
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
      const inst = new ModelInstance(this._relatedDef, relatedRow as any)
      ;(inst as any).pivot = pivotExtras
      return inst
    })
  }

  async get(): Promise<ModelInstance<TRel, any>[]> {
    const exec = getExecutor()
    const { sql, params } = this.buildSelect()
    const rows = await exec.all(sql, params)
    return this.hydrateRows(rows)
  }

  async first(): Promise<ModelInstance<TRel, any> | undefined> {
    this._limit = 1
    return (await this.get())[0]
  }

  async count(): Promise<number> {
    const exec = getExecutor()
    let sql = `SELECT COUNT(*) as count FROM ${this.pivotTable} WHERE ${this.fkParent} = ?`
    const params: unknown[] = [this.parentId]
    for (const w of this._pivotWheres) {
      sql += ` AND ${w.sql}`
      params.push(...w.params)
    }
    const row = await exec.get(sql, params)
    return Number((row as { count: number } | undefined)?.count ?? 0)
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
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
  async attach(idOrIds: unknown | unknown[], extras: Record<string, unknown> = {}): Promise<number> {
    const exec = getExecutor()
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
    if (ids.length === 0) return 0
    const ts = this._resolved.pivotTimestamps ? this.now() : null
    let inserted = 0
    for (const relatedId of ids) {
      const row: Record<string, unknown> = {
        [this.fkParent]: this.parentId,
        [this.fkRelated]: relatedId,
        ...extras,
      }
      if (ts) {
        if (row.created_at === undefined) row.created_at = ts
        if (row.updated_at === undefined) row.updated_at = ts
      }
      const cols = Object.keys(row)
      const placeholders = cols.map(() => '?').join(', ')
      const sql = `INSERT INTO ${this.pivotTable} (${cols.join(', ')}) VALUES (${placeholders})`
      const params = cols.map(c => row[c])
      await exec.run(sql, params)
      inserted++
    }
    return inserted
  }

  /**
   * Detach related rows from the parent. With no argument, detaches all.
   * Returns the count of deleted rows.
   */
  async detach(idOrIds?: unknown | unknown[]): Promise<number> {
    const exec = getExecutor()
    let sql = `DELETE FROM ${this.pivotTable} WHERE ${this.fkParent} = ?`
    const params: unknown[] = [this.parentId]
    if (idOrIds !== undefined && idOrIds !== null) {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
      if (ids.length === 0) return 0
      const placeholders = ids.map(() => '?').join(', ')
      sql += ` AND ${this.fkRelated} IN (${placeholders})`
      params.push(...ids)
    }
    return (await exec.run(sql, params)).changes
  }

  /**
   * Update extras on an existing pivot row, identified by the related id.
   * Returns the number of pivot rows updated (0 or 1).
   */
  async updateExistingPivot(relatedId: unknown, extras: Record<string, unknown>): Promise<number> {
    const exec = getExecutor()
    const updates = { ...extras }
    if (this._resolved.pivotTimestamps && updates.updated_at === undefined) {
      updates.updated_at = this.now()
    }
    const cols = Object.keys(updates)
    if (cols.length === 0) return 0
    const setClause = cols.map(c => `${c} = ?`).join(', ')
    const sql = `UPDATE ${this.pivotTable} SET ${setClause} WHERE ${this.fkParent} = ? AND ${this.fkRelated} = ?`
    const params = [...cols.map(c => updates[c]), this.parentId, relatedId]
    return (await exec.run(sql, params)).changes
  }

  /**
   * Reconcile the pivot to exactly match `items`. Pivot rows whose related id
   * is missing from `items` are detached; rows that exist remain (and are
   * updated when extras differ); rows that don't yet exist are attached.
   *
   * `items` may be a list of plain ids (no extras) or `{ id, ...extras }`
   * objects.
   */
  async sync(items: Array<unknown | { id: unknown, [key: string]: unknown }>): Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }> {
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
    const current = await exec.all(
      `SELECT * FROM ${this.pivotTable} WHERE ${this.fkParent} = ?`,
      [this.parentId],
    )
    const currentIds = new Set(current.map(r => r[this.fkRelated]))

    const attached: unknown[] = []
    const detached: unknown[] = []
    const updated: unknown[] = []

    // Detach missing
    const toDetach = [...currentIds].filter(id => !desired.has(id))
    if (toDetach.length > 0) {
      await this.detach(toDetach)
      detached.push(...toDetach)
    }

    // Attach or update
    for (const [id, extras] of desired) {
      if (!currentIds.has(id)) {
        await this.attach(id, extras)
        attached.push(id)
      }
      else if (Object.keys(extras).length > 0) {
        await this.updateExistingPivot(id, extras)
        updated.push(id)
      }
    }

    return { attached, detached, updated }
  }

  /**
   * For each id, attach if currently detached, detach if currently attached.
   * Returns `{ attached, detached }`.
   */
  async toggle(idOrIds: unknown | unknown[]): Promise<{ attached: unknown[], detached: unknown[] }> {
    const exec = getExecutor()
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
    if (ids.length === 0) return { attached: [], detached: [] }
    const placeholders = ids.map(() => '?').join(', ')
    const present = await exec.all(
      `SELECT ${this.fkRelated} FROM ${this.pivotTable} WHERE ${this.fkParent} = ? AND ${this.fkRelated} IN (${placeholders})`,
      [this.parentId, ...ids],
    )
    const presentIds = new Set(present.map(r => r[this.fkRelated]))

    const toAttach = ids.filter(id => !presentIds.has(id))
    const toDetach = ids.filter(id => presentIds.has(id))
    if (toAttach.length > 0) await this.attach(toAttach)
    if (toDetach.length > 0) await this.detach(toDetach)
    return { attached: toAttach, detached: toDetach }
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
  private _wheres: { column?: string; operator?: WhereOperator; value?: unknown; boolean: 'and' | 'or'; raw?: string; rawParams?: unknown[] }[] = []
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

  whereLike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'and' })
    return this
  }

  orWhereLike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'or' })
    return this
  }

  whereNotLike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not like', value: pattern, boolean: 'and' })
    return this
  }

  orWhereNotLike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not like', value: pattern, boolean: 'or' })
    return this
  }

  /**
   * Append a raw SQL fragment as a WHERE clause, with optional positional
   * parameters. Use this when you need a nested OR-group or any SQL the
   * builder doesn't expose directly.
   *
   * @example
   * ```ts
   * Car.query()
   *   .where('status', 'active')
   *   .whereRaw('(LOWER(make) LIKE ? OR LOWER(model) LIKE ?)', '%tesla%', '%tesla%')
   *   .get()
   * ```
   */
  whereRaw(fragment: string, ...params: unknown[]): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ raw: fragment, rawParams: params, boolean: 'and' })
    return this
  }

  orWhereRaw(fragment: string, ...params: unknown[]): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ raw: fragment, rawParams: params, boolean: 'or' })
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
    const col = sqlColumn(column as string)
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
        const col = sqlColumn(w.column!)
        clause = w.operator === '=' ? `${col} IS NULL` : `${col} IS NOT NULL`
      }
      else if (w.operator === 'in' || w.operator === 'not in') {
        // `IN ()` is a syntax error on Postgres and MySQL while SQLite parses
        // it, so the empty case renders as a constant predicate instead — see
        // renderInPredicate for why the NOT IN mirror is TRUE, not FALSE.
        const arr = w.value as unknown[]
        clause = renderInPredicate(sqlColumn(w.column!), arr, w.operator === 'not in', arr.map(() => '?').join(', '))
        params.push(...arr)
      }
      else {
        clause = `${sqlColumn(w.column!)} ${w.operator} ?`
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
    const cols = this._select.map(c => (c === '*' ? c : sqlColumn(c)))
    let sql = `SELECT ${cols.join(', ')} FROM ${this._definition.table}`

    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    if (this._orderBy.length > 0) {
      sql += ` ORDER BY ${this._orderBy.map(o => `${sqlColumn(o.column)} ${o.direction.toUpperCase()}`).join(', ')}`
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
  private async eagerLoadRelations(instances: ModelInstance<TDef, TSelected>[]): Promise<void> {
    if (instances.length === 0 || this._withRelations.length === 0) return
    await Promise.all(this._withRelations.map(r => this.eagerLoadRelation(r, instances)))
  }

  private async eagerLoadRelation(relationName: string, instances: ModelInstance<TDef, TSelected>[]): Promise<void> {
    const exec = getExecutor()
    const pk = this._definition.primaryKey || 'id'

    // Cache relation resolution per model+relation pair
    const cacheKey = `${this._definition.name}:${relationName}`
    let rel = relationCache.get(cacheKey)
    if (rel === undefined) {
      rel = resolveRelation(this._definition as ModelDefinition, relationName)
      if (relationCache.size >= RELATION_CACHE_MAX)
        relationCache.clear()
      relationCache.set(cacheKey, rel)
    }
    if (!rel)
      throw new Error(unresolvedRelationMessage(this._definition as ModelDefinition, relationName))

    if (rel.type === 'hasMany' || rel.type === 'hasOne') {
      // Get parent IDs
      const parentIds = distinctParentIds(instances, pk)
      if (parentIds.length === 0) return

      const placeholders = parentIds.map(() => '?').join(', ')
      const rows = await exec.all(
        `SELECT * FROM ${rel.relatedTable} WHERE ${rel.foreignKey} IN (${placeholders})`,
        parentIds,
      )

      // Try to get the related model's definition for proper instances
      const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
      const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition

      if (rel.type === 'hasMany') {
        // Group by foreign key
        const grouped = new Map<unknown, Record<string, unknown>[]>()
        for (const row of rows) {
          const fkVal = row[rel.foreignKey]
          if (!grouped.has(fkVal)) grouped.set(fkVal, [])
          grouped.get(fkVal)!.push(row)
        }
        for (const instance of instances) {
          const related = grouped.get(instance.get(pk as any)) || []
          instance.setRelation(relationName, related.map(r => new ModelInstance(relDef as any, r as any)))
        }
      }
      else {
        // hasOne - single record per parent. First row wins: the rows arrive
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
          instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any) : null)
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
      if (uniqueFkValues.length === 0) return

      const placeholders = uniqueFkValues.map(() => '?').join(', ')
      const rows = await exec.all(
        `SELECT * FROM ${rel.relatedTable} WHERE ${rel.localKey} IN (${placeholders})`,
        uniqueFkValues,
      )

      const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
      const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition

      const byPk = new Map<unknown, Record<string, unknown>>()
      for (const row of rows) {
        byPk.set(row[rel.localKey], row)
      }

      for (const instance of instances) {
        const fkVal = (instance as any)._attributes[rel.foreignKey]
        const row = byPk.get(fkVal)
        instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any) : null)
      }
    }

    if (rel.type === 'belongsToMany') {
      const parentIds = distinctParentIds(instances, pk)
      if (parentIds.length === 0) return
      if (!rel.pivotTable || !rel.pivotFkParent || !rel.pivotFkRelated) return

      // 1) Fetch pivot rows for these parents.
      const pivotPlaceholders = parentIds.map(() => '?').join(', ')
      const pivotRows = await exec.all(
        `SELECT * FROM ${rel.pivotTable} WHERE ${rel.pivotFkParent} IN (${pivotPlaceholders})`,
        parentIds,
      )

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
      const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition
      const relatedPk = relDef?.primaryKey || 'id'

      let relatedRows: Record<string, unknown>[] = []
      if (relatedIds.length > 0) {
        const relPlaceholders = relatedIds.map(() => '?').join(', ')
        relatedRows = await exec.all(
          `SELECT * FROM ${rel.relatedTable} WHERE ${relatedPk} IN (${relPlaceholders})`,
          relatedIds,
        )
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
            const inst = new ModelInstance(relDef as any, relRow as any)
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
      const throughRows = await exec.all(
        `SELECT ${throughPk}, ${rel.throughForeignKey} FROM ${rel.throughTable} WHERE ${rel.throughForeignKey} IN (${throughPh})`,
        parentIds,
      )
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
      const targetRows = await exec.all(
        `SELECT * FROM ${rel.relatedTable} WHERE ${rel.targetForeignKey} IN (${targetPh})`,
        throughIds,
      )

      const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
      const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition

      // Group target rows by parent (target.targetFk → throughId → parentId).
      const byParent = new Map<unknown, ModelInstance<any, any>[]>()
      for (const row of targetRows) {
        const parentVal = throughToParent.get(row[rel.targetForeignKey!])
        if (parentVal == null) continue
        if (!byParent.has(parentVal)) byParent.set(parentVal, [])
        byParent.get(parentVal)!.push(new ModelInstance(relDef as any, row as any))
      }

      for (const instance of instances) {
        const group = byParent.get(instance.get(pk as any)) || []
        instance.setRelation(relationName, rel.type === 'hasManyThrough' ? group : (group[0] ?? null))
      }
    }
  }

  async get(): Promise<ModelRecord<TDef, TSelected>[]> {
    const exec = getExecutor()
    const { sql, params } = this.buildQuery()
    const rows = await exec.all(sql, params)
    const instances = rows.map(row => new ModelInstance<TDef, TSelected>(this._definition, row as any))

    // Eager load relations
    if (this._withRelations.length > 0) {
      await this.eagerLoadRelations(instances)
    }

    return instances as ModelRecord<TDef, TSelected>[]
  }

  async first(): Promise<ModelRecord<TDef, TSelected> | undefined> {
    this._limit = 1
    return (await this.get())[0]
  }

  async firstOrFail(): Promise<ModelRecord<TDef, TSelected>> {
    const result = await this.first()
    if (!result) throw new Error(`No ${this._definition.name} found`)
    return result
  }

  async last(): Promise<ModelRecord<TDef, TSelected> | undefined> {
    const pk = this._definition.primaryKey || 'id'
    this._orderBy = [{ column: pk, direction: 'desc' }]
    this._limit = 1
    return (await this.get())[0]
  }

  async count(): Promise<number> {
    const exec = getExecutor()
    const params: unknown[] = []
    let sql = `SELECT COUNT(*) as count FROM ${this._definition.table}`

    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    const row = await exec.get(sql, params)
    return Number((row as { count: number } | undefined)?.count ?? 0)
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  async doesntExist(): Promise<boolean> {
    return (await this.count()) === 0
  }

  /**
   * Get a single record, throwing if zero or more than one match.
   *
   * @example
   * ```ts
   * const admin = User.where('role', 'admin').sole()
   * ```
   */
  async sole(): Promise<ModelRecord<TDef, TSelected>> {
    this._limit = 2 // fetch 2 to detect duplicates
    const results = await this.get()
    if (results.length === 0) throw new Error(`No ${this._definition.name} found`)
    if (results.length > 1) throw new Error(`Expected one ${this._definition.name}, found multiple`)
    return results[0]
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
  async increment<K extends NumericColumns<TDef>>(column: K, amount = 1): Promise<number> {
    assertValidIdentifier(column, 'increment(column)')
    this.assertNoUnappliedClauses('increment')
    const exec = getExecutor()
    const params: unknown[] = [amount]

    const incCol = sqlColumn(column as string)
    let sql = `UPDATE ${this._definition.table} SET ${incCol} = ${incCol} + ?`

    if (timestampsEnabled(this._definition)) {
      sql += `, updated_at = ?`
      params.push(formatNow())
    }

    // See delete(): composeWhere is the only path that adds the soft-delete
    // predicate, so a scoped counter bump has to go through it. #1111.
    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    return (await exec.run(sql, params)).changes
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
  decrement<K extends NumericColumns<TDef>>(column: K, amount = 1): Promise<number> {
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
  async chunk(size: number, callback: (items: ModelInstance<TDef, TSelected>[]) => void | false | Promise<void | false>): Promise<void> {
    let page = 0
    while (true) {
      const builder = new ModelQueryBuilder<TDef, TSelected>(this._definition)
      // Copy wheres, orders, and relations
      builder._wheres = [...this._wheres]
      builder._orderBy = [...this._orderBy]
      builder._select = [...this._select]
      builder._withRelations = [...this._withRelations]
      builder._trashed = this._trashed
      builder._limit = size
      builder._offset = page * size

      const results = await builder.get()
      if (results.length === 0) break

      const result = await callback(results)
      if (result === false) break
      if (results.length < size) break

      page++
    }
  }

  async paginate(page: number | PaginateOptions = 1, perPage = 15): Promise<{
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
  }> {
    // Options form: `paginate({ page, perPage })`. This API is (page, perPage)
    // and the query builder's is (perPage, page); both arguments are numbers,
    // so transposing them returns a different page rather than raising
    // anything. Naming them cannot be got wrong. See #1092.
    if (typeof page === 'object' && page !== null) {
      const options = page
      perPage = options.perPage ?? 15
      page = options.page ?? 1
    }
    const total = await this.count()
    const lastPage = Math.ceil(total / perPage)
    this._limit = perPage
    this._offset = (page - 1) * perPage
    const data = await this.get()
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
  }

  async pluck<K extends ColumnName<TDef>>(
    column: K
  ): Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]> {
    assertValidIdentifier(column, 'pluck(column)')
    // Raw query — avoid creating ModelInstance objects just to extract one column
    const exec = getExecutor()
    const params: unknown[] = []
    const pluckCol = sqlColumn(column as string)
    let sql = `SELECT ${pluckCol} FROM ${this._definition.table}`

    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }
    if (this._orderBy.length > 0) {
      sql += ` ORDER BY ${this._orderBy.map(o => `${sqlColumn(o.column)} ${o.direction.toUpperCase()}`).join(', ')}`
    }
    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`

    const rows = await exec.all(sql, params)
    return rows.map(r => r[pluckCol]) as any
  }

  private async aggregate(fn: string, column: string): Promise<unknown> {
    // The aggregate function name comes from internal call sites
    // (max/min/avg/sum below) so it's bounded — but validate column
    // since callers pass user-derived field names to those wrappers.
    assertValidIdentifier(column, `${fn}(column)`)
    const exec = getExecutor()
    const params: unknown[] = []
    let sql = `SELECT ${fn}(${sqlColumn(column)}) as v FROM ${this._definition.table}`

    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    const row = await exec.get(sql, params) as { v: unknown } | undefined
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
  }

  max<K extends ColumnName<TDef>>(column: K): Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null> {
    return this.aggregate('MAX', column as string) as Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null>
  }

  min<K extends ColumnName<TDef>>(column: K): Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null> {
    return this.aggregate('MIN', column as string) as Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : number) | null>
  }

  async avg<K extends NumericColumns<TDef>>(column: K): Promise<number> {
    return Number(await this.aggregate('AVG', column as string) ?? 0) || 0
  }

  async sum<K extends NumericColumns<TDef>>(column: K): Promise<number> {
    return Number(await this.aggregate('SUM', column as string) ?? 0) || 0
  }

  async delete(): Promise<number> {
    this.assertNoUnappliedClauses('delete')
    const exec = getExecutor()
    const params: unknown[] = []
    let sql = `DELETE FROM ${this._definition.table}`

    // composeWhere, not buildWhereClauses: the soft-delete predicate is added
    // only by composeWhere, so building the WHERE here meant a scope that
    // exists purely as that predicate contributed nothing to the statement.
    // `onlyTrashed().delete()` — purge the trash — emitted a bare DELETE and
    // removed every row, live ones included. See #1111.
    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    return (await exec.run(sql, params)).changes
  }

  async update(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): Promise<number> {
    this.assertNoUnappliedClauses('update')
    const exec = getExecutor()
    const entries = Object.entries(data)
    const sets = entries.map(([k]) => `${sqlColumn(k)} = ?`).join(', ')
    const params: unknown[] = entries.map(([, v]) => v)

    if (timestampsEnabled(this._definition)) {
      params.push(formatNow())
    }

    let sql = `UPDATE ${this._definition.table} SET ${sets}${timestampsEnabled(this._definition) ? ', updated_at = ?' : ''}`

    // See delete(): composeWhere is the only path that adds the soft-delete
    // predicate, so a scoped update has to go through it. #1111.
    const whereBody = this.composeWhere(params)
    if (whereBody) {
      sql += ` WHERE ${whereBody}`
    }

    return (await exec.run(sql, params)).changes
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
  find: (id: number | string) => Promise<ModelRecord<TDef> | undefined>
  findOrFail: (id: number | string) => Promise<ModelRecord<TDef>>
  findMany: (ids: (number | string)[]) => Promise<ModelRecord<TDef>[]>
  all: () => Promise<ModelRecord<TDef>[]>
  first: () => Promise<ModelRecord<TDef> | undefined>
  firstOrFail: () => Promise<ModelRecord<TDef>>
  last: () => Promise<ModelRecord<TDef> | undefined>
  count: () => Promise<number>
  exists: () => Promise<boolean>
  doesntExist: () => Promise<boolean>
  paginate: (page?: number | PaginateOptions, perPage?: number) => Promise<{
    data: ModelRecord<TDef>[]
    total: number
    page: number
    perPage: number
    lastPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
  }>
  whereBetween: <K extends ColumnName<TDef>>(column: K, range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown]) => ModelQueryBuilder<TDef>
  whereNotBetween: <K extends ColumnName<TDef>>(column: K, range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown]) => ModelQueryBuilder<TDef>
  create: (data: FillableAttributes<TDef>) => Promise<ModelRecord<TDef>>
  createMany: (items: FillableAttributes<TDef>[]) => Promise<ModelRecord<TDef>[]>
  updateOrCreate: (search: Partial<ModelAttributes<TDef>>, data: FillableAttributes<TDef>) => Promise<ModelRecord<TDef>>
  firstOrCreate: (search: Partial<ModelAttributes<TDef>>, data?: FillableAttributes<TDef>) => Promise<ModelRecord<TDef>>
  destroy: (id: number | string) => Promise<boolean>
  remove: (id: number | string) => Promise<boolean>
  truncate: () => Promise<void>
  getDefinition: () => TDef
  getTable: () => string
  make: (data?: Partial<ModelAttributes<TDef>>) => ModelInstance<TDef>
  latest: (column?: ColumnName<TDef>) => ModelQueryBuilder<TDef>
  oldest: (column?: ColumnName<TDef>) => ModelQueryBuilder<TDef>
  max: <K extends ColumnName<TDef>>(column: K) => Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) | null>
  min: <K extends ColumnName<TDef>>(column: K) => Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) | null>
  avg: <K extends NumericColumns<TDef>>(column: K) => Promise<number>
  sum: <K extends NumericColumns<TDef>>(column: K) => Promise<number>
  pluck: <K extends ColumnName<TDef>>(column: K) => Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]>
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

    async find(id: number | string): Promise<ModelRecord<TDef> | undefined> {
      const exec = getExecutor()
      const pk = definition.primaryKey || 'id'
      // Exclude soft-deleted rows by default (use withTrashed()/query() to override).
      const sd = softDeletesEnabled(definition) ? ` AND ${SOFT_DELETE_COLUMN} IS NULL` : ''
      const row = await exec.get(`SELECT * FROM ${definition.table} WHERE ${pk} = ?${sd}`, [id])
      return row ? new ModelInstance<TDef>(definition, row as any) as ModelRecord<TDef> : undefined
    },

    async findOrFail(id: number | string): Promise<ModelRecord<TDef>> {
      const result = await model.find(id)
      if (!result) throw new Error(`${definition.name} with id ${id} not found`)
      return result
    },

    async findMany(ids: (number | string)[]): Promise<ModelRecord<TDef>[]> {
      const exec = getExecutor()
      const pk = definition.primaryKey || 'id'
      const sd = softDeletesEnabled(definition) ? ` AND ${SOFT_DELETE_COLUMN} IS NULL` : ''
      const rows = await exec.all(`SELECT * FROM ${definition.table} WHERE ${pk} IN (${ids.map(() => '?').join(', ')})${sd}`, ids)
      return rows.map(row => new ModelInstance<TDef>(definition, row as any) as ModelRecord<TDef>)
    },

    all: () => new ModelQueryBuilder<TDef>(definition).get(),
    first: () => new ModelQueryBuilder<TDef>(definition).first(),
    firstOrFail: () => new ModelQueryBuilder<TDef>(definition).firstOrFail(),
    last: () => new ModelQueryBuilder<TDef>(definition).last(),
    count: () => new ModelQueryBuilder<TDef>(definition).count(),
    exists: () => new ModelQueryBuilder<TDef>(definition).exists(),
    doesntExist: () => new ModelQueryBuilder<TDef>(definition).doesntExist(),
    paginate: (page?: number | PaginateOptions, perPage?: number) => new ModelQueryBuilder<TDef>(definition).paginate(page as any, perPage),

    whereBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereBetween(column, range as any)
    },

    whereNotBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereNotBetween(column, range as any)
    },

    async create(data: FillableAttributes<TDef>): Promise<ModelRecord<TDef>> {
      const instance = new ModelInstance<TDef>(definition, data as any)
      await instance.save()
      return instance as ModelRecord<TDef>
    },

    async createMany(items: FillableAttributes<TDef>[]): Promise<ModelRecord<TDef>[]> {
      // Sequential to preserve insertion order and avoid hammering a single
      // connection with concurrent writes.
      const out: ModelRecord<TDef>[] = []
      for (const data of items) out.push(await this.create(data))
      return out
    },

    async updateOrCreate(
      search: Partial<Attrs>,
      data: FillableAttributes<TDef>
    ): Promise<ModelRecord<TDef>> {
      let query = new ModelQueryBuilder<TDef>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key as Cols, value as any)
      }
      const existing = await query.first()
      if (existing) {
        await existing.update(data)
        return existing
      }
      return this.create({ ...search, ...data } as any)
    },

    async firstOrCreate(
      search: Partial<Attrs>,
      data: FillableAttributes<TDef>
    ): Promise<ModelRecord<TDef>> {
      let query = new ModelQueryBuilder<TDef>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key as Cols, value as any)
      }
      const existing = await query.first()
      return existing || this.create({ ...search, ...data } as any)
    },

    async destroy(id: number | string): Promise<boolean> {
      const exec = getExecutor()
      const pk = definition.primaryKey || 'id'
      return (await exec.run(`DELETE FROM ${definition.table} WHERE ${pk} = ?`, [id])).changes > 0
    },

    remove(id: number | string): Promise<boolean> {
      return this.destroy(id)
    },

    async truncate(): Promise<void> {
      await getExecutor().run(`DELETE FROM ${definition.table}`, [])
    },

    getDefinition: () => definition,
    getTable: () => definition.table,

    make(data: Partial<Attrs> = {}): ModelInstance<TDef> {
      return new ModelInstance<TDef>(definition, data as any)
    },

    latest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderByDesc(column),
    oldest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderBy(column, 'asc'),

    max: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).max(column),
    min: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).min(column),
    avg: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).avg(column),
    sum: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).sum(column),

    pluck<K extends ColumnName<TDef>>(column: K): Promise<(K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]> {
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

export async function createTableFromModel(definition: ModelDefinition): Promise<void> {
  const exec = getExecutor()
  const pk = toSnakeCase(definition.primaryKey || 'id')
  const columns: string[] = []
  const emitted = new Set<string>([pk])

  columns.push(definition.autoIncrement !== false
    ? `${pk} INTEGER PRIMARY KEY AUTOINCREMENT`
    : `${pk} INTEGER PRIMARY KEY`)

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
    let colDef = `${name} ${colType}`
    if (attr.unique) colDef += ' UNIQUE'
    // Inline FK constraints for SQLite CREATE TABLE
    if (typeof attr.foreignKey === 'object' && attr.foreignKey !== null) {
      const fk = attr.foreignKey as import('./schema').ForeignKeyConfig
      colDef += ` REFERENCES ${fk.table}(${fk.column ?? 'id'})`
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
    columns.push(`${name} INTEGER`)
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

  await exec.run(`CREATE TABLE IF NOT EXISTS ${definition.table} (${columns.join(', ')})`, [])
}

export async function seedModel(definition: ModelDefinition, count?: number, faker?: Record<string, unknown>): Promise<void> {
  const exec = getExecutor()
  const seeder = definition.traits?.useSeeder
  const seedCount = count ?? (typeof seeder === 'object' && seeder ? seeder.count : 10)

  if (!faker) {
    try {
      const tsFaker = await (import('@stacksjs/ts-faker' as string) as Promise<{ faker: Record<string, unknown> }>)
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
    await exec.run(
      `INSERT INTO ${definition.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(data)
    )
  }
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
