/* eslint-disable ts/no-use-before-define */
// Mock SQL function for testing that doesn't require database connections
export function mockSql(strings: TemplateStringsArray | string[], ...values: any[]): any {
  // Build query string by interpolating values
  let query = ''
  for (let i = 0; i < strings.length; i++) {
    query += strings[i]
    if (i < values.length) {
      const val = values[i]
      // If value is another query object, get its string representation
      if (val && typeof val === 'object' && 'toString' in val) {
        query += val.toString()
      }
      // If value is a function that returns mockSql, call it
      else if (typeof val === 'function') {
        query += String(val)
      }
      else if (val !== undefined) {
        query += String(val)
      }
    }
  }

  // Clean up extra whitespace
  query = query.replace(/\s+/g, ' ').trim()

  // Create a function as the target so apply trap works
  const fn: any = function (...args: any[]) {
    // When called as a regular function
    if (args.length === 1) {
      const val = args[0]
      // If it's already a mockSql object, return it
      if (val && typeof val === 'object' && 'toString' in val && 'toSQL' in val) {
        return val
      }
      // Otherwise create a new mockSql with the value
      return mockSql([String(val)])
    }
    else if (args.length > 1) {
      // Multiple args - treat first as template strings
      return mockSql(args[0], ...args.slice(1))
    }
    // No args - return this mockSql
    return new Proxy(fn, handler)
  }

  // Add properties to the function
  fn.execute = () => Promise.resolve([])
  fn.toSQL = () => ({ sql: query, params: values })
  fn.toString = () => query
  fn.then = undefined

  // Support using as template literal
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop in target) {
        return target[prop]
      }
      return undefined
    },
  }

  return new Proxy(fn, handler)
}

// Mock query builder state for testing
export const mockQueryBuilderState = {
  sql: mockSql,
  meta: undefined,
  schema: undefined,
}
