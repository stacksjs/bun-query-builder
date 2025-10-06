import { bunSql } from '@/db'
import { createQueryBuilder } from '../index'

export interface BenchmarkOptions {
  operations?: string
  iterations?: number
}

interface BenchmarkResult {
  operation: string
  avgTime: number
  minTime: number
  maxTime: number
  iterations: number
}

/**
 * Run performance benchmarks
 */
export async function runBenchmark(options: BenchmarkOptions = {}): Promise<void> {
  const iterations = options.iterations || 1000
  const operations = options.operations?.split(',') || ['select', 'insert', 'update', 'delete', 'count']

  console.log('-- Running Query Builder Benchmarks')
  console.log(`-- Iterations: ${iterations}`)
  console.log(`-- Operations: ${operations.join(', ')}`)
  console.log()

  const qb = createQueryBuilder()

  // Setup test table
  console.log('-- Setting up test table...')
  try {
    await bunSql.unsafe('DROP TABLE IF EXISTS bench_users').execute()
    await bunSql.unsafe(`
      CREATE TABLE bench_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TEXT
      )
    `).execute()

    // Insert some test data
    for (let i = 0; i < 100; i++) {
      await bunSql.unsafe(`
        INSERT INTO bench_users (name, email, created_at)
        VALUES (?, ?, ?)
      `, [`User ${i}`, `user${i}@example.com`, new Date().toISOString()]).execute()
    }

    console.log('-- ✓ Test table ready with 100 rows')
    console.log()
  }
  catch (err) {
    console.error('-- Failed to setup test table:', err)
    throw err
  }

  const results: BenchmarkResult[] = []

  // Benchmark SELECT
  if (operations.includes('select')) {
    const times: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.selectFrom('bench_users').where({ active: 1 }).limit(10).execute()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'SELECT with WHERE + LIMIT',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Benchmark SELECT by ID
  if (operations.includes('select')) {
    const times: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.selectFrom('bench_users').where({ id: 1 }).first()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'SELECT by ID (first)',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Benchmark COUNT
  if (operations.includes('count')) {
    const times: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.selectFrom('bench_users').count()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'COUNT',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Benchmark INSERT
  if (operations.includes('insert')) {
    const times: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.insertInto('bench_users').values({
        name: `Bench User ${i}`,
        email: `bench${i}@example.com`,
        created_at: new Date().toISOString(),
      }).execute()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'INSERT',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Benchmark UPDATE
  if (operations.includes('update')) {
    const times: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.update('bench_users').set({ active: 0 }).where({ id: 1 }).execute()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'UPDATE by ID',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Benchmark DELETE
  if (operations.includes('delete')) {
    const times: number[] = []

    // Create records to delete
    const idsToDelete: number[] = []
    for (let i = 0; i < iterations; i++) {
      const result = await qb.insertInto('bench_users').values({
        name: 'To Delete',
        email: `delete${i}@example.com`,
        created_at: new Date().toISOString(),
      }).execute()
      idsToDelete.push(result.lastInsertRowid as number)
    }

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await qb.deleteFrom('bench_users').where({ id: idsToDelete[i] }).execute()
      times.push(performance.now() - start)
    }

    results.push({
      operation: 'DELETE by ID',
      avgTime: times.reduce((a, b) => a + b, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      iterations,
    })
  }

  // Display results
  console.log('-- Benchmark Results')
  console.log()

  const maxOpLength = Math.max(...results.map(r => r.operation.length))

  console.log(
    'Operation'.padEnd(maxOpLength + 2)
    + 'Avg (ms)'.padStart(12)
    + 'Min (ms)'.padStart(12)
    + 'Max (ms)'.padStart(12)
    + 'Ops/sec'.padStart(12),
  )
  console.log('-'.repeat(maxOpLength + 2 + 12 + 12 + 12 + 12))

  for (const result of results) {
    const op = result.operation.padEnd(maxOpLength + 2)
    const avg = result.avgTime.toFixed(3).padStart(12)
    const min = result.minTime.toFixed(3).padStart(12)
    const max = result.maxTime.toFixed(3).padStart(12)
    const opsPerSec = (1000 / result.avgTime).toFixed(0).padStart(12)

    console.log(`${op}${avg}${min}${max}${opsPerSec}`)
  }

  console.log()

  // Cleanup
  try {
    await bunSql.unsafe('DROP TABLE IF EXISTS bench_users').execute()
    console.log('-- ✓ Cleanup complete')
  }
  catch (err) {
    console.error('-- Warning: Failed to cleanup test table:', err)
  }
}
