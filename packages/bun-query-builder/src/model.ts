/**
 * Isomorphic Model Definition
 *
 * Provides a single `defineModel` function that works in both server and browser contexts.
 * No code generation needed - the same model definition works everywhere.
 *
 * - Server: Provides database query capabilities via ORM
 * - Browser: Provides API query capabilities via fetch
 *
 * @example
 * ```ts
 * // app/Models/Trail.ts
 * import { defineModel } from 'bun-query-builder'
 *
 * export default defineModel({
 *   name: 'Trail',
 *   table: 'trails',
 *   traits: {
 *     useApi: { uri: 'trails' },
 *     useTimestamps: true,
 *   },
 *   attributes: {
 *     name: { fillable: true },
 *     distance: { fillable: true },
 *   },
 * })
 *
 * // Works in both server and browser:
 * const trails = await Trail.all()
 * const trail = await Trail.find(1)
 * ```
 */

import { createBrowserModel, isBrowser, type BrowserModelDefinition } from './browser'

// Re-export the browser model types for convenience
export type { BrowserModelDefinition as ModelDefinition }

/**
 * Check if we're running in a browser environment
 */
function isClientSide(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/**
 * Define an isomorphic model that works in both server and browser.
 *
 * In the browser, this creates a model that uses fetch() to call your API.
 * On the server, this returns the definition for ORM generation AND provides
 * query methods that work directly with the database.
 *
 * @param definition - The model definition
 * @returns An isomorphic model with query methods
 */
export function defineModel<const TDef extends BrowserModelDefinition>(definition: TDef) {
  // In browser, use the browser model implementation (fetch-based)
  if (isClientSide()) {
    return createBrowserModel(definition)
  }

  // On server, return a model that:
  // 1. Exposes the definition for build-time ORM generation
  // 2. Provides query methods that will use the generated ORM
  //
  // Note: The actual ORM implementation is injected at runtime by the
  // Stacks framework. This is a placeholder that gets replaced.
  const serverModel = {
    // Expose definition for build tools
    definition,
    getDefinition: () => definition,
    getTable: () => definition.table,
    getName: () => definition.name,

    // Query methods - these will be overridden by the actual ORM
    // For now, throw helpful errors if called before ORM is initialized
    all: async () => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    find: async (_id: number | string) => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    first: async () => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    where: (_column: string, _operatorOrValue: any, _value?: any) => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    create: async (_data: any) => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    update: async (_id: number | string, _data: any) => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
    delete: async (_id: number | string) => {
      throw new Error(`[defineModel] Server ORM not initialized for ${definition.name}. Make sure to run model generation.`)
    },
  }

  return serverModel as unknown as ReturnType<typeof createBrowserModel<TDef>>
}

/**
 * Register models on the global window.StacksBrowser object.
 * Call this in your app's entry point to make models available for STX auto-imports.
 *
 * @param models - Object mapping model names to model instances
 *
 * @example
 * ```ts
 * import Trail from './Models/Trail'
 * import Activity from './Models/Activity'
 *
 * registerBrowserModels({ Trail, Activity })
 * ```
 */
export function registerBrowserModels(models: Record<string, unknown>): void {
  if (typeof window === 'undefined') return

  ;(window as any).StacksBrowser = {
    ...(window as any).StacksBrowser,
    ...models,
  }
}
