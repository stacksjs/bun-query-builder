export const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: {
        validation: { rule: { type: 'number' } },
      },
      name: {
        validation: { rule: { type: 'string' } },
      },
      email: {
        validation: { rule: { type: 'string', format: 'email' } },
      },
      age: {
        validation: { rule: { type: 'number', nullable: true } },
      },
      active: {
        validation: { rule: { type: 'boolean' } },
      },
      created_at: {
        validation: { rule: { type: 'string', format: 'date-time' } },
      },
      updated_at: {
        validation: { rule: { type: 'string', format: 'date-time' } },
      },
    },
    relations: {
      posts: {
        type: 'hasMany' as const,
        model: 'Post',
        foreignKey: 'user_id',
        localKey: 'id',
      },
    },
  },
  Post: {
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    attributes: {
      id: {
        validation: { rule: { type: 'number' } },
      },
      title: {
        validation: { rule: { type: 'string' } },
      },
      content: {
        validation: { rule: { type: 'string' } },
      },
      published: {
        validation: { rule: { type: 'boolean' } },
      },
      user_id: {
        validation: { rule: { type: 'number' } },
      },
      created_at: {
        validation: { rule: { type: 'string', format: 'date-time' } },
      },
      updated_at: {
        validation: { rule: { type: 'string', format: 'date-time' } },
      },
    },
    relations: {
      user: {
        type: 'belongsTo' as const,
        model: 'User',
        foreignKey: 'user_id',
        ownerKey: 'id',
      },
    },
  },
} as const
