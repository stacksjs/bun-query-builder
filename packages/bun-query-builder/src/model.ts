/**
 * Isomorphic Model Definition
 *
 * Provides a single `defineModel` function that works in both server and browser contexts.
 * No code generation needed - the same model definition works everywhere.
 *
 * - Server: Provides database query capabilities via the dynamic ORM (createModel)
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
import { createModel, type ModelDefinition as OrmModelDefinition } from './orm'

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
 * On the server, this uses the dynamic ORM (createModel) to provide fully
 * typed query methods that work directly with the database — no code
 * generation needed.
 *
 * @param definition - The model definition
 * @returns An isomorphic model with query methods
 */
export function defineModel<const TDef extends BrowserModelDefinition>(definition: TDef) {
  // In browser, use the browser model implementation (fetch-based)
  if (isClientSide()) {
    return createBrowserModel(definition)
  }

  // On server, use the dynamic ORM directly — no code generation needed.
  // createModel() provides all typed query methods (where, find, create, etc.)
  // backed by bun:sqlite at runtime.
  const serverModel = createModel(definition as unknown as TDef & OrmModelDefinition)

  // Merge the raw definition onto the model so build tools (migration generators,
  // route generators, dashboard generators) can still introspect it.
  return Object.assign(serverModel as unknown as Record<string, unknown>, {
    definition,
    getDefinition: () => definition,
    getTable: () => definition.table,
    getName: () => definition.name,
  }) as unknown as ReturnType<typeof createBrowserModel<TDef>>
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
