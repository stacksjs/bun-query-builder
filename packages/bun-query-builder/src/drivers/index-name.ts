export function qualifiedIndexName(tableName: string, indexName: string): string {
  const prefix = `${tableName}_`
  return indexName.startsWith(prefix) ? indexName : `${prefix}${indexName}`
}
