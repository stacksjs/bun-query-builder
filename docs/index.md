---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "bun-query-builder"
  text: "Typed Query Builder for Bun.sql"
  tagline: "Model-driven, safe, and blazingly fast database queries"
  image: /images/logo-white.png
  actions:
    - theme: brand
      text: Get Started
      link: /intro
    - theme: alt
      text: View on GitHub
      link: https://github.com/stacksjs/bun-query-builder

features:
  - title: "🧩 Typed from Models"
    details: "Infer tables, columns, and primary keys from your data models for a Kysely-like developer experience with full TypeScript safety."
  - title: "🛡️ Injection-Safe Queries"
    details: "Built on Bun's tagged SQL templates for automatic parameterization and protection against SQL injection attacks."
  - title: "🔄 Advanced Transactions"
    details: "Robust transaction support with automatic retries, exponential backoff, configurable isolation levels, savepoints, and distributed transactions."
  - title: "🚀 High Performance"
    details: "Optimized for Bun's native performance with connection pooling, cursor pagination, and efficient batch processing."
  - title: "🔗 Rich Relations"
    details: "Intuitive relationship handling with eager loading, relation counting, and existence filtering for complex data modeling."
  - title: "🛠️ Developer Tools"
    details: "Comprehensive CLI for schema introspection, query debugging, database connectivity checks, and migration management."
  - title: "🎯 Multiple Dialects"
    details: "First-class support for PostgreSQL, MySQL, and SQLite with dialect-specific optimizations and feature detection."
  - title: "📊 Production Ready"
    details: "Built-in monitoring hooks, performance tracking, graceful error handling, and operational best practices for enterprise deployment."
---

<Home />
