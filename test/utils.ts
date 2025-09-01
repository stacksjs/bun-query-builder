// Mock SQL function for testing that doesn't require database connections
export function mockSql(strings: TemplateStringsArray, ...values: any[]) {
  const query = strings.reduce((result, str, i) => {
    return result + str + (values[i] !== undefined ? String(values[i]) : '')
  }, '')

  return {
    execute: () => Promise.resolve([]),
    toSQL: () => ({ sql: query, params: values }),
    toString: () => query,
  }
}

// Mock query builder state for testing
export const mockQueryBuilderState = {
  sql: mockSql,
  meta: undefined,
  schema: undefined,
}
