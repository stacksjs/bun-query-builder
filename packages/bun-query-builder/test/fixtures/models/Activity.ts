import type { Model } from '../mocks/stacks'
import { schema } from '../mocks/stacks'

export default {
  name: 'Activity',
  table: 'activities',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'userId', 'trailId', 'activityType', 'distance', 'duration'],
      searchable: ['activityType'],
      sortable: ['createdAt', 'distance', 'duration'],
      filterable: ['activityType', 'userId', 'trailId'],
    },
    useSeeder: {
      count: 50,
    },
    useApi: {
      uri: 'activities',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['User', 'Trail'],
  hasMany: ['Kudos', 'Territory'],

  attributes: {
    activityType: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Activity type is required',
        },
      },
      factory: (faker) => faker.helpers.arrayElement(['Trail Run', 'Hike', 'Walk', 'Bike']),
    },

    distance: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().required().min(0),
        message: {
          required: 'Distance is required',
        },
      },
      factory: (faker) => faker.number.float({ min: 1, max: 20, fractionDigits: 1 }),
    },

    duration: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Duration is required',
        },
      },
      factory: (faker) => {
        const hours = faker.number.int({ min: 0, max: 4 })
        const mins = faker.number.int({ min: 0, max: 59 })
        const secs = faker.number.int({ min: 0, max: 59 })
        return hours > 0 ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}` : `${mins}:${secs.toString().padStart(2, '0')}`
      },
    },

    pace: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const mins = faker.number.int({ min: 6, max: 20 })
        const secs = faker.number.int({ min: 0, max: 59 })
        return `${mins}:${secs.toString().padStart(2, '0')}`
      },
    },

    elevation: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 100, max: 3000 }),
    },

    kudosCount: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 100 }),
    },

    notes: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.lorem.sentence(),
    },

    gpxData: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    completedAt: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.date.recent({ days: 30 }).toISOString(),
    },
  },

  dashboard: {
    highlight: true,
  },
} satisfies Model
