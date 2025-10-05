import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import chalk from 'chalk'

const DB_PATH = './benchmark.db'

console.log(chalk.bold.cyan('\n🚀 Bun Query Builder Benchmarks\n'))

// Check if database exists
if (!existsSync(DB_PATH)) {
  console.log(chalk.yellow('Database not found. Running setup...\n'))
  const setupResult = spawnSync('bun', ['run', 'src/setup.ts'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  if (setupResult.status !== 0) {
    console.error(chalk.red('Setup failed!'))
    process.exit(1)
  }

  console.log()
}

// Run all benchmarks
const benchmarks = [
  { name: 'Basic Queries', script: 'src/benchmarks/basic.ts' },
  { name: 'Advanced Queries', script: 'src/benchmarks/advanced.ts' },
  { name: 'Batch Operations', script: 'src/benchmarks/batch.ts' },
]

for (const benchmark of benchmarks) {
  console.log(chalk.bold.blue(`\n${'='.repeat(80)}`))
  console.log(chalk.bold.blue(`  Running: ${benchmark.name}`))
  console.log(chalk.bold.blue(`${'='.repeat(80)}\n`))

  const result = spawnSync('bun', ['run', benchmark.script], {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  if (result.status !== 0) {
    console.error(chalk.red(`\n❌ ${benchmark.name} failed!`))
    process.exit(1)
  }
}

console.log(chalk.bold.green('\n✅ All benchmarks completed successfully!\n'))
