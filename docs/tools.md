# Tools Reference

Jump to: [Console](#console) · [Network](#network) · [Errors](#errors) · [Evaluate](#evaluate) · [Device](#device) · [Redux](#redux) · [Components](#components) · [Storage](#storage) · [Bundle](#bundle) · [Simulator](#simulator) · [Filesystem](#filesystem) · [Deep Link](#deep-link) · [Permissions](#permissions) · [UI Interact](#ui-interact) · [Navigation](#navigation) · [Accessibility](#accessibility) · [Profiler](#profiler) · [Test Recorder](#test-recorder) · [Commands](#commands) · [Resources](#resources) · [Prompts](#prompts)

## Console

- **`get_console_logs`** — Get recent console output. Filter by `level` (log/warn/error/info/debug), `search` text, `limit`. Use `since` (Unix ms timestamp) to fetch only new entries. Supports `summary` mode. Output format: `HH:MM:SS.mmm [level] message`.
- **`clear_console_logs`** — Clear the log buffer.

## Network

### Request Tracking

- **`get_network_requests`** — Get buffered HTTP requests with method, URL, status, timing. Use `since` (Unix ms timestamp) to fetch only new entries. Supports `device` param for per-device filtering. Output format: `HH:MM:SS.mmm METHOD URL → STATUS (duration, size)`.
- **`get_request_details`** — Get full headers for a specific request by URL.
- **`get_response_body`** — Get response body for a network request (cached if small; requires active session if large).
- **`search_network`** — Filter by URL pattern, method, status code, or errors only. Use `limit` to cap results (default 20).
- **`get_network_stats`** — Aggregated network statistics: breakdown by domain, status code distribution, response time percentiles (p50/p95/p99), and slowest endpoints.
- **`clear_network_requests`** — Clear the network request buffer.

## Errors

- **`get_errors`** — Get uncaught exceptions with symbolicated stack traces. Use `since` (Unix ms timestamp) to fetch only new entries. Output format: `HH:MM:SS.mmm Message\nStack`.
- **`clear_errors`** — Clear the error buffer.

## Evaluate

- **`evaluate_js`** — Execute any JavaScript expression in the running app and return the result. Supports async/await.

## Device

- **`list_devices`** — List connected debuggable targets from Metro.
- **`get_app_info`** — Bundle URL, platform, device name, VM type.
- **`get_connection_status`** — CDP connection state and Metro status.
- **`reload_app`** — Reload the app. Tries Metro's HTTP reload endpoint first, then falls back to `DevSettings.reload()` via CDP.

## Source

- **`symbolicate`** — Convert minified stack traces to original source locations.

## Redux

> No app changes needed for basic state inspection.

- **`get_redux_state`** — Get the full state tree or a specific slice via dot-path (e.g., `user.profile`).
- **`dispatch_redux_action`** — Dispatch an action to the Redux store.
- **`get_redux_actions`** — Get recent dispatched actions (real-time with client SDK).

## Components

> No app changes needed.

- **`get_component_tree`** — Get the React component tree. Use `structureOnly=true` for compact output (~1-3KB).
- **`find_components`** — Search by component name pattern.
- **`inspect_component`** — Get detailed props, state, and hooks for a specific component.
- **`get_testable_elements`** — List all elements with `testID` or `accessibilityLabel`.

## Storage

> No app changes needed.

- **`get_storage_keys`** — List all AsyncStorage keys.
- **`get_storage_item`** — Read a specific key value.
- **`get_all_storage`** — Dump all key-value pairs.

## Bundle

- **`get_bundle_status`** — Metro server status and health check.
- **`get_bundle_errors`** — Compilation/transform errors with file paths.

## Simulator

- **`take_screenshot`** — Capture simulator/device screenshot.
- **`list_simulators`** — List iOS simulators and Android emulators.
- **`install_certificate`** — Add root certificate to device.
- **`get_native_logs`** — Native logs (iOS syslog / Android logcat).
- **`app_lifecycle`** — Launch, terminate, install, uninstall apps.
- **`get_screen_orientation`** — Get current orientation.

## Filesystem

Browse and read files inside the app's private sandbox. Useful for inspecting SQLite databases, MMKV stores, exported files, and cached data — without needing a rooted device or custom app code.

- **`get_app_directories`** — Return absolute paths for the app's known directories: `root`, `documents`, `library`, `cache`, `temp`. iOS requires `bundleId`; Android falls back to `evalInApp` via expo-file-system / react-native-fs if `bundleId` is omitted.
- **`list_directory`** — List files and subdirectories at a path. Returns compact text — one entry per line with type (`d`/`f`), size, modified date, and name; directories have a trailing `/`. Pass `recursive: true` for a full tree (raw text). Call `get_app_directories` first to get the root path.
- **`read_file`** — Read file contents with a configurable byte cap (default 50 KB, hard cap 1 MB). Returns the file content as a plain string, or `{ content, truncated: true }` when the cap was reached. Use `encoding: 'base64'` for binary files (SQLite, images, MMKV). Params: `path`, `bundleId` (Android), `encoding`, `maxBytes`.
- **`get_file_info`** — Get metadata for a single file or directory. Returns a compact single-line string: type (`d`/`f`), size, modified date, and name.
- **`delete_file`** *(destructive)* — Delete a file. Requires `confirm: true` to prevent accidental deletion.

> **Platform notes**
> - **iOS Simulator**: uses `xcrun simctl get_app_container` to resolve the sandbox root, then `ls`/`head` on the host.
> - **Android**: uses `adb shell run-as <packageName>` for app-private directories; public storage paths can be read without `bundleId`.

## Deep Link

- **`open_deeplink`** — Open a URL or deep link on the device.
- **`list_url_schemes`** — List registered URL schemes.

## Permissions

Inspect and manage app permissions on iOS Simulator and Android Emulator without leaving your workflow. Uses `xcrun simctl privacy` on iOS and `adb shell pm` on Android. Bundle ID / package name is auto-detected from config or the running app, or can be supplied explicitly.

**iOS services** (supported by `xcrun simctl privacy`): `calendar`, `contacts`, `contacts-limited`, `location`, `location-always`, `media-library`, `microphone`, `motion`, `photos`, `photos-add`, `reminders`, `siri`

**Android permissions:** Runtime (dangerous) permissions only — the app must have declared the permission in its `AndroidManifest.xml`. Provide just the suffix (e.g. `CAMERA`) or the full string (e.g. `android.permission.CAMERA`). Install-time permissions (e.g. `INTERNET`) cannot be granted this way.

- **`list_permissions`** — List all permission statuses for the app. Returns compact text: one `name=status` line per permission.
- **`grant_permission`** — Grant a permission to the app.
- **`revoke_permission`** — Revoke a permission from the app.
- **`reset_permissions`** — Reset one or all permissions to their default state. On iOS, omit `service` to reset everything. On Android, omit `service` to reset all runtime permissions (falls back to `pm clear` on older devices).
- **`open_app_settings`** — Open the app's system settings page. On iOS, opens the Settings panel for the frontmost app. On Android, requires a bundle ID / package name.

## UI Interact

All tools use the CDP fiber tree first, falling back to `simctl`/`adb`, then IDB as a last resort. IDB is optional — tools will prompt you to install it when needed.

- **`list_elements`** — Get interactive elements from the React component tree (labels, testIDs, roles). No IDB needed.
- **`tap_element`** — Tap by label/testID (CDP fiber tree) or coordinates (simctl/adb → IDB fallback).
- **`type_text`** — Type into a TextInput by testID/label or the first visible input (CDP → adb → IDB).
- **`long_press`** — Long press by label/testID (CDP) or coordinates (adb → IDB).
- **`swipe`** — Scroll/swipe in a direction (CDP ScrollView → adb → IDB).
- **`press_button`** — Press HOME (simctl), BACK/ENTER/DELETE (CDP + adb), VOLUME/POWER (adb → IDB).

## Navigation

> No app changes needed.

- **`get_navigation_state`** — Full React Navigation / Expo Router state.
- **`get_current_route`** — Currently focused route name and params.
- **`get_route_history`** — Navigation back stack.
- **`list_routes`** — All registered route names.

## Accessibility

> No app changes needed.

- **`audit_accessibility`** — Full screen audit for missing labels, roles, testIDs, alt text.
- **`check_element_accessibility`** — Deep check on a specific component.
- **`get_accessibility_summary`** — Counts overview of accessibility coverage.

## Commands

- **`list_commands`** — List custom commands registered by the app.
- **`run_command`** — Execute a custom command with parameters.

## Profiler

See the [profiling guide](profiling.md) for a full explanation of CDP CPU profiling vs React `<Profiler>`.

- **`start_profiling`** — Start Hermes CPU profiling via CDP. Param: `samplingInterval` in µs (default 1000). Captures all JS execution — React, Redux, navigation, your code.
- **`stop_profiling`** — Stop profiling and return top functions ranked by self time and total time. Params: `topN` (default 20), `includeNative` (default false).
- **`get_profile_status`** — Check whether profiling is active and whether a previous profile is available.
- **`get_flamegraph`** — Return the current profiling results as a human-readable text flamegraph: CPU call tree + ranked chart + React render chart.
- **`get_react_renders`** — Read render timings from `<Profiler onRender={trackRender}>` components. Returns renders sorted by `actualDuration` with `memoSavingsPercent`. Requires `trackRender` from `metro-bridge/client`. Param: `clear` (bool).

### Profiler Resources

| URI | Description |
|-----|-------------|
| `metro://profiler/flamegraph` | CPU call tree with time bars + ranked self-time chart + React render chart (text) |
| `metro://profiler/data` | Raw JSON: full CDP Profile object + React render records with memo savings |

## Test Recorder

Records real user interactions via React fiber patching — no app code changes required. See the [testing guide](testing.md) for full details.

- **`start_test_recording`** — Inject interaction interceptors into the running app. Captures taps, text entry, long presses, keyboard submits, and scroll/swipe gestures. Re-patches new fibers after each navigation so newly-loaded screens are always covered.
- **`stop_test_recording`** — Stop recording and retrieve the captured event log. Deduplicates rapid-fire text input events (keeps the final value per field).
- **`generate_test_from_recording`** — Convert the recording to a test file. Params: `format` (appium/maestro/detox), `testName`, `platform` (ios/android/both), `bundleId`, `includeSetup`.
- **`generate_wdio_config`** — Generate a minimal `wdio.conf.ts` for Appium + React Native, including the install command for all required packages.

## Chrome DevTools

- **`open_devtools`** — Open the React Native DevTools debugger panel in Chrome (or Edge). Uses Metro's bundled rn_fusebox frontend but routes the WebSocket through the MCP's CDP proxy so both DevTools and the MCP can coexist. Finds Chrome/Edge automatically via `chrome-launcher`. See [Chrome DevTools](#) in the README for why you should use this instead of pressing "j" or tapping "Open Debugger".

## Debug Globals

> No app changes needed.

- **`list_debug_globals`** — Auto-discover well-known global debugging objects in the app runtime: Redux stores, Apollo Client, Expo Router state, React DevTools hook, and more. Use `detailed=true` to include top-level keys for each discovered global.

## Inspect Point (Experimental)

> No app changes needed.

- **`inspect_at_point`** — Inspect the React component rendered at specific screen coordinates. Walks the React fiber tree to find the host component whose layout contains the given (x, y) point, then walks up to find the nearest named React component. Returns component name, host element type, layout bounds, and optionally props. Layout measurement varies between Old and New Architecture.

## Token-Efficient Output

Console, network, and error tools always output compact single-line text with short timestamps (`HH:MM:SS.mmm`) rather than JSON objects. All JSON responses are minified.

Additional modifiers to reduce context window usage:

| Modifier | Applies To | Effect |
|----------|------------|--------|
| `since: number` | Console, Network, Errors | Only return entries after this Unix timestamp (ms) — pass the last seen entry's timestamp to avoid re-fetching already-seen data |
| `summary: true` | Console, Network, Errors | One-line summary with counts instead of full output |
| `structureOnly: true` | Components | Component tree without props/state (~1-3KB) |
| `compact: true` | Components, Navigation, Redux | Single-line compressed format |
| `limit: number` | Most tools | Cap number of results |

## Resources

| URI | Description |
|-----|-------------|
| `metro://logs` | Live console log stream (plain text, compact format) |
| `metro://network` | Live network request stream (plain text, compact format) |
| `metro://errors` | Live error stream (plain text, compact format) |
| `metro://status` | Connection status |
| `metro://redux/state` | Redux state snapshot |
| `metro://navigation` | Navigation state |
| `metro://bundle/status` | Metro bundle status |
| `metro://profiler/flamegraph` | CPU flamegraph + React render chart (text) |
| `metro://profiler/data` | Raw JSON profiling data for agent analysis |

## Prompts

| Name | Description |
|------|-------------|
| `debug-app` | General debugging session |
| `debug-errors` | Error investigation workflow |
| `debug-performance` | Performance analysis |
| `diagnose-network` | Network issue diagnosis |
| `trace-action` | Trace user action through state + network |
| `record-test` | Record a user flow and generate an Appium, Maestro, or Detox test |
| `audit-accessibility` | Accessibility audit with fixes |
