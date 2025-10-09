# Install

Install via your package manager:

::: code-group

```sh [bun]
bun add bun-query-builder
```

:::

### Requirements

- Bun 1.2.20+
- A PostgreSQL database _(MySQL/SQLite planned per Bun roadmap)_

## Binaries

Choose the binary that matches your platform and architecture:

::: code-group

```sh [macOS (arm64)]
# Download the binary
curl -L https://github.com/stacksjs/bun-query-builder/releases/download/v0.9.1/query-builder-darwin-arm64 -o query-builder

# Make it executable
chmod +x query-builder

# Move it to your PATH
mv qbx /usr/local/bin/qbx
```

```sh [macOS (x64)]
# Download the binary
curl -L https://github.com/stacksjs/bun-query-builder/releases/download/v0.9.1/query-builder-darwin-x64 -o query-builder

# Make it executable
chmod +x query-builder

# Move it to your PATH
mv qbx /usr/local/bin/qbx
```

```sh [Linux (arm64)]
# Download the binary
curl -L https://github.com/stacksjs/bun-query-builder/releases/download/v0.9.1/query-builder-linux-arm64 -o query-builder

# Make it executable
chmod +x query-builder

# Move it to your PATH
mv qbx /usr/local/bin/qbx
```

```sh [Linux (x64)]
# Download the binary
curl -L https://github.com/stacksjs/bun-query-builder/releases/download/v0.9.1/query-builder-linux-x64 -o query-builder

# Make it executable
chmod +x query-builder

# Move it to your PATH
mv qbx /usr/local/bin/qbx
```

```sh [Windows (x64)]
# Download the binary
curl -L https://github.com/stacksjs/bun-query-builder/releases/download/v0.9.1/query-builder-windows-x64.exe -o query-builder.exe

# Move it to your PATH (adjust the path as needed)
move query-builder.exe C:\Windows\System32\query-builder.exe
```

::: tip
You can also find the `query-builder` binaries in GitHub [releases](https://github.com/stacksjs/bun-query-builder/releases).
:::

### Next steps

- Head over to Usage to define your models and build your first typed query.
