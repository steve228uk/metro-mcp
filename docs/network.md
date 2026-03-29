# Network Overrides

Network overrides intercept HTTP requests made by your React Native app at the CDP Fetch domain level — no app code changes required. Works for `fetch`, `XMLHttpRequest`, and any library built on them.

## Overview

Three types of override are supported:

| Type | What it does |
|------|-------------|
| **response** | Return a fake response — the real server is never called |
| **request** | Modify the request and forward it to the real server |
| **block** | Fail the request with a network error |

Overrides persist in memory until removed or cleared. Interception can be paused and resumed without losing definitions. Overrides can be saved to a JSON file and committed to your codebase.

---

## Override types

### response — fake response

Return a controlled response for every matching request. The real server is never reached.

```
override_network_response
  urlPattern: "/api/users"
  statusCode: 200
  body: '{"users": [{"id": 1, "name": "Alice"}]}'
  headers: { "Content-Type": "application/json" }
```

### request — modify and forward

Modify the outgoing request, then let it continue to the real server. Original headers are **merged** (not replaced) with your overrides, so cookies and other headers are preserved.

```
override_network_request
  urlPattern: "/api/*"
  headers: { "Authorization": "Bearer test-token" }
  url: "https://staging.example.com/api/*"   # optional: redirect
  method: "POST"                              # optional: change method
  body: '{"override": true}'                 # optional: replace body
```

### block — fail the request

```
block_network_request
  urlPattern: "analytics.example.com"
```

---

## URL pattern matching

Patterns support `*` as a wildcard and substring matching:

| Pattern | Matches |
|---------|---------|
| `/api/users` | Any URL containing `/api/users` |
| `/api/*` | `/api/users`, `/api/products/123`, etc. |
| `*.example.com/auth*` | `prod.example.com/auth/login`, etc. |
| `analytics.example.com` | Any URL containing that host |

---

## Override file format

Save overrides to a JSON file and load them on startup or at runtime.

**`network-overrides.json`:**

```json
{
  "version": 1,
  "overrides": [
    {
      "name": "Mock users list",
      "urlPattern": "/api/users",
      "response": {
        "statusCode": 200,
        "headers": { "Content-Type": "application/json" },
        "body": { "users": [] }
      }
    },
    {
      "name": "Inject auth header",
      "urlPattern": "/api/*",
      "request": {
        "headers": { "Authorization": "Bearer test-token" }
      }
    },
    {
      "name": "Block analytics",
      "urlPattern": "analytics.example.com",
      "block": true
    }
  ]
}
```

**Rules:**

- `response.body` — string or inline JSON object/array. Objects are `JSON.stringify`'d automatically.
- `request.headers` — merged with the original request headers (not replaced).
- `block: true` — fails with a network error; `response` and `request` are ignored.
- Priority: `block` > `response` > `request`.
- `name` — optional, but required for single-item loading by name.

---

## File references

The `response` and `request` fields can be a **file path string** pointing to a separate `.json` file. Paths are resolved relative to the directory of the override file.

```json
{
  "version": 1,
  "overrides": [
    {
      "name": "Mock user detail",
      "urlPattern": "/api/users/*",
      "response": "./mocks/user-response.json"
    },
    {
      "name": "Inject auth header",
      "urlPattern": "/api/*",
      "request": "./mocks/auth-request.json"
    },
    {
      "name": "Override request and response",
      "urlPattern": "/api/upload",
      "request": "./mocks/upload-request.json",
      "response": "./mocks/upload-response.json"
    }
  ]
}
```

**`mocks/user-response.json`:**

```json
{
  "statusCode": 200,
  "headers": { "Content-Type": "application/json" },
  "body": { "id": 1, "name": "Alice" }
}
```

**`mocks/auth-request.json`:**

```json
{
  "headers": { "Authorization": "Bearer test-token" },
  "url": "https://staging.example.com/api/*"
}
```

---

## Folder structure

A folder of `.json` files is also supported. Each file can contain:

- A single override object `{ name, urlPattern, ... }`
- An array of override objects `[{ ... }, { ... }]`
- A full override file `{ version: 1, overrides: [...] }`

Example layout:

```
network-overrides/
  users.json          # single override or array
  auth.json
  analytics.json
```

Pass the folder path to `load_network_overrides` or set it as the `overridesFile` config.

---

## Configuration

### Environment variable

```bash
METRO_NETWORK_OVERRIDES=./network-overrides.json npx metro-mcp
```

### CLI argument

```bash
npx metro-mcp --network-overrides ./network-overrides.json
```

### Config file (`metro-mcp.config.ts`)

```typescript
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  network: {
    overridesFile: './network-overrides.json',
    // or a folder:
    // overridesFile: './network-overrides/',
  },
});
```

When configured, overrides are **auto-loaded on startup** before the first request is processed.

If no `overridesFile` is configured, `./network-overrides.json` is checked automatically — silently skipped if the file doesn't exist.

---

## Loading at runtime

**Load all overrides from a file or folder:**

```
load_network_overrides
  filepath: "./network-overrides.json"
```

**Load a single named override:**

```
load_network_overrides
  filepath: "./network-overrides.json"
  name: "Mock users list"
```

**Load from a folder:**

```
load_network_overrides
  filepath: "./network-overrides/"
```

**Load from the configured path (omit filepath):**

```
load_network_overrides
```

**Replace all in-memory overrides instead of merging:**

```
load_network_overrides
  filepath: "./network-overrides.json"
  replace: true
```

**Load without activating:**

```
load_network_overrides
  filepath: "./network-overrides.json"
  activate: false
```

---

## Saving overrides

Persist the current in-memory overrides to a file so they can be committed to your codebase:

```
save_network_overrides
  filepath: "./network-overrides.json"
```

The file uses the standard `{ version: 1, overrides: [...] }` format. Response bodies that are valid JSON are saved as inline objects (not strings).

---

## Pausing and resuming

Temporarily disable interception without removing override definitions:

```
pause_network_overrides    → all requests pass through to the real server
resume_network_overrides   → overrides become active again immediately
```

Useful for quickly comparing real vs overridden responses.

---

## Tool reference

### Request tracking

| Tool | Description |
|------|-------------|
| `get_network_requests` | Get recent HTTP requests with method, URL, status, timing. Params: `limit`, `summary`, `compact`. |
| `get_request_details` | Full headers for a specific request. Params: `url`, `index`. |
| `get_response_body` | Fetch the response body on demand. Bodies are not included in list output to avoid noise. Params: `url`, `index`. |
| `search_network` | Filter requests by URL pattern, method, status code, or errors only. |

### Network overrides

| Tool | Description |
|------|-------------|
| `override_network_response` | Return a fake response for every matching request. Params: `urlPattern`, `statusCode`, `body`, `headers`, `name`. |
| `override_network_request` | Modify the outgoing request and forward to real server. Params: `urlPattern`, `headers`, `url`, `method`, `body`, `name`. |
| `block_network_request` | Fail all matching requests with a network error. Params: `urlPattern`, `name`. |
| `remove_network_override` | Remove a single override by URL pattern. |
| `get_network_overrides` | List all active overrides and interception state. |
| `pause_network_overrides` | Disable interception without removing overrides. |
| `resume_network_overrides` | Re-enable interception after pausing. |
| `clear_network_overrides` | Remove all overrides and disable interception. |
| `save_network_overrides` | Save in-memory overrides to a JSON file. Params: `filepath` (default: `./network-overrides.json`). |
| `load_network_overrides` | Load overrides from a file or folder. Params: `filepath`, `name`, `replace`, `activate`. |
