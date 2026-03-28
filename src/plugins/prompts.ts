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
      description: 'Analyze performance: network timing, render analysis',
      handler: async () => [
        {
          role: 'user',
          content: `I need to analyze my React Native app's performance. Please:
1. Get network requests with timing data (get_network_requests)
2. Check for slow requests (search_network — look for responses > 1s)
3. Check console logs for performance warnings (get_console_logs with search for "slow" or "performance")
4. Get the component tree to check for deep nesting (get_component_tree with structureOnly=true)
5. Check for re-render indicators in logs
6. Summarize performance findings and recommendations`,
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

    ctx.registerPrompt('generate-tests', {
      description: 'Generate Maestro tests from the current screen',
      arguments: [
        { name: 'scenario', description: 'Test scenario to generate (e.g., "login flow")', required: false },
      ],
      handler: async (args) => [
        {
          role: 'user',
          content: `I want to generate Maestro tests ${args.scenario ? `for the "${args.scenario}" scenario` : 'for the current screen'} in my React Native app. Please:
1. Get all testable elements on the current screen (get_testable_elements)
2. Get the component tree for structure (get_component_tree with structureOnly=true)
3. Get the current navigation state to understand the screen (get_current_route)
4. ${args.scenario ? `Generate a Maestro flow for: "${args.scenario}" (generate_maestro_flow)` : 'Identify the key user flows on this screen and generate Maestro flows for each'}
5. Review the generated YAML and suggest any missing testIDs that would improve the tests`,
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
