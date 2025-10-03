// Mock SQL function for testing that doesn't require database connections
export function mockSql(strings: TemplateStringsArray, ...values: any[]): any {
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
      else if (val !== undefined) {
        query += String(val)
      }
    }
  }

  // Clean up extra whitespace
  query = query.replace(/\s+/g, ' ').trim()

  const result: any = {
    execute: () => Promise.resolve([]),
    toSQL: () => ({ sql: query, params: values }),
    toString: () => query,
    // Make it chainable
    then: undefined,
  }

  // Support using as template literal
  return new Proxy(result, {
    get(target, prop) {
      if (prop in target) {
        return target[prop]
      }
      return undefined
    },
  })
}

// Mock query builder state for testing
export const mockQueryBuilderState = {
  sql: mockSql,
  meta: undefined,
  schema: undefined,
}
