import { definePlugin } from '../plugin.js';

export const promptsPlugin = definePlugin({
  name: 'prompts',
  version: '0.1.0',
  description: 'Guided debugging and testing workflows',

  async setup(ctx) {
    ctx.registerPrompt('debug-app', {
      description: 'Start a general debugging session: connect, check logs, inspect state',
      handler: async () => [
        {
          role: 'user',
          content: `I need to debug my React Native app. Please:
1. Check the connection status to Metro (get_connection_status)
2. List connected devices (list_devices)
3. Get recent console logs, focusing on warnings and errors (get_console_logs with level filter)
4. Check for any uncaught exceptions (get_errors)
5. Get network request overview (get_network_requests with summary=true)
6. Check Metro bundle status (get_bundle_status)
7. Summarize the app's current state and any issues found`,
        },
      ],
    });

    ctx.registerPrompt('debug-errors', {
      description: 'Investigate errors: get stack traces, symbolicate, find root cause',
      arguments: [
        { name: 'error_message', description: 'Optional: specific error message to investigate', required: false },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `I need to investigate ${args.error_message ? `this error: "${args.error_message}"` : 'recent errors'} in my React Native app. Please:
1. Get all recent errors (get_errors)
2. For each error, symbolicate the stack trace (symbolicate)
3. Check console logs around the time of the error for context (get_console_logs)
4. Check if there are related network failures (search_network with errorsOnly=true)
5. If possible, inspect the component tree near the error source (find_components)
6. Provide a diagnosis and suggested fix`,
        },
      ],
    });

    ctx.registerPrompt('debug-performance', {
      description: 'Profile JS CPU usage and React render performance, then summarize findings with a flamegraph',
      handler: async () => [
        {
          role: 'user',
          content: `I need to analyze my React Native app's performance. Please:
1. Check the current profiler status (get_profile_status)
2. Clear any existing React render data (get_react_renders with clear=true)
3. Start CPU profiling (start_profiling with default samplingInterval)
4. Tell me to perform the interaction I want to profile, then wait for me to confirm it's done
5. After I confirm:
   a. Stop CPU profiling and get the analysis (stop_profiling)
   b. Read React render timings (get_react_renders)
   c. Read the flamegraph resource (metro://profiler/flamegraph) for a combined visual breakdown
   d. Check for slow network requests (search_network — look for responses > 1s)
   e. Check console logs for perf warnings (get_console_logs with search="slow" or "perf")
6. Summarize:
   - Top JS CPU hotspots by self time — which function and file is burning the most CPU
   - Slowest React component renders and whether memoization (memo/useMemo) is helping — compare actualDuration vs baseDuration
   - Components that re-render frequently (high count in the summary)
   - Any slow network requests contributing to perceived slowness
   - Concrete, prioritised recommendations`,
        },
      ],
    });

    ctx.registerPrompt('diagnose-network', {
      description: 'Diagnose network issues: inspect requests and failures',
      arguments: [
        { name: 'url_pattern', description: 'Optional: URL pattern to focus on', required: false },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `I need to diagnose network issues ${args.url_pattern ? `for requests matching "${args.url_pattern}"` : ''} in my React Native app. Please:
1. Get all network requests (get_network_requests)
2. Check for failed requests (search_network with errorsOnly=true)
3. ${args.url_pattern ? `Get details for requests matching "${args.url_pattern}" (get_request_details)` : 'Get details for the most recent failed request (get_request_details)'}
4. Check console logs for network-related errors (get_console_logs with search="fetch" or "network")
5. Summarize findings: which requests fail, what error codes, any patterns`,
        },
      ],
    });

    ctx.registerPrompt('trace-action', {
      description: 'Trace a user action through Redux state changes and network calls',
      arguments: [
        { name: 'action', description: 'The user action to trace (e.g., "login", "add to cart")', required: true },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `I want to trace the "${args.action}" action through my React Native app. Please:
1. Get the current Redux state before the action (get_redux_state)
2. Get the current navigation state (get_navigation_state)
3. Clear logs to start fresh (clear_console_logs)
4. Tell me to perform the "${args.action}" action in the app, then wait for me to confirm
5. After confirmation:
   a. Get new console logs (get_console_logs)
   b. Get new network requests (get_network_requests)
   c. Get Redux state after (get_redux_state)
   d. Check for any errors (get_errors)
   e. Get navigation state after (get_navigation_state)
6. Summarize: what changed, what network calls were made, what state changed`,
        },
      ],
    });

    ctx.registerPrompt('record-test', {
      description: 'Record and generate an automated test (Appium, Maestro, or Detox) by navigating a user flow in the app',
      arguments: [
        { name: 'flow', description: 'Flow to record (e.g. "guest user: tap Start Shopping on FirstVisitScreen, end on ShopTab")', required: true },
        { name: 'format', description: 'Output format: appium, maestro, or detox (default: appium)', required: false },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `Record and generate an automated test for: "${args.flow}"
Format: ${args.format || 'appium'}

Please:
1. Call start_test_recording to begin capturing interactions
2. Call get_testable_elements to inspect the current screen and identify available selectors
3. Navigate the app step by step using tap_element, type_text, and swipe tools to follow the described flow
4. When the flow is complete (or the end condition is reached), call stop_test_recording
5. Call generate_test_from_recording with format="${args.format || 'appium'}" to produce the final test
6. Return the complete test code with a brief comment on each step`,
        },
      ],
    });

    ctx.registerPrompt('audit-accessibility', {
      description: 'Run an accessibility audit and provide fixes',
      handler: async () => [
        {
          role: 'user',
          content: `I want to audit the accessibility of my React Native app's current screen. Please:
1. Run a full accessibility audit (audit_accessibility)
2. Get an accessibility summary (get_accessibility_summary)
3. Get the component tree to understand the structure (get_component_tree with structureOnly=true)
4. For each error-level issue:
   a. Explain why it matters for accessibility
   b. Provide the exact code fix needed
5. For warning-level issues, prioritize and suggest fixes
6. Check if testIDs are present for automated testing (info-level issues)
7. Summarize overall accessibility score and next steps`,
        },
      ],
    });
  },
});
