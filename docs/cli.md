# CLI Reference

metro-mcp is invoked via `bunx` or `npx`. It has several subcommands for scaffolding and diagnostics, plus flags for configuring the MCP server.

## Subcommands

### `create-plugin`

Scaffold a new `metro-mcp-plugin-*` package interactively.

```bash
bunx metro-mcp create-plugin
```

Prompts for:
- **Plugin name suffix** — becomes the directory and package name (`metro-mcp-plugin-<name>`)
- **Description** — optional
- **Author** — defaults to `git config user.name`
- **Version** — defaults to `0.1.0`

Generates a complete plugin package with `src/index.ts` (hello-world plugin), `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, and `.gitignore`, then runs `bun install` automatically.

See [Custom Plugins](/plugins) for the full plugin authoring guide.

---

### `init`

Create a `metro-mcp.config.ts` in the current directory.

```bash
bunx metro-mcp init
```

Prompts for Metro host and port, then writes a config file with sensible defaults and commented-out examples for plugins and other options. Aborts if a config file already exists.

See [Configuration](/configuration) for all available config options.

---

### `doctor`

Check the health of your metro-mcp setup.

```bash
bunx metro-mcp doctor
```

Runs the following checks and reports pass/fail for each:

| Check | Details |
|---|---|
| Node.js version | Must be >=18 |
| Config file | Looks for `metro-mcp.config.ts` or `.js` in the current directory |
| Metro connectivity | HTTP request to the configured host:port |
| Plugin paths | Verifies local plugin file paths from your config exist on disk |

Exit code is `0` if all checks pass, `1` if any fail.

---

### `validate-plugin`

Validate that a plugin file exports a valid `PluginDefinition`.

```bash
bunx metro-mcp validate-plugin <path>
```

**Example:**

```bash
bunx metro-mcp validate-plugin ./src/index.ts
bunx metro-mcp validate-plugin ./node_modules/metro-mcp-plugin-mmkv/dist/index.js
```

Checks that the file:
1. Exists and can be imported
2. Exports an object (as default or named export) with a `name` string and a `setup` function

Prints the plugin's name, version, and description if valid. Exit code is `0` on success, `1` on failure.

---

## MCP server options

When run without a subcommand, metro-mcp starts the MCP server:

```bash
bunx metro-mcp [options]
```

| Flag | Description |
|---|---|
| `--host`, `-H <host>` | Metro bundler host (default: `localhost`) |
| `--port`, `-p <port>` | Metro bundler port (default: `8081`) |
| `--config`, `-c <path>` | Path to a config file (absolute or relative to CWD) |
| `--plugin <path>` | Load a plugin by path — repeatable |
| `--help` | Print usage |

**Examples:**

```bash
# Default — connects to Metro on localhost:8081
bunx metro-mcp

# Custom port (Expo default)
bunx metro-mcp --port 19000

# Explicit config file
bunx metro-mcp --config /path/to/metro-mcp.config.ts

# Load a plugin without a config file
bunx metro-mcp --plugin ./my-plugin.ts

# Multiple plugins
bunx metro-mcp --plugin ./plugin-a.ts --plugin ./plugin-b.ts
```

## Environment variables

See [Configuration](/configuration#environment-variables) for the full list of environment variables.

Key ones at a glance:

| Variable | Description |
|---|---|
| `METRO_HOST` | Metro bundler host |
| `METRO_PORT` | Metro bundler port |
| `METRO_MCP_CONFIG` | Path to config file |
| `METRO_MCP_PLUGINS` | Colon-separated plugin paths |
| `DEBUG` | Enable debug logging |
