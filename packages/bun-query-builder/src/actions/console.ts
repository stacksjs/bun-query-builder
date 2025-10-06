import { createInterface } from 'node:readline'
import process from 'node:process'
import { createQueryBuilder } from '../index'

/**
 * Start an interactive REPL for running queries
 */
export async function startConsole(): Promise<void> {
  console.log('-- Query Builder Interactive Console')
  console.log('-- Type .help for available commands')
  console.log('-- Type .exit or press Ctrl+C to quit')
  console.log()

  const qb = createQueryBuilder()

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'qb> ',
  })

  let multilineBuffer = ''
  let multilineMode = false

  const helpText = `
Available Commands:
  .help               Show this help message
  .exit               Exit the console
  .tables             List all tables
  .clear              Clear the screen

Query Examples:
  qb.selectFrom('users').where({ active: true }).limit(10).execute()
  qb.selectFrom('users').count()
  qb.insertInto('users').values({ name: 'John' }).execute()
  qb.selectFrom('users').where('id', '=', 1).first()
  qb.unsafe("SELECT * FROM users WHERE id = $1", [1]).execute()

Tips:
  - Use 'qb' to access the query builder
  - Use 'await' for async operations
  - Multi-line input: end with \\ to continue on next line
  - Press Enter on an empty line to execute multi-line input
`

  const executeQuery = async (code: string) => {
    try {
      // Create an async function that has access to qb
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('qb', `return (${code})`)
      const result = await fn(qb)

      if (result !== undefined) {
        if (Array.isArray(result)) {
          console.log(`-- ${result.length} row(s) returned`)
          console.table(result)
        }
        else if (typeof result === 'object' && result !== null) {
          console.log(result)
        }
        else {
          console.log(result)
        }
      }
    }
    catch (err: any) {
      console.error('Error:', err.message)
    }
  }

  const processCommand = async (line: string) => {
    const trimmed = line.trim()

    // Handle special commands
    if (trimmed.startsWith('.')) {
      const cmd = trimmed.toLowerCase()

      if (cmd === '.exit' || cmd === '.quit') {
        console.log('Goodbye!')
        rl.close()
        process.exit(0)
      }
      else if (cmd === '.help') {
        console.log(helpText)
      }
      else if (cmd === '.clear') {
        console.clear()
      }
      else if (cmd === '.tables') {
        try {
          const tables = await qb.unsafe(`
            SELECT name FROM sqlite_master
            WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `)

          if (tables.length > 0) {
            console.log('Tables:')
            for (const table of tables) {
              console.log(`  - ${table.name}`)
            }
          }
          else {
            console.log('No tables found')
          }
        }
        catch (err: any) {
          console.error('Error listing tables:', err.message)
        }
      }
      else {
        console.log(`Unknown command: ${trimmed}`)
        console.log('Type .help for available commands')
      }
      return
    }

    // Handle multi-line input
    if (trimmed.endsWith('\\')) {
      multilineMode = true
      multilineBuffer += trimmed.slice(0, -1) + '\n'
      return
    }

    // If in multiline mode and line is empty, execute buffer
    if (multilineMode) {
      if (trimmed === '') {
        await executeQuery(multilineBuffer)
        multilineBuffer = ''
        multilineMode = false
      }
      else {
        multilineBuffer += trimmed + '\n'
      }
      return
    }

    // Execute single line
    if (trimmed) {
      await executeQuery(trimmed)
    }
  }

  rl.on('line', async (line) => {
    await processCommand(line)
    rl.prompt()
  })

  rl.on('SIGINT', () => {
    if (multilineMode) {
      console.log('\n-- Multi-line input cancelled')
      multilineBuffer = ''
      multilineMode = false
      rl.prompt()
    }
    else {
      console.log('\n-- Type .exit to quit')
      rl.prompt()
    }
  })

  rl.on('close', () => {
    console.log('\nGoodbye!')
    process.exit(0)
  })

  rl.prompt()
}

/**
 * Tinker - alias for startConsole
 */
export async function tinker(): Promise<void> {
  return startConsole()
}
