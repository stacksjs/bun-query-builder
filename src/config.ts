import type { QueryBuilderConfig } from './types'
import { loadConfig } from 'bunfig'

export const defaultConfig: QueryBuilderConfig = {
  verbose: true,
}

// eslint-disable-next-line antfu/no-top-level-await
export const config: QueryBuilderConfig = await loadConfig({
  name: 'query-builder',
  defaultConfig,
})
