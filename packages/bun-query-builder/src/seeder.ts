/**
 * Base seeder class that all seeders should extend.
 * Provides access to query builder and faker for generating test data.
 */
export abstract class Seeder {
  /**
   * The run method must be implemented by each seeder.
   * This is where you define the data to be seeded.
   */
  abstract run(qb: any): Promise<void>

  /**
   * Optional method to specify the order in which seeders should run.
   * Lower numbers run first. Default is 100.
   */
  get order(): number {
    return 100
  }
}

/**
 * Seeder configuration options
 */
export interface SeederConfig {
  /** Directory containing seeder files */
  seedersDir?: string
  /** Specific seeder classes to run */
  seeders?: string[]
  /** Whether to log seeding progress */
  verbose?: boolean
}

/**
 * Options for running seeders
 */
export interface RunSeederOptions {
  /** Run specific seeder by class name */
  class?: string
  /** Verbose output */
  verbose?: boolean
}

/**
 * Helper function to create a seeder
 */
export function defineSeeder(seederClass: new () => Seeder): new () => Seeder {
  return seederClass
}
