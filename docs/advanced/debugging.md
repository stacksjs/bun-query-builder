# Debugging

Enable textual rendering of queries for logs/tests.

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }

const q = db.selectFrom('users').where({ active: true })
console.log((q as any).toText?.())
```

## Best Practices

- Keep captureText disabled in production
- Prefer toText only for debugging/snapshots
