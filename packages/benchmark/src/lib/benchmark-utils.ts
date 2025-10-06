import chalk from 'chalk'
import Table from 'cli-table3'

export interface BenchmarkResult {
  name: string
  library: string
  opsPerSecond: number
  avgTime: number
  samples: number
  p99: number
  p95: number
}

export interface BenchmarkSummary {
  category: string
  results: BenchmarkResult[]
}

export function formatResults(summaries: BenchmarkSummary[]) {
  for (const summary of summaries) {
    console.log(chalk.bold.cyan(`\n${'='.repeat(80)}`))
    console.log(chalk.bold.cyan(`  ${summary.category}`))
    console.log(chalk.bold.cyan(`${'='.repeat(80)}\n`))

    const table = new Table({
      head: [
        chalk.white.bold('Library'),
        chalk.white.bold('Ops/sec'),
        chalk.white.bold('Avg (ms)'),
        chalk.white.bold('p95 (ms)'),
        chalk.white.bold('p99 (ms)'),
        chalk.white.bold('Samples'),
      ],
      style: {
        head: [],
        border: [],
      },
    })

    // Sort by ops/sec descending
    const sorted = [...summary.results].sort((a, b) => b.opsPerSecond - a.opsPerSecond)
    const fastest = sorted[0]?.opsPerSecond || 1

    for (const result of sorted) {
      const percent = ((result.opsPerSecond / fastest) * 100).toFixed(1)
      const isFastest = result.opsPerSecond === fastest
      const color = isFastest ? chalk.green.bold : chalk.white

      table.push([
        color(result.library),
        color(`${result.opsPerSecond.toLocaleString()} ${isFastest ? '🏆' : ''}`),
        color(result.avgTime.toFixed(3)),
        color(result.p95.toFixed(3)),
        color(result.p99.toFixed(3)),
        color(result.samples.toString()),
      ])

      if (!isFastest) {
        console.log(chalk.gray(`  ${result.library}: ${percent}% of fastest`))
      }
    }

    console.log(table.toString())
  }
}

export function calculateStats(times: number[]) {
  if (times.length === 0) {
    return {
      avg: 0,
      p95: 0,
      p99: 0,
    }
  }

  const sorted = [...times].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const avg = sum / sorted.length

  const p95Index = Math.floor(sorted.length * 0.95)
  const p99Index = Math.floor(sorted.length * 0.99)

  return {
    avg,
    p95: sorted[p95Index] || sorted[sorted.length - 1] || 0,
    p99: sorted[p99Index] || sorted[sorted.length - 1] || 0,
  }
}
