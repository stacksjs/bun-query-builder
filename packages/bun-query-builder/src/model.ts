/**
 * Isomorphic Model Definition
 *
 * Provides a single `defineModel` function that works in both server and browser contexts.
 * No code generation needed - the same model definition works everywhere.
 *
 * - Server: Provides database query capabilities via the dynamic ORM (createModel)
 * - Browser: Provides API query capabilities via fetch
 *
 * Includes a model registry so models can be looked up by name at runtime,
 * eliminating the need for auto-import generation in Stacks.
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
 *
 * // Look up models at runtime without imports:
 * import { getModel, getAllModels } from 'bun-query-builder'
 *
 * const TrailModel = getModel('Trail')
 * const allModels = getAllModels()
 * ```
 */

import { createBrowserModel, type BrowserModelDefinition } from './browser'
import { clearLocalModels, createModel, type ModelStatic, type ModelDefinition as OrmModelDefinition } from './orm'

// Re-export the browser model types for convenience
export type { BrowserModelDefinition as ModelDefinition }

// ============================================================================
// Model Registry
// ============================================================================

/**
 * Global model registry — maps model names to their runtime instances.
 * Populated automatically by defineModel() so models can be looked up
 * by name at runtime without needing generated auto-import files.
 */
const modelRegistry = new Map<string, ReturnType<typeof createBrowserModel>>()

/**
 * Look up a registered model by name.
 *
 * @param name - The model name (e.g., 'User', 'Trail')
 * @returns The model instance, or undefined if not registered
 *
 * @example
 * ```ts
 * const User = getModel('User')
 * if (User) {
 *   const users = await User.all()
 * }
 * ```
 */
export function getModel(name: string): ReturnType<typeof createBrowserModel> | undefined {
  return modelRegistry.get(name)
}

/**
 * Get all registered models as an array.
 *
 * @returns Array of all registered model instances
 *
 * @example
 * ```ts
 * const models = getAllModels()
 * for (const model of models) {
 *   console.log(model.getTable())
 * }
 * ```
 */
export function getAllModels(): ReturnType<typeof createBrowserModel>[] {
  return [...modelRegistry.values()]
}

/**
 * Get all registered models as a name-to-model map.
 *
 * @returns Record mapping model names to model instances
 *
 * @example
 * ```ts
 * const models = getModelRegistry()
 * // { User: UserModel, Trail: TrailModel, ... }
 * ```
 */
export function getModelRegistry(): Record<string, ReturnType<typeof createBrowserModel>> {
  return Object.fromEntries(modelRegistry)
}

/**
 * Check if a model with the given name is registered.
 *
 * @param name - The model name to check
 * @returns true if the model is registered
 */
export function hasModel(name: string): boolean {
  return modelRegistry.has(name)
}

/**
 * Clear all registered models. Primarily useful for testing.
 *
 * Also drops the models `createModel` registered internally, and the memoized
 * relation resolutions derived from them. Leaving either behind lets a stale
 * resolution from one test file decide a relation's table in the next.
 */
export function clearModelRegistry(): void {
  modelRegistry.clear()
  clearLocalModels()
}

/**
 * Register an already-created model instance in the global registry.
 *
 * Framework integrations can build richer model facades themselves and
 * still expose those models to query-builder features that discover
 * models through the shared registry.
 *
 * @param name - The model name (e.g., 'User', 'Trail')
 * @param model - The runtime model instance to register
 * @returns The same model instance for convenient passthrough usage
 */
export function registerModel<TModel>(name: string, model: TModel): TModel {
  modelRegistry.set(name, model as ReturnType<typeof createBrowserModel>)

  return model
}

// ============================================================================
// defineModel
// ============================================================================

/**
 * The definition as the ORM types read it. A literal definition normally
 * satisfies the ORM's `ModelDefinition` already, which keeps its column and
 * relation names narrow; intersecting unconditionally would widen them.
 */
type ServerModelDefinition<TDef> = TDef extends OrmModelDefinition ? TDef : TDef & OrmModelDefinition

/**
 * What `defineModel()` returns: the ORM model, plus the raw definition for
 * build tools that introspect it.
 *
 * It used to be typed as the browser model even though the package root runs
 * on Bun and hands back the ORM model. So `whereRaw`, `with`, `whereGroup`,
 * `increment` and the aggregates worked but did not type-check. Browser code
 * builds its models with `createBrowserModel` from `bun-query-builder/browser`.
 */
export type DefinedModel<TDef extends BrowserModelDefinition> = ModelStatic<ServerModelDefinition<TDef>> & {
  definition: TDef
  getName: () => TDef['name']
}

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
 * The model is automatically registered in the global model registry,
 * making it available via `getModel(name)` and `getAllModels()`.
 *
 * @param definition - The model definition
 * @returns An isomorphic model with query methods
 */
export function defineModel<const TDef extends BrowserModelDefinition>(definition: TDef): DefinedModel<TDef> {
  let model: DefinedModel<TDef>

  // In browser, use the browser model implementation (fetch-based)
  if (isClientSide()) {
    // A DOM in a Bun process (happy-dom in tests, say) takes this branch. The
    // fetch-backed model it gets lacks the server-only builder methods.
    model = createBrowserModel(definition) as unknown as DefinedModel<TDef>
  }
  else {
    // On server, use the dynamic ORM directly — no code generation needed.
    // createModel() provides all typed query methods (where, find, create, etc.)
    // backed by bun:sqlite at runtime.
    const serverModel = createModel(definition as unknown as TDef & OrmModelDefinition)

    // Merge the raw definition onto the model so build tools (migration generators,
    // route generators, dashboard generators) can still introspect it.
    model = Object.assign(serverModel as unknown as Record<string, unknown>, {
      definition,
      getDefinition: () => definition,
      getTable: () => definition.table,
      getName: () => definition.name,
    }) as unknown as DefinedModel<TDef>
  }

  // Register the model in the global registry
  registerModel(definition.name, model as unknown as ReturnType<typeof createBrowserModel>)

  return model
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
