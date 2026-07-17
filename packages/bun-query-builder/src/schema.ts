import type { Faker } from '@stacksjs/ts-faker'
// Minimal schema/type definitions to describe models and attributes

/**
 * # `ValidatorMessage`
 *
 * Map of field identifiers to custom error messages returned by validators.
 */

export type ValidatorMessage = Record<string, string>

export type OnForeignKeyAction = 'cascade' | 'set null' | 'restrict' | 'no action'

export interface ForeignKeyConfig {
  /** Referenced table name */
  table: string
  /** Referenced column (defaults to 'id') */
  column?: string
  /** ON DELETE behavior */
  onDelete?: OnForeignKeyAction
  /** ON UPDATE behavior */
  onUpdate?: OnForeignKeyAction
  /** Whether the FK column allows NULL */
  nullable?: boolean
}

/**
 * # `ValidationType`
 *
 * External validator rule type (compatible with ts-validation). Kept broad to
 * avoid a hard dependency while still enabling type inference via rule shape.
 */
export type ValidationType = unknown

/**
 * # `Attribute`
 *
 * Describes a model column and its validation/meta options.
 *
 * @example
 * ```ts
 * const User = defineModel({
 *   name: 'User',
 *   attributes: {
 *     email: { validation: { rule: {} // isEmail() }, unique: true },
 *     age: { validation: { rule: {} // isInt({ min: 0 }) }, default: 0 },
 *   }
 * })
 * ```
 */
export interface Attribute {
  /** Require a value and emit a NOT NULL column unless `nullable` overrides it. */
  required?: boolean
  /** Explicitly control database nullability. Takes precedence over `required`. */
  nullable?: boolean
  /** Explicit database column type. Takes precedence over validator inference. */
  type?: string
  default?: string | number | boolean | Date
  unique?: boolean
  order?: number
  hidden?: boolean
  fillable?: boolean
  guarded?: boolean
  /** Control FK constraint: false to skip, true to auto-infer, or explicit config */
  foreignKey?: boolean | ForeignKeyConfig
  factory?: (faker: Faker) => any
  validation: {
    rule: ValidationType
    message?: ValidatorMessage
  }
}

export interface AttributesElements {
  [key: string]: Attribute
}

/**
 * # `CompositeIndex`
 *
 * Describes a named multi-column index.
 *
 * @example
 * ```ts
 * { name: 'user_email_unique', columns: ['email'], unique: true }
 * { name: 'one_primary_per_athlete', columns: ['athlete_id'], unique: true, where: "role = 'primary'" }
 * ```
 */
export interface CompositeIndex {
  name: string
  columns: string[]
  /** Emit as `CREATE UNIQUE INDEX` when true. */
  unique?: boolean
  /**
   * Partial-index predicate. Postgres + SQLite support this; MySQL does not
   * and will throw at migration generation if set.
   */
  where?: string
}

export interface Base {}

export type ModelNames = string

/**
 * # Relationship helpers
 *
 * Lightweight relationship declarations for model definitions. Each helper is a
 * record keyed by relation name with the related model name as value.
 */
export type HasOne<T extends string> = Record<string, T>
export type HasMany<T extends string> = Record<string, T>
export type BelongsTo<T extends string> = Record<string, T>

/**
 * # `PivotColumnAttribute`
 *
 * Inline declaration of an extra column on the pivot table (Option A). When the
 * pivot is declared via a `through` model (Option B), columns are read from
 * that model's `attributes` instead.
 */
export interface PivotColumnAttribute {
  default?: string | number | boolean | Date
  nullable?: boolean
  validation?: {
    rule: ValidationType
    message?: ValidatorMessage
  }
}

/**
 * # `PivotConfig`
 *
 * Inline pivot configuration (Option A). Used when the pivot does not have its
 * own model in the registry. Migrations will auto-emit a table for this pivot.
 */
export interface PivotConfig {
  columns?: Record<string, PivotColumnAttribute>
  /** When true, pivot rows get `created_at` / `updated_at` populated by `attach`/`sync`. */
  timestamps?: boolean
  /** Composite-unique tuples to enforce on the pivot (e.g. `[['coach_id', 'athlete_id']]`). */
  uniques?: string[][]
}

/**
 * # `BelongsToManyConfig<T>`
 *
 * Object form of a `belongsToMany` relation declaration. Either `through`
 * (Option B — pivot is a registered model) or `pivot.columns` (Option A —
 * inline metadata) supplies the pivot column metadata. When neither is
 * supplied the relation behaves exactly like the legacy string form.
 */
export interface BelongsToManyConfig<T extends string = string> {
  /** Related model name (the *target* of the relation). */
  model: T
  /** Pivot model name. Resolves the pivot table from that model's `table`. */
  through?: T
  /** Override the pivot table name. */
  table?: string
  /** Override the FK column on the pivot pointing at the parent model. */
  foreignKey?: string
  /** Override the FK column on the pivot pointing at the related model. */
  relatedKey?: string
  /** Inline pivot metadata (Option A). */
  pivot?: PivotConfig
}

export type BelongsToMany<T extends string> = Record<string, T | BelongsToManyConfig<T>>
export type HasOneThrough<T extends string> = Record<string, { through: T, target: T }>
export type HasManyThrough<T extends string> = Record<string, { through: T, target: T }>
export type MorphOne<T extends string> = Record<string, T>
export type MorphMany<T extends string> = Record<string, T>
export type MorphTo = Record<string, unknown>
export type MorphToMany<T extends string> = Record<string, T>
export type MorphedByMany<T extends string> = Record<string, T>

/**
 * # `ModelOptions`
 *
 * Declarative model definition used to build a typed `DatabaseSchema`.
 *
 * @example
 * ```ts
 * const User = defineModel({
 *   name: 'User',
 *   table: 'users',
 *   primaryKey: 'id',
 *   attributes: {
 *     id: { validation: { rule: {} // isInt() } },
 *     email: { validation: { rule: {} // isEmail() }, unique: true },
 *   },
 *   indexes: [{ name: 'users_email_unique', columns: ['email'] }],
 * })
 * ```
 */
export interface ModelOptions extends Base {
  name: string
  description?: string
  table?: string
  primaryKey?: string
  autoIncrement?: boolean
  indexes?: CompositeIndex[]
  traits?: Record<string, unknown>
  attributes?: AttributesElements
  hasOne?: HasOne<ModelNames> | ModelNames[]
  hasMany?: HasMany<ModelNames> | ModelNames[]
  belongsTo?: BelongsTo<ModelNames> | ModelNames[]
  belongsToMany?: BelongsToMany<ModelNames> | ModelNames[]
  hasOneThrough?: HasOneThrough<ModelNames>
  hasManyThrough?: HasManyThrough<ModelNames>
  morphOne?: MorphOne<ModelNames>
  morphMany?: MorphMany<ModelNames>
  morphTo?: MorphTo
  morphToMany?: MorphToMany<ModelNames>
  morphedByMany?: MorphedByMany<ModelNames>
  scopes?: {
    [key: string]: (value: any) => any
  }
  get?: {
    [key: string]: (value: any) => any
  }
  set?: {
    [key: string]: (value: any) => any
  }
}

export type ModelDefinition = Readonly<ModelOptions>

/**
 * # `ModelRecord`
 *
 * Collection of models keyed by model name. Kept flexible to preserve literal
 * attribute keys and value types.
 */
export type ModelRecord = Record<string, any>

/**
 * # `defineModel(model)`
 *
 * Freezes and returns a model definition with strong inference for attributes
 * and options.
 *
 * @example
 * ```ts
 * const Post = defineModel({
 *   name: 'Post',
 *   attributes: {
 *     title: { validation: { rule: {} // isLength({ min: 1 }) } },
 *   },
 * })
 * ```
 */
export function defineModel<const T extends ModelDefinition>(model: T): T {
  return model
}

/**
 * # `defineModels(models)`
 *
 * Freezes and returns a record of model definitions, preserving literal keys so
 * downstream types (like `DatabaseSchema`) can map model names to table names.
 *
 * @example
 * ```ts
 * const models = defineModels({ User, Post })
 * ```
 */
export function defineModels<const T extends ModelRecord>(models: T): T {
  return models
}

/**
 * # `InferAttributes<M>`
 *
 * Given a `ModelDefinition`, produces a record of attribute names to their
 * inferred input type based on the validator rule shape.
 */
type ExtractRuleInput<R> = R extends { validate: (value: infer T) => any }
  ? T
  : R extends { test: (value: infer T) => any }
    ? T
    : R extends { getRules: () => Array<{ test: (value: infer T) => any }> }
      ? T
      : unknown

export type InferAttributes<M extends ModelDefinition> = M extends {
  attributes: infer A extends Record<string, { validation: { rule: any } }>
}
  ? { [K in keyof A & string]: ExtractRuleInput<A[K]['validation']['rule']> }
  : Record<string, unknown>

/**
 * # `InferPrimaryKey<M>`
 *
 * Extracts a model's primary key field name, defaulting to `'id'`.
 */
export type InferPrimaryKey<M extends ModelDefinition> = M extends {
  primaryKey: infer K extends string
}
  ? K
  : 'id'

/**
 * # `InferTableName<M>`
 *
 * Resolves the table name from a model: uses `table` when provided, otherwise
 * falls back to a simple pluralized form of the model name.
 */
export type InferTableName<M extends ModelDefinition> = M extends {
  table: infer T extends string
}
  ? T
  : M extends { name: infer N extends string }
    ? `${Lowercase<N>}s`
    : string

// ============================================================================
// Type-level relation inference (mirrors the runtime normalization in meta.ts)
// ============================================================================

/**
 * Resolve a models-record entry to the raw definition. `defineModel()` (and
 * `createModel`/`createBrowserModel`) wrap definitions in an object exposing
 * `getDefinition()` / `definition`; `buildDatabaseSchema` unwraps these at
 * runtime, so the type level must unwrap them too or the schema degrades to
 * an untyped index signature.
 */
type UnwrapModelDefinition<M> =
  M extends { getDefinition: () => infer D } ? D :
    M extends { definition: infer D } ? D :
      M

/**
 * Unwrap a relation entry to the related model's name. Entries may be a plain
 * model-name string, a `{ model: 'X' }` config (belongsToMany Option A/B), or
 * a `{ through, target }` through-relation descriptor.
 */
type RelationEntryModelName<E> =
  E extends string ? E :
    E extends { model: infer M extends string } ? M :
      E extends { target: infer T extends string } ? T :
        never

/**
 * Normalize one relation declaration (array or record form) into a
 * `relationName -> relatedModelName` record, mirroring `buildSchemaMeta`:
 * array entries use the (unwrapped) model name as the relation name; record
 * entries use the key.
 */
type RelationRecordOf<V> =
  [V] extends [never]
    ? {} // absent relation kind — must yield {} (not never) so intersections survive
    : V extends readonly (infer E)[]
      ? { [K in RelationEntryModelName<E> & string]: K }
      : V extends Readonly<Record<string, unknown>>
        ? { [K in keyof V & string]: RelationEntryModelName<V[K]> }
        : {}

/** All relations of a model as a `relationName -> relatedModelName` record. */
type ModelRelationsRecord<M> =
  RelationRecordOf<M extends { hasOne: infer V } ? V : never>
  & RelationRecordOf<M extends { hasMany: infer V } ? V : never>
  & RelationRecordOf<M extends { belongsTo: infer V } ? V : never>
  & RelationRecordOf<M extends { belongsToMany: infer V } ? V : never>
  & RelationRecordOf<M extends { hasOneThrough: infer V } ? V : never>
  & RelationRecordOf<M extends { hasManyThrough: infer V } ? V : never>
  & RelationRecordOf<M extends { morphOne: infer V } ? V : never>
  & RelationRecordOf<M extends { morphMany: infer V } ? V : never>
  & RelationRecordOf<M extends { morphToMany: infer V } ? V : never>
  & RelationRecordOf<M extends { morphedByMany: infer V } ? V : never>

/** Resolve a related model name to its table name within the models record. */
type RelatedTableName<MRecord extends ModelRecord, ModelName> =
  ModelName extends keyof MRecord ? InferTableName<UnwrapModelDefinition<MRecord[ModelName]>> : string

/**
 * # `InferTableRelations<M, MRecord>`
 *
 * `relationName -> relatedTableName` record for one model, resolved against
 * the full models record. Powers the type-level narrowing of `.with()`,
 * `.whereHas()`, `.withCount()`, etc. on the query builder.
 */
export type InferTableRelations<M, MRecord extends ModelRecord> = {
  [K in keyof ModelRelationsRecord<UnwrapModelDefinition<M>> & string]: RelatedTableName<MRecord, ModelRelationsRecord<UnwrapModelDefinition<M>>[K]>
}

/**
 * # `DatabaseSchema<Models>`
 *
 * Maps model definitions to a concrete database schema shape containing the
 * table columns and primary key. This is the primary input for the query
 * builder's type-safety.
 *
 * The `relations` field is type-level only (phantom): `buildDatabaseSchema`
 * never materializes it at runtime. It maps relation names to related table
 * names so builder methods like `.with()` can narrow their accepted relation
 * names per table.
 *
 * @example
 * ```ts
 * const models = defineModels({ User, Post })
 * type Schema = DatabaseSchema<typeof models>
 * ```
 */
export type DatabaseSchema<MRecord extends ModelRecord> = {
  [MName in keyof MRecord & string as InferTableName<UnwrapModelDefinition<MRecord[MName]>>]: {
    columns: InferAttributes<UnwrapModelDefinition<MRecord[MName]>>
    primaryKey: InferPrimaryKey<UnwrapModelDefinition<MRecord[MName]>>
    /** Phantom, type-level only: relation name -> related table name. */
    relations?: InferTableRelations<MRecord[MName], MRecord>
  };
}
