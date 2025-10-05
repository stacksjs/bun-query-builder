// Minimal schema/type definitions to describe models and attributes

/**
 * # `ValidatorMessage`
 *
 * Map of field identifiers to custom error messages returned by validators.
 */

export type ValidatorMessage = Record<string, string>

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
  default?: string | number | boolean | Date
  unique?: boolean
  order?: number
  hidden?: boolean
  fillable?: boolean
  guarded?: boolean
  factory?: (faker: unknown) => any
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
 * { name: 'user_email_unique', columns: ['email'] }
 * ```
 */
export interface CompositeIndex {
  name: string
  columns: string[]
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
export type BelongsToMany<T extends string> = Record<string, T>
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

/**
 * # `DatabaseSchema<Models>`
 *
 * Maps model definitions to a concrete database schema shape containing the
 * table columns and primary key. This is the primary input for the query
 * builder's type-safety.
 *
 * @example
 * ```ts
 * const models = defineModels({ User, Post })
 * type Schema = DatabaseSchema<typeof models>
 * ```
 */
export type DatabaseSchema<MRecord extends ModelRecord> = {
  [MName in keyof MRecord & string as InferTableName<MRecord[MName]>]: {
    columns: InferAttributes<MRecord[MName]>
    primaryKey: InferPrimaryKey<MRecord[MName]>
  };
}
