/**
 * Re-export validation schema from @stacksjs/ts-validation
 * and Model type from bun-query-builder for test fixtures
 */
export { schema } from '@stacksjs/ts-validation'
export type { ModelDefinition as Model } from '../../../src/orm'
