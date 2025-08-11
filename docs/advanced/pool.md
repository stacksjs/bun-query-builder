# Pool & Readiness

Utilities to work with Bun’s connection pool.

## Readiness

```ts
const ok = await db.ping()
await db.waitForReady({ attempts: 30, delayMs: 250 })
```

Use this in CI or app startup scripts.

## Reserve connections

```ts
const reserved = await db.reserve()
try {
  await reserved.selectFrom('users').limit(1).execute()
} finally {
  reserved.release()
}
```

## Best Practices

- Use waitForReady in environments where DB readiness is delayed
- Release reserved connections promptly
