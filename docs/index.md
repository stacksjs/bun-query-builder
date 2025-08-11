---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "bun-query-builder"
  text: "Typed Query Builder for Bun.sql"
  tagline: "Model-driven, safe, and fast"
  image: /images/logo-white.png
  actions:
    - theme: brand
      text: Get Started
      link: /intro
    - theme: alt
      text: View on GitHub
      link: https://github.com/stacksjs/bun-query-builder

features:
  - title: "Typed from Models"
    icon: "🧩"
    details: "Infer tables/columns/PKs from your models for a Kysely-like DX."
  - title: "Fluent & Safe"
    icon: "🛡"
    details: "Bun’s tagged templates under the hood for injection-safe queries."
  - title: "Powerful Transactions"
    icon: "🔄"
    details: "Retries, backoff, isolation levels, savepoints, distributed."
  - title: "CLI"
    icon: "🛠"
    details: "Introspect models, print queries, check readiness, run files."
---

<Home />
