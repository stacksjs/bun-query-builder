import type { ModelDefinition as Model } from '../../../src/orm'
import { schema } from '@stacksjs/ts-validation'

export default {
  name: 'UserStats',
  table: 'user_stats',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'user-stats',
      routes: ['index', 'show', 'update'],
    },
  },

  belongsTo: ['User'],

  attributes: {
    totalDistance: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.float({ min: 10, max: 2000, fractionDigits: 1 }),
    },

    totalTime: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const hours = faker.number.int({ min: 10, max: 500 })
        const mins = faker.number.int({ min: 0, max: 59 })
        return `${hours}h ${mins}m`
      },
    },

    totalElevation: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 5000, max: 500000 }),
    },

    trailsCompleted: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 5, max: 500 }),
    },

    currentStreak: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 60 }),
    },

    longestStreak: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 5, max: 100 }),
    },

    weeklyRank: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().min(1),
      },
      factory: (faker) => faker.number.int({ min: 1, max: 1000 }),
    },

    totalActivities: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 10, max: 1000 }),
    },

    totalKudosReceived: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 5000 }),
    },

    totalKudosGiven: {
      order: 10,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 3000 }),
    },
  },
} satisfies Model
