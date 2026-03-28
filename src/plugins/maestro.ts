import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const maestroPlugin = definePlugin({
  name: 'maestro',
  version: '0.1.0',
  description: 'Maestro test flow generation from component tree data',

  async setup(ctx) {
    async function evalInApp(expression: string): Promise<unknown> {
      if (!ctx.cdp.isConnected()) throw new Error('Not connected');
      const result = (await ctx.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        timeout: 5000,
      })) as Record<string, unknown>;
      if (result.exceptionDetails) throw new Error('Evaluation failed');
      return (result.result as Record<string, unknown>).value;
    }

    async function getTestableElements(): Promise<Array<{
      name: string;
      testID?: string;
      accessibilityLabel?: string;
      text?: string;
    }>> {
      const expr = `
        (function() {
          var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook || !hook.getFiberRoots) return [];
          var fiberRoots;
          for (var i = 1; i <= 5; i++) {
            fiberRoots = hook.getFiberRoots(i);
            if (fiberRoots && fiberRoots.size > 0) break;
          }
          if (!fiberRoots) return [];
          var rootFiber = Array.from(fiberRoots)[0].current;
          var elements = [];

          function walk(fiber) {
            if (!fiber) return;
            var name = fiber.type?.displayName || fiber.type?.name;
            if (name) {
              var props = fiber.memoizedProps || {};
              var el = { name: name };
              if (props.testID) el.testID = props.testID;
              if (props.accessibilityLabel) el.accessibilityLabel = props.accessibilityLabel;
              if (typeof props.children === 'string') el.text = props.children;
              if (props.onPress) el.interactive = true;
              if (el.testID || el.accessibilityLabel || el.text || el.interactive) {
                elements.push(el);
              }
            }
            walk(fiber.child);
            walk(fiber.sibling);
          }
          walk(rootFiber);
          return elements;
        })()
      `;
      return ((await evalInApp(expr)) as Array<{
        name: string;
        testID?: string;
        accessibilityLabel?: string;
        text?: string;
      }>) || [];
    }

    ctx.registerTool('generate_maestro_flow', {
      description:
        'Generate a Maestro test flow (YAML) from a description of user actions. Uses the current screen\'s component tree to find correct selectors.',
      parameters: z.object({
        description: z.string().describe(
          'Description of the test flow (e.g., "Tap the login button, enter email, tap submit")'
        ),
        appId: z.string().optional().describe('App bundle ID (e.g., com.example.app)'),
        includeAssertions: z.boolean().default(true).describe('Include assertVisible assertions'),
      }),
      handler: async ({ description, appId, includeAssertions }) => {
        const elements = await getTestableElements();

        // Build a selector map for the AI to reference
        const selectorMap = elements.map((el) => {
          const selector = el.testID
            ? `id: "${el.testID}"`
            : el.accessibilityLabel
            ? `id: "${el.accessibilityLabel}"`
            : el.text
            ? `text: "${el.text}"`
            : null;
          return selector ? `${el.name}: ${selector}` : null;
        }).filter(Boolean);

        // Generate YAML flow
        const lines: string[] = [];
        if (appId) lines.push(`appId: ${appId}`);
        lines.push('---');
        lines.push(`# Generated from: ${description}`);
        lines.push(`# Available selectors on current screen:`);
        for (const sel of selectorMap.slice(0, 20)) {
          lines.push(`#   ${sel}`);
        }
        lines.push('');

        // Parse the description into steps
        const steps = description.split(/[,;.]/).map((s) => s.trim()).filter(Boolean);

        for (const step of steps) {
          const lowerStep = step.toLowerCase();

          // Match against available elements
          const matchingEl = elements.find((el) => {
            const elName = (el.testID || el.accessibilityLabel || el.text || el.name).toLowerCase();
            return lowerStep.includes(elName);
          });

          const selector = matchingEl
            ? matchingEl.testID
              ? `id: "${matchingEl.testID}"`
              : matchingEl.accessibilityLabel
              ? `id: "${matchingEl.accessibilityLabel}"`
              : matchingEl.text
              ? `text: "${matchingEl.text}"`
              : null
            : null;

          if (lowerStep.includes('tap') || lowerStep.includes('click') || lowerStep.includes('press')) {
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            } else {
              lines.push(`# TODO: Find selector for: ${step}`);
              lines.push(`- tapOn:`);
              lines.push(`    text: "TODO"`);
            }
          } else if (lowerStep.includes('type') || lowerStep.includes('enter') || lowerStep.includes('input')) {
            const textMatch = step.match(/["']([^"']+)["']/);
            const text = textMatch ? textMatch[1] : 'TODO';
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            }
            lines.push(`- inputText: "${text}"`);
          } else if (lowerStep.includes('swipe')) {
            const dir = lowerStep.includes('up') ? 'UP' : lowerStep.includes('down') ? 'DOWN' : lowerStep.includes('left') ? 'LEFT' : 'RIGHT';
            lines.push(`- swipe${dir.charAt(0) + dir.slice(1).toLowerCase()}`);
          } else if (lowerStep.includes('wait')) {
            const timeMatch = step.match(/(\d+)/);
            lines.push(`- wait: ${timeMatch ? parseInt(timeMatch[1]) * 1000 : 2000}`);
          } else if (lowerStep.includes('assert') || lowerStep.includes('verify') || lowerStep.includes('check')) {
            if (selector) {
              lines.push(`- assertVisible:`);
              lines.push(`    ${selector}`);
            } else {
              lines.push(`# TODO: Assert: ${step}`);
            }
          } else {
            lines.push(`# ${step}`);
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            }
          }
          lines.push('');
        }

        if (includeAssertions && elements.length > 0) {
          lines.push('# Assertions');
          const firstVisible = elements.find((el) => el.testID || el.text);
          if (firstVisible) {
            const sel = firstVisible.testID
              ? `id: "${firstVisible.testID}"`
              : `text: "${firstVisible.text}"`;
            lines.push(`- assertVisible:`);
            lines.push(`    ${sel}`);
          }
        }

        return lines.join('\n');
      },
    });

    ctx.registerTool('record_interaction', {
      description:
        'Start or stop recording user interactions and output as Maestro YAML steps. Note: This captures console events, not native touch events.',
      parameters: z.object({
        action: z.enum(['start', 'stop']).describe('Start or stop recording'),
      }),
      handler: async ({ action }) => {
        if (action === 'start') {
          // Inject a recording hook
          await evalInApp(`
            (function() {
              global.__METRO_MCP_RECORDING__ = [];
              // Patch console to capture navigation events
              var origNav = console.info;
              console.info = function() {
                var args = Array.from(arguments);
                var msg = args.join(' ');
                if (msg.includes('navigate') || msg.includes('press') || msg.includes('tap')) {
                  global.__METRO_MCP_RECORDING__.push({
                    time: Date.now(),
                    type: 'interaction',
                    description: msg,
                  });
                }
                origNav.apply(console, arguments);
              };
            })()
          `);
          return 'Recording started. Interact with the app, then call record_interaction with action="stop".';
        } else {
          const events = await evalInApp(`
            (function() {
              var events = global.__METRO_MCP_RECORDING__ || [];
              delete global.__METRO_MCP_RECORDING__;
              return events;
            })()
          `);

          if (!Array.isArray(events) || events.length === 0) {
            return 'No interactions recorded. Use generate_maestro_flow instead for description-based generation.';
          }

          const lines = ['---', '# Recorded interaction flow', ''];
          for (const event of events) {
            lines.push(`# ${(event as Record<string, unknown>).description}`);
          }

          return lines.join('\n');
        }
      },
    });
  },
});
