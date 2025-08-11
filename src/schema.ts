// Minimal schema/type definitions to describe models and attributes

export type ValidatorMessage = Record<string, string>

export type ValidationType = unknown

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

export interface CompositeIndex {
  name: string
  columns: string[]
}

export interface Base {}

export type ModelNames = string

export type HasOne<T extends string> = Record<string, T>
export type HasMany<T extends string> = Record<string, T>
export type BelongsTo<T extends string> = Record<string, T>
export type BelongsToMany<T extends string> = Record<string, T>
export type HasOneThrough<T extends string> = Record<string, T>
export type MorphOne<T extends string> = Record<string, T>
export type MorphMany<T extends string> = Record<string, T>
export type MorphTo = Record<string, unknown>

export interface ModelOptions extends Base {
  name: string
  description?: string
  table?: string
  primaryKey?: string
  autoIncrement?: boolean
  indexes?: CompositeIndex[]
  dashboard?: {
    highlight?: boolean | number
  }

  traits?: Record<string, unknown>

  attributes?: AttributesElements

  hasOne?: HasOne<ModelNames> | ModelNames[]
  hasMany?: HasMany<ModelNames> | ModelNames[]
  belongsTo?: BelongsTo<ModelNames> | ModelNames[]
  belongsToMany?: BelongsToMany<ModelNames> | ModelNames[]
  hasOneThrough?: HasOneThrough<ModelNames> | ModelNames[]
  morphOne?: MorphOne<ModelNames> | ModelNames
  morphMany?: MorphMany<ModelNames>[] | ModelNames[]
  morphTo?: MorphTo

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

export type ModelRecord = Record<string, ModelDefinition>

export function defineModel<const T extends ModelDefinition>(model: T): T {
  return model
}

export function defineModels<const T extends ModelRecord>(models: T): T {
  return models
}

export type InferAttributes<M extends ModelDefinition> = M extends {
  attributes: infer A extends AttributesElements
}
  ? { [K in keyof A & string]: unknown }
  : Record<string, unknown>

export type InferPrimaryKey<M extends ModelDefinition> = M extends {
  primaryKey: infer K extends string
}
  ? K
  : 'id'

export type InferTableName<M extends ModelDefinition> = M extends {
  table: infer T extends string
}
  ? T
  : M extends { name: infer N extends string }
    ? `${Lowercase<N>}s`
    : string

export type DatabaseSchema<MRecord extends ModelRecord> = {
  [MName in keyof MRecord & string as InferTableName<MRecord[MName]>]: {
    columns: InferAttributes<MRecord[MName]>
    primaryKey: InferPrimaryKey<MRecord[MName]>
  };
}
