/**
 * The faker a factory is actually handed.
 *
 * Model factories in this ecosystem are written in the faker-js dialect - it is
 * what every example, every scaffolded model and a decade of muscle memory
 * produce:
 *
 * ```ts
 * factory: faker => faker.helpers.arrayElement(['draft', 'published']),
 * factory: faker => faker.string.alphanumeric(12),
 * factory: faker => faker.datatype.number({ min: 1, max: 10 }),
 * ```
 *
 * `@stacksjs/ts-faker` is a different, smaller surface: no `helpers.arrayElement`,
 * no `datatype`, `address` rather than `location`, `catchphrase` rather than
 * `catchPhrase`, and options objects where faker-js takes a bare number. Handing
 * a factory the raw instance means `arrayElement is not a function` at seed
 * time - and it is a *runtime* failure in the one code path nobody runs until
 * they are setting up a new environment.
 *
 * So this module adapts one to the other, and exports the adapted shape as a
 * type. Both halves matter: without the proxy the calls throw, and without the
 * type every one of those factories is a type error in a codebase that
 * typechecks.
 *
 * **Everything here is a translation, never an invention.** Where ts-faker has
 * no equivalent at all the method is built from what it does have (a slug from
 * `lorem.slug`, a registration from `vehicle.registration`), because a factory
 * that returns a plausible wrong-shaped string is better than a seeder that
 * stops.
 */

/** What faker-js calls a string generator's options, and what ts-faker wants. */
export interface CompatStringOptions {
  length?: number
  casing?: 'upper' | 'lower' | 'mixed'
}

/** What faker-js passes to a number generator. */
export interface CompatNumberOptions {
  min?: number
  max?: number
  /** faker-js rounds to this many places; ts-faker has no equivalent. */
  fractionDigits?: number
  multipleOf?: number
}

/**
 * The faker-js-shaped surface a factory receives.
 *
 * Deliberately loose on the modules this file does not translate: they are
 * forwarded to ts-faker untouched, and describing them here would be a second
 * copy of ts-faker's own types that goes stale on its next release. What is
 * spelled out is exactly what the compat layer adds or changes.
 */
export interface FactoryFaker {
  [module: string]: any

  /** faker-js's name for what ts-faker calls `address`. */
  location: Record<string, (...args: any[]) => any>

  /** Removed from faker-js years ago, still in half the factories ever written. */
  datatype: {
    boolean: (options?: number | { probability?: number }) => boolean
    number: (options?: number | CompatNumberOptions) => number
    float: (options?: CompatNumberOptions) => number
    uuid: () => string
    string: (length?: number) => string
    hexadecimal: (options?: number | CompatStringOptions) => string
    array: (length?: number) => unknown[]
    json: () => string
  }

  helpers: {
    arrayElement: <T>(items: readonly T[]) => T
    arrayElements: <T>(items: readonly T[], count?: number) => T[]
    shuffle: <T>(items: readonly T[]) => T[]
    maybe: <T>(produce: () => T, options?: { probability?: number }) => T | undefined
    slugify: (text: string) => string
    replaceSymbols: (pattern: string) => string
    [method: string]: any
  }
}

/** A method that takes options, called with a bare number the way faker-js allows. */
function asStringOptions(value: unknown): CompatStringOptions | undefined {
  if (typeof value === 'number')
    return { length: value }

  return value as CompatStringOptions | undefined
}

function asNumberOptions(value: unknown): CompatNumberOptions | undefined {
  // `faker.number.int(100)` means "up to 100" in faker-js. Reading it as a
  // minimum would produce ids that climb forever.
  if (typeof value === 'number')
    return { max: value }

  return value as CompatNumberOptions | undefined
}

function callable(value: unknown): value is (...args: any[]) => any {
  return typeof value === 'function'
}

/**
 * The lowercase name for a camelCase one.
 *
 * ts-faker spells multi-word methods in one lowercase run (`catchphrase`), and
 * faker-js camel-cases them (`catchPhrase`). Rather than list every pair, the
 * proxy tries the flattened form for any miss - which also covers whatever the
 * next release adds.
 */
function flattened(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase())
}

/** Round the way faker-js does when a factory asked for a fixed number of places. */
function withFractionDigits(value: number, options?: CompatNumberOptions): number {
  if (!options || typeof options.fractionDigits !== 'number')
    return value

  return Number(value.toFixed(options.fractionDigits))
}

/**
 * One module of the underlying faker, in faker-js's dialect.
 *
 * The proxy is per-module rather than one big table because the translation is
 * mostly mechanical: try the name, try the flattened name, and normalise a bare
 * number into the options object ts-faker expects.
 */
function compatModule(underlying: any, overrides: Record<string, (...args: any[]) => any> = {}): any {
  if (!underlying)
    return overrides

  return new Proxy(underlying, {
    get(target, property: string) {
      if (property in overrides)
        return overrides[property]

      const direct = target[property]
      if (direct !== undefined)
        return direct

      const fallback = target[flattened(property)]
      if (callable(fallback))
        return fallback.bind(target)

      return undefined
    },
  })
}

/**
 * Wrap a ts-faker instance in the surface factories are written against.
 *
 * Returned as `FactoryFaker` rather than as the underlying type, because the
 * point of the wrapper is that it is a different shape - a caller typed against
 * ts-faker would be told `helpers.arrayElement` does not exist, which is the
 * error this module exists to remove.
 */
export function createFakerCompatLayer(underlying: Record<string, any>): FactoryFaker {
  const pick = <T>(items: readonly T[]): T => {
    const list = Array.isArray(items) ? items : []
    const index = Math.floor(Math.random() * list.length)

    return list[index] as T
  }

  const strings = () => underlying.string as Record<string, (...args: any[]) => any> | undefined
  const numbers = () => underlying.number as Record<string, (...args: any[]) => any> | undefined
  const random = () => underlying.random as Record<string, (...args: any[]) => any> | undefined

  const compatString = compatModule(underlying.string, {
    // Every generator here takes options in ts-faker and a bare length in
    // faker-js. Passing the number through produces `[object Object]`-grade
    // nonsense: a string of the default length, silently.
    alpha: (options?: unknown) => strings()?.alpha?.(asStringOptions(options)),
    alphanumeric: (options?: unknown) => strings()?.alphanumeric?.(asStringOptions(options)),
    numeric: (options?: unknown) => strings()?.numeric?.(asStringOptions(options)),
    sample: (options?: unknown) => strings()?.sample?.(asStringOptions(options)),
    hexadecimal: (options?: unknown) => strings()?.hexadecimal?.(asStringOptions(options)),
  })

  const compatNumber = compatModule(underlying.number, {
    int: (options?: unknown) => numbers()?.int?.(asNumberOptions(options)),
    float: (options?: unknown) => {
      const parsed = asNumberOptions(options)

      return withFractionDigits(Number(numbers()?.float?.(parsed) ?? 0), parsed)
    },
  })

  const compatHelpers = compatModule(underlying.helpers, {
    // The single most-used faker-js helper, and ts-faker has no equivalent at
    // all. Without it every enum-valued factory in the ecosystem throws.
    arrayElement: pick,
    arrayElements: <T>(items: readonly T[], count?: number): T[] => {
      const list = [...(Array.isArray(items) ? items : [])]
      const wanted = typeof count === 'number' ? count : Math.max(1, Math.floor(Math.random() * list.length))

      for (let at = list.length - 1; at > 0; at -= 1) {
        const swap = Math.floor(Math.random() * (at + 1))
        ;[list[at], list[swap]] = [list[swap] as T, list[at] as T]
      }

      return list.slice(0, Math.min(wanted, list.length))
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const list = [...(Array.isArray(items) ? items : [])]

      for (let at = list.length - 1; at > 0; at -= 1) {
        const swap = Math.floor(Math.random() * (at + 1))
        ;[list[at], list[swap]] = [list[swap] as T, list[at] as T]
      }

      return list
    },
    maybe: <T>(produce: () => T, options?: { probability?: number }): T | undefined => {
      const probability = typeof options?.probability === 'number' ? options.probability : 0.5

      return Math.random() < probability ? produce() : undefined
    },
    slugify: (text: string): string =>
      String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
  })

  const compatDatatype = {
    boolean: (options?: number | { probability?: number }): boolean => {
      const probability = typeof options === 'number' ? options : options?.probability

      if (typeof probability === 'number')
        return Math.random() < probability

      return Boolean(random()?.boolean?.())
    },
    number: (options?: number | CompatNumberOptions): number => Number(numbers()?.int?.(asNumberOptions(options)) ?? 0),
    float: (options?: CompatNumberOptions): number => withFractionDigits(Number(numbers()?.float?.(options) ?? 0), options),
    uuid: (): string => crypto.randomUUID(),
    string: (length?: number): string => String(strings()?.alphanumeric?.({ length: length ?? 10 }) ?? ''),
    hexadecimal: (options?: number | CompatStringOptions): string => String(strings()?.hexadecimal?.(asStringOptions(options)) ?? ''),
    array: (length?: number): unknown[] => Array.from({ length: length ?? 3 }, () => strings()?.alphanumeric?.({ length: 8 })),
    json: (): string => JSON.stringify({ value: strings()?.alphanumeric?.({ length: 8 }) }),
  }

  const modules: Record<string, unknown> = {
    string: compatString,
    number: compatNumber,
    helpers: compatHelpers,
    datatype: compatDatatype,
    // faker-js renamed `address` to `location` and kept both working for years.
    // Factories in the wild use either.
    location: compatModule(underlying.address),
    address: compatModule(underlying.address),
    vehicle: compatModule(underlying.vehicle, {
      // faker-js's name for a registration plate.
      vrm: () => underlying.vehicle?.registration?.(),
    }),
    company: compatModule(underlying.company, {
      catchPhrase: () => underlying.company?.catchphrase?.(),
      buzzPhrase: () => underlying.company?.bs?.() ?? underlying.company?.buzzword?.(),
    }),
  }

  return new Proxy(underlying, {
    get(target, property: string) {
      if (property in modules)
        return modules[property]

      const direct = (target as any)[property]

      // A module ts-faker has and this file does not translate: still wrapped,
      // so a camelCase method name finds its flattened twin.
      if (direct && typeof direct === 'object')
        return compatModule(direct)

      return direct
    },
  }) as unknown as FactoryFaker
}
