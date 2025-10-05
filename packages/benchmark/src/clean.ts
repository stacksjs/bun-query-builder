import { existsSync, unlinkSync } from 'node:fs'

const DB_PATH = './benchmark.db'

console.log('Cleaning up benchmark database...')

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
  console.log('Removed benchmark database')
}
else {
  console.log('No database to clean')
}
