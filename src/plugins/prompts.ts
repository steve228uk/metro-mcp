import { definePlugin } from '../plugin.js';

export const promptsPlugin = definePlugin({
  name: 'prompts',

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
6. Summarize the app's current state and any issues found`,
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
        { name: 'platform', description: 'Target platform for Appium: ios, android, or both (default: ios)', required: false },
        { name: 'bundleId', description: 'iOS bundle ID or Android app package (required for Appium)', required: false },
      ],
      handler: async (args) => {
        const format = args.format || 'appium';
        const platform = args.platform || 'ios';
        const bundleIdNote = args.bundleId
          ? `bundleId: "${args.bundleId}"`
          : 'bundleId: not provided — you will need to add it manually to the generated test or pass it as a parameter';
        return [
          {
            role: 'user',
            content: `Record and generate an automated test for: "${args.flow}"
Format: ${format}${format === 'appium' ? ` | Platform: ${platform} | ${bundleIdNote}` : ''}

Please follow these steps exactly:
1. Call start_test_recording to begin capturing interactions
2. Call get_testable_elements to inspect the current screen and identify available selectors
3. Navigate the app step by step using tap_element and type_text, following the described flow:
   - After each tap that triggers navigation, call wait_for_element or wait_for_navigation (not get_testable_elements immediately) to confirm the next screen has loaded
   - At major flow checkpoints (e.g. "reached cart screen", "payment form visible"), call add_recording_annotation with a descriptive note
4. When the flow is complete, call stop_test_recording
5. Call generate_test_from_recording with format="${format}"${args.bundleId ? `, bundleId="${args.bundleId}"` : ''}${format === 'appium' ? `, platform="${platform}"` : ''}
6. Call save_test_recording with a descriptive filename (e.g. "${args.flow.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40).toLowerCase()}")
7. Return the complete test code`,
          },
        ];
      },
    });

    ctx.registerPrompt('write-e2e-test', {
      description: 'Write a complete E2E test by recording a flow with full setup: handles format-specific config, uses wait tools for reliability, and saves the recording',
      arguments: [
        { name: 'flow', description: 'User flow to test (e.g. "login with valid credentials and reach the home screen")', required: true },
        { name: 'format', description: 'Test framework: appium, maestro, or detox', required: true },
        { name: 'platform', description: 'Target platform: ios, android, or both (required for Appium)', required: false },
        { name: 'bundleId', description: 'iOS bundle ID or Android package name (required for Appium)', required: false },
      ],
      handler: async (args) => {
        const format = args.format ?? 'appium';
        const platform = args.platform ?? 'ios';
        const isAppium = format === 'appium';
        return [
          {
            role: 'user',
            content: `Write a complete ${format} E2E test for this flow: "${args.flow}"
${isAppium ? `Platform: ${platform}${args.bundleId ? ` | bundleId: ${args.bundleId}` : ''}` : ''}

Step-by-step instructions:

1. **Setup check**: Call get_connection_status and list_devices to confirm the app is running
2. **Start recording**: Call start_test_recording
3. **Inspect starting screen**: Call get_testable_elements to see what's on screen
4. **Execute the flow**:
   - Use tap_element to tap buttons/links by testID or accessibilityLabel
   - Use type_text to enter text into inputs
   - After any action that triggers navigation, call wait_for_navigation or wait_for_element (not get_testable_elements immediately) to wait for the new screen
   - Call add_recording_annotation at each major checkpoint (e.g. "tapped login", "reached dashboard")
   - If an element isn't found, call get_testable_elements to refresh your understanding of the screen
5. **Stop recording**: Call stop_test_recording
6. **Generate test**: Call generate_test_from_recording with:
   - format="${format}"${isAppium ? `\n   - platform="${platform}"` : ''}${args.bundleId ? `\n   - bundleId="${args.bundleId}"` : ''}
   - includeSetup=true
7. **Save recording**: Call save_test_recording with filename="${args.flow.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40).toLowerCase()}-${format}"
${isAppium ? '8. **Generate config**: Call generate_wdio_config to produce the wdio.conf.ts\n9. **Return** both the test file and the wdio config' : '8. **Return** the complete test file with instructions to run it'}`,
          },
        ];
      },
    });

    ctx.registerPrompt('investigate-memory-leak', {
      description: 'Systematically investigate a memory leak: capture baseline, reproduce the leak, compare heap allocations',
      arguments: [
        { name: 'scenario', description: 'Description of the interaction that causes the leak (e.g. "navigate to UserList and back 5 times")', required: true },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `Investigate a memory leak triggered by: "${args.scenario}"

Please follow this systematic process:

1. **Baseline**: Call get_memory_info to record current heap usage
2. **Warm-up**: Navigate the scenario once to let caches fill (this is normal)
3. **Post-warmup memory**: Call get_memory_info again
4. **Start heap sampling**: Call start_heap_sampling (this records allocation call stacks)
5. **Reproduce the leak**: Perform the scenario described: "${args.scenario}"
   - Use tap_element, wait_for_navigation, and other automation tools to navigate the flow
   - Repeat the critical part 3-5 times to amplify the leak signal
6. **Capture allocations**: Call stop_heap_sampling to see which functions allocated the most memory
7. **Final memory**: Call get_memory_info to measure total heap growth
8. **Analysis**:
   - Compare baseline vs final heap usage — how much did it grow?
   - Which functions in the heap sampling report are allocating unexpectedly (look for non-GC-friendly objects)?
   - Check if any components from the scenario appear in the top allocations
   - Look for retained closures, large arrays, or repeated DOM/fiber allocations
9. **Inspect components**: Call get_component_tree to see if expected components were unmounted
10. **Summarise**: Identify the likely leak source with specific file and function references, and suggest fixes (e.g. missing useEffect cleanup, stale event listeners, uncancelled promises)`,
        },
      ],
    });

    ctx.registerPrompt('debug-crash', {
      description: 'Systematically investigate a crash or fatal error: collect errors, symbolicate stack traces, capture context',
      arguments: [
        { name: 'description', description: 'Optional: describe what you were doing when the crash occurred', required: false },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `Investigate ${args.description ? `this crash: "${args.description}"` : 'the recent crash'} in my React Native app.

Please follow these steps:

1. **Collect errors**: Call get_errors to retrieve all recent exceptions with stack traces
2. **Symbolicate**: For each error, call symbolicate with the stack trace to get readable file/line references
3. **Check logs**: Call get_console_logs — look for warnings or errors immediately before the crash timestamp
4. **Current state**:
   - Call get_current_route to see what screen the app is on
   - Call take_screenshot to capture the current visual state
5. **Component context**: Call find_components with the name of any component mentioned in the stack trace
6. **Network context**: Call search_network with errorsOnly=true to check for failed API calls around the crash time
7. **Redux/state context** (if applicable): Call get_redux_state to inspect current state
8. **Root cause analysis**:
   - Identify the exact file and line where the crash originated
   - Determine whether it's a null reference, async race condition, unhandled promise rejection, or render error
   - Check if a missing null-guard, missing Error Boundary, or improper async handling is responsible
9. **Recommended fix**: Provide the specific code change needed, with the file path and line number`,
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
