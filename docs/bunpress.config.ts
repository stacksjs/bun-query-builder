import type { BunPressConfig } from 'bunpress'

export default {
  name: 'bun-query-builder',
  description: 'Fully-typed, model-driven Query Builder for Bun',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/reference' },
      { text: 'GitHub', link: 'https://github.com/stacksjs/bun-query-builder' }
    ],
    sidebar: {
      '/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Overview', link: '/' },
            { text: 'Getting Started', link: '/guide/getting-started' }
          ]
        },
        {
          text: 'Query Building',
          items: [
            { text: 'SELECT Queries', link: '/guide/select' },
            { text: 'INSERT Operations', link: '/guide/insert' },
            { text: 'UPDATE Operations', link: '/guide/update' },
            { text: 'WHERE Conditions', link: '/guide/where' },
            { text: 'JOIN Clauses', link: '/guide/joins' }
          ]
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Transactions', link: '/guide/transactions' },
            { text: 'Aggregations', link: '/aggregations' },
            { text: 'Raw Queries', link: '/raw-queries' }
          ]
        },
        {
          text: 'API Reference',
          items: [
            { text: 'API Reference', link: '/api/reference' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/stacksjs/bun-query-builder' },
      { icon: 'discord', link: 'https://discord.gg/stacksjs' }
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2024-present Stacks.js'
    }
  }
} satisfies BunPressConfig
