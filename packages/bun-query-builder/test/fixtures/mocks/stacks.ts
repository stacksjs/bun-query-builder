/**
 * Mock Stacks types for testing
 *
 * This provides minimal type definitions so model fixtures
 * can be imported without the full Stacks framework
 */

// Schema builder mock
export const schema = {
  string: () => ({
    required: () => schema.string(),
    min: (n: number) => schema.string(),
    max: (n: number) => schema.string(),
    email: () => schema.string(),
    url: () => schema.string(),
  }),
  number: () => ({
    required: () => schema.number(),
    min: (n: number) => schema.number(),
    max: (n: number) => schema.number(),
  }),
  boolean: () => ({
    required: () => schema.boolean(),
  }),
}

// Model type
export interface Model {
  name: string
  table: string
  primaryKey: string
  autoIncrement: boolean
  traits?: {
    useUuid?: boolean
    useTimestamps?: boolean
    useSearch?: {
      displayable?: string[]
      searchable?: string[]
      sortable?: string[]
      filterable?: string[]
    }
    useSeeder?: {
      count: number
    }
    useApi?: {
      uri: string
      routes: string[]
    }
  }
  belongsTo?: string[]
  hasMany?: string[]
  hasOne?: string[]
  attributes: Record<string, {
    order?: number
    fillable?: boolean
    unique?: boolean
    hidden?: boolean
    validation?: {
      rule: any
      message?: Record<string, string>
    }
    factory?: (faker: any) => any
  }>
  dashboard?: {
    highlight?: boolean
  }
}
