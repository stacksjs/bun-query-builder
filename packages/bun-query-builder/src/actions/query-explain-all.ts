import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { bunSql } from '@/db'

export interface ExplainAllOptions {
  verbose?: boolean
  json?: boolean
  format?: 'text' | 'json'
}

export interface ExplainResult {
  file: string
  query: string
  plan: any[]
  error?: string
}

/**
 * Run EXPLAIN on all SQL files in a directory
 */
export async function queryExplainAll(path: string, options: ExplainAllOptions = {}): Promise<ExplainResult[]> {
  const results: ExplainResult[] = []

  try {
    // Check if path is a file or directory
    const stat = statSync(path)

    let files: string[] = []
    if (stat.isDirectory()) {
      // Get all .sql files in directory
      const allFiles = readdirSync(path)
      files = allFiles
        .filter(f => extname(f) === '.sql')
        .map(f => join(path, f))
    }
    else if (stat.isFile() && extname(path) === '.sql') {
      files = [path]
    }
    else {
      console.error('Path must be a .sql file or directory containing .sql files')
      return results
    }

    if (files.length === 0) {
      console.log('No .sql files found')
      return results
    }

    if (options.verbose) {
      console.log(`Analyzing ${files.length} SQL file(s)...\n`)
    }

    for (const file of files) {
      try {
        const query = readFileSync(file, 'utf8').trim()

        if (!query) {
          if (options.verbose) {
            console.log(`⊘ ${file}: empty file`)
          }
          continue
        }

        if (options.verbose) {
          console.log(`📄 ${file}`)
          console.log(`   Query: ${query.substring(0, 60)}${query.length > 60 ? '...' : ''}`)
        }

        // Run EXPLAIN
        const plan = await bunSql`EXPLAIN ${bunSql.unsafe(query)}`

        results.push({
          file,
          query,
          plan: Array.isArray(plan) ? plan : [plan],
        })

        if (options.verbose && !options.json) {
          console.log(`   Plan:`)
          if (Array.isArray(plan)) {
            for (const row of plan) {
              // Different dialects have different formats
              if (typeof row === 'string') {
                console.log(`     ${row}`)
              }
              else if (row['QUERY PLAN']) {
                console.log(`     ${row['QUERY PLAN']}`)
              }
              else if (row.plan) {
                console.log(`     ${JSON.stringify(row.plan)}`)
              }
              else {
                console.log(`     ${JSON.stringify(row)}`)
              }
            }
          }
          console.log()
        }
      }
      catch (error: any) {
        results.push({
          file,
          query: readFileSync(file, 'utf8').trim(),
          plan: [],
          error: error.message,
        })

        if (options.verbose) {
          console.log(`   ✗ Error: ${error.message}\n`)
        }
      }
    }

    // Summary
    const successful = results.filter(r => !r.error).length
    const failed = results.filter(r => r.error).length

    if (options.verbose) {
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`Summary: ${successful} successful, ${failed} failed`)
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2))
    }

    return results
  }
  catch (error: any) {
    console.error('Error explaining queries:', error.message)
    throw error
  }
}

export { queryExplainAll as explainAllQueries }
