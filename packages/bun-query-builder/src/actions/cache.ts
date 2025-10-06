import { clearQueryCache as clear, setQueryCacheMaxSize } from '../client'

/**
 * Clear the query cache
 */
export async function cacheClear(): Promise<void> {
  console.log('-- Clearing query cache...')
  clear()
  console.log('-- ✓ Query cache cleared')
}

/**
 * Show cache statistics and configuration
 *
 * Note: The current cache implementation doesn't track detailed statistics.
 * This command shows the current configuration.
 */
export async function cacheStats(): Promise<void> {
  console.log('-- Query Cache Information')
  console.log()
  console.log('The query cache is an LRU (Least Recently Used) cache with TTL support.')
  console.log()
  console.log('Configuration:')
  console.log('  - Default max size: 100 entries')
  console.log('  - Default TTL: 60 seconds (60000ms)')
  console.log('  - Eviction: LRU when cache is full')
  console.log()
  console.log('Usage:')
  console.log('  qb.selectFrom("users").cache().get()         // Cache for 60s')
  console.log('  qb.selectFrom("users").cache(5000).get()     // Cache for 5s')
  console.log()
  console.log('Configuration:')
  console.log('  clearQueryCache()              // Clear all cached queries')
  console.log('  setQueryCacheMaxSize(500)      // Set max cache size')
  console.log()
  console.log('Commands:')
  console.log('  qb cache:clear                 // Clear the cache')
  console.log('  qb cache:config --size 500     // Configure cache size')
}

export interface CacheConfigOptions {
  size?: number
}

/**
 * Configure query cache settings
 */
export async function cacheConfig(options: CacheConfigOptions = {}): Promise<void> {
  console.log('-- Configuring query cache...')
  console.log()

  if (options.size !== undefined) {
    const size = Number(options.size)
    if (Number.isNaN(size) || size <= 0) {
      console.error('-- Error: Cache size must be a positive number')
      throw new Error('Invalid cache size')
    }

    setQueryCacheMaxSize(size)
    console.log(`-- ✓ Cache max size set to: ${size}`)
  }
  else {
    console.log('-- No configuration changes specified')
    console.log('-- Available options:')
    console.log('--   --size <n>   Set maximum cache size (default: 100)')
    console.log()
    console.log('-- Example: qb cache:config --size 500')
  }
}
