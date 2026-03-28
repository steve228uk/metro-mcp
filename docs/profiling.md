# Profiling

metro-mcp provides two complementary profiling approaches that work together:

| | CDP CPU Profiler | React `<Profiler>` |
|---|---|---|
| **What it measures** | Every JS function on the thread | React render phases only |
| **Granularity** | Individual functions and call stacks | Component subtree totals |
| **Shows** | Redux, navigation, your utils, React internals — everything | `actualDuration` vs `baseDuration` per component tree |
| **Tells you** | *Which function* is slow and exactly *where* in the call stack | *Which component tree* is slow to render and whether `memo`/`useMemo` is helping |
| **App changes** | None required | Requires `<Profiler onRender={trackRender}>` |

Use the `debug-performance` prompt to run both together automatically.

---

## CDP CPU Profiler

Hermes exposes a sampling CPU profiler via the Chrome DevTools Protocol. metro-mcp enables this with three tools.

### Tools

**`start_profiling`**

Starts sampling the JS call stack. Takes an optional `samplingInterval` in microseconds (default: `1000` = 1ms).

```
Lower interval → more precise, higher overhead
100–500 µs   high precision
1000 µs      balanced (default)
10000+ µs    low overhead
```

**`stop_profiling`**

Stops profiling and returns an analysis of the captured call-graph:

```json
{
  "durationMs": 2340,
  "sampleCount": 2340,
  "samplingRateMs": 1.0,
  "topFunctions": [
    {
      "functionName": "processData",
      "location": "src/utils/data.ts:142",
      "selfTime": "290ms (12.4%)",
      "totalTime": "443ms (18.9%)"
    }
  ]
}
```

- **selfTime** — time spent in this function specifically (not counting callees). The primary metric for finding hotspots.
- **totalTime** — time in this function including everything it calls.

Params: `topN` (default 20), `includeNative` (default false — excludes Hermes internals).

**`get_profile_status`**

Returns whether profiling is active and whether a previous profile is available.

### Workflow

```
start_profiling
  → perform the interaction you want to measure
stop_profiling
  → read metro://profiler/flamegraph for a visual breakdown
```

---

## React `<Profiler>`

React's built-in [`<Profiler>`](https://react.dev/reference/react/Profiler) component measures how long component subtrees take to render. metro-mcp collects this data via a single `trackRender` callback from the client SDK.

### Setup

Install metro-mcp as a dev dependency in your app:

```bash
npm install --save-dev metro-mcp
# or
bun add -d metro-mcp
```

Import `trackRender` and pass it to any `<Profiler>` component:

```tsx
import { Profiler } from 'react';
import { trackRender } from 'metro-mcp/client';

// Wrap a specific subtree you want to measure
<Profiler id="sidebar" onRender={trackRender}>
  <Sidebar />
</Profiler>

// Or wrap multiple areas independently
<Profiler id="feed" onRender={trackRender}>
  <FeedList />
</Profiler>
```

The `id` string identifies the profiler in the results. Use it to name the component or screen you're measuring.

> `<Profiler>` fires on every render commit, so data accumulates continuously. Use `get_react_renders` with `clear=true` to reset the buffer before the interaction you want to isolate.

### Tool

**`get_react_renders`**

Returns all collected renders sorted by `actualDuration` descending:

```json
[
  {
    "id": "sidebar",
    "phase": "update",
    "actualDuration": 42.3,
    "baseDuration": 89.1,
    "memoSavingsPercent": 52.5,
    "startTime": 1234567.89,
    "commitTime": 1234610.19
  }
]
```

- **actualDuration** — milliseconds React spent rendering this commit. Lower is better.
- **baseDuration** — estimated cost to re-render the full subtree with no memoization. Represents worst-case.
- **memoSavingsPercent** — `(baseDuration - actualDuration) / baseDuration × 100`. High value means `memo`/`useMemo` is working well. Low value means there's room to add memoization.

Use `clear=true` to reset the buffer after reading.

---

## Resources

Both profiling approaches feed into shared resources.

**`metro://profiler/flamegraph`** — Human-readable text output combining both sources:

```
=== CPU Flamegraph (by total time) ===
Duration: 2340ms | Samples: 2340

▼ renderApp                     45.2% ████████████████████████  1058ms total
  ▼ FlatList._render            23.1% ████████████               541ms total
    ■ processData               12.4% ██████                     290ms self

=== Ranked by Self Time ===
 #  Function                        Self%    Self ms  Total%   Total ms  Location
 1  processData                     12.4%    290ms    18.9%     443ms    src/utils/data.ts:142

=== React Renders — Ranked by Actual Duration ===
 #  Component                  Phase          Actual     Base  Savings  Chart
 1  sidebar                    update         42.3ms   89.1ms       52%  ████████████
```

**`metro://profiler/data`** — Raw JSON with the full CDP Profile object (nodes, samples, timeDeltas) and pre-computed stats, plus all React render records. Useful for agent analysis or exporting to other tools.

---

## Tips

- **Start with the CPU profiler** if you don't know where the slowness is — it will show you which code is actually executing.
- **Use `<Profiler>`** once you've identified a slow screen and want to measure the impact of adding `memo` or `useMemo`.
- **Compare actualDuration vs baseDuration** — a large gap means memoization is already working. A small gap means the component can't skip rendering and you need to investigate with the CPU profiler.
- **Re-render count** in `get_react_renders` summary is often more telling than duration — a component rendering 50 times is a bigger problem than one rendering once slowly.
- Keep `<Profiler>` wrappers in `__DEV__` blocks. They add overhead and are disabled in production builds by default, but it's good practice to guard them explicitly.
