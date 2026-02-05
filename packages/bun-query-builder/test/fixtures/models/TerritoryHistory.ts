import type { ModelDefinition as Model } from '../../../src/orm'
import { schema } from '@stacksjs/ts-validation'

export default {
  name: 'TerritoryHistory',
  table: 'territory_histories',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 100,
    },
    useApi: {
      uri: 'territory-histories',
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Territory', 'User', 'Activity'],

  attributes: {
    previousOwnerId: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: (faker) => faker.datatype.boolean() ? faker.number.int({ min: 1, max: 100 }) : null,
    },

    eventType: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Event type is required',
        },
      },
      factory: (faker) => faker.helpers.arrayElement(['claimed', 'conquered', 'defended', 'split']),
    },

    areaAtEvent: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.float({ min: 1000, max: 500000 }),
    },

    previousOwnershipDuration: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 3600, max: 2592000 }),
    },

    notes: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().max(500),
      },
      factory: (faker) => faker.lorem.sentence(),
    },
  },
} satisfies Model
