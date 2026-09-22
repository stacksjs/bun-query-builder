# Runtime import diagnostic

This diagnostic compares the complete package root with the narrow SQL runtime
after the normal production build:

```bash
bun run build
bun run bench:runtime-import -- --pairs=30
```

Each variant runs in a fresh Bun process with environment-file loading disabled
and a small allowlist of inherited host variables. Every process verifies the
same request-time SQL symbols. Order alternates by pair. The JSON result retains
every import-time and RSS sample plus medians, paired deltas, ratios, and sign
counts. It records the source state and SHA-256 fingerprints for each statically
reachable built JavaScript file. RSS is read after a forced garbage collection
and a short settling period.

Results from developer machines and hosted runners are diagnostic evidence,
not publishable rankings. Record a host-load policy and dedicated hardware
separately before using these numbers as a public benchmark.
