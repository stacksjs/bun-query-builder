import type { Model } from '../mocks/stacks'
import { schema } from '../mocks/stacks'

export default {
  name: 'TerritoryStats',
  table: 'territory_stats',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'territory-stats',
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['User'],

  attributes: {
    totalTerritoriesOwned: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 20 }),
    },

    totalAreaOwned: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.float({ min: 0, max: 5000000 }),
    },

    territoriesClaimed: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 50 }),
    },

    territoriesConquered: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 30 }),
    },

    territoriesLost: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 20 }),
    },

    territoriesDefended: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 15 }),
    },

    longestOwnershipDays: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 180 }),
    },

    largestTerritoryArea: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.float({ min: 0, max: 500000 }),
    },

    weeklyRank: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.number().min(1),
      },
      factory: (faker) => faker.number.int({ min: 1, max: 500 }),
    },

    allTimeRank: {
      order: 10,
      fillable: true,
      validation: {
        rule: schema.number().min(1),
      },
      factory: (faker) => faker.number.int({ min: 1, max: 500 }),
    },
  },
} satisfies Model
