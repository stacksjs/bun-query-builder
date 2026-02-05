import type { ModelDefinition as Model } from '../../../src/orm'
import { schema } from '@stacksjs/ts-validation'

export default {
  name: 'Trail',
  table: 'trails',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'location', 'difficulty', 'rating', 'distance'],
      searchable: ['name', 'location', 'tags'],
      sortable: ['createdAt', 'rating', 'distance', 'elevation'],
      filterable: ['difficulty', 'rating'],
    },
    useSeeder: {
      count: 20,
    },
    useApi: {
      uri: 'trails',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  hasMany: ['Activity', 'Review'],

  attributes: {
    name: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().required().min(3).max(200),
        message: {
          required: 'Trail name is required',
          min: 'Trail name must have at least 3 characters',
        },
      },
      factory: (faker) => faker.location.street() + ' Trail',
    },

    location: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().required().max(300),
        message: {
          required: 'Location is required',
        },
      },
      factory: (faker) => `${faker.location.city()}, ${faker.location.state({ abbreviated: true })}`,
    },

    distance: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().required().min(0),
        message: {
          required: 'Distance is required',
          min: 'Distance must be positive',
        },
      },
      factory: (faker) => faker.number.float({ min: 0.5, max: 25, fractionDigits: 1 }),
    },

    elevation: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number().required().min(0),
        message: {
          required: 'Elevation is required',
        },
      },
      factory: (faker) => faker.number.int({ min: 100, max: 5000 }),
    },

    difficulty: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Difficulty is required',
        },
      },
      factory: (faker) => faker.helpers.arrayElement(['easy', 'moderate', 'hard']),
    },

    rating: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(5),
      },
      factory: (faker) => faker.number.float({ min: 3.5, max: 5, fractionDigits: 1 }),
    },

    reviewCount: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 50, max: 10000 }),
    },

    estimatedTime: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const hours = faker.number.int({ min: 0, max: 6 })
        const mins = faker.helpers.arrayElement(['15', '30', '45', '00'])
        return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
      },
    },

    image: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => 'https://images.unsplash.com/photo-1551632811-561732d1e306?w=800&h=600&fit=crop',
    },

    tags: {
      order: 10,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.helpers.arrayElements(['forest', 'waterfall', 'wildlife', 'coastal', 'views', 'dog-friendly', 'summit', 'running', 'family', 'accessible'], 3).join(','),
    },

    latitude: {
      order: 11,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: (faker) => faker.location.latitude(),
    },

    longitude: {
      order: 12,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: (faker) => faker.location.longitude(),
    },

    description: {
      order: 13,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.lorem.paragraphs(2),
    },
  },

  dashboard: {
    highlight: true,
  },
} satisfies Model
