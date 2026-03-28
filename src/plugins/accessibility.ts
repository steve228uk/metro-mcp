import { z } from 'zod';
import { definePlugin } from '../plugin.js';

interface AccessibilityIssue {
  component: string;
  issue: string;
  severity: 'error' | 'warning' | 'info';
  fix: string;
}

export const accessibilityPlugin = definePlugin({
  name: 'accessibility',
  version: '0.1.0',
  description: 'Accessibility auditing via fiber tree inspection',

  async setup(ctx) {
    async function evalInApp(expression: string): Promise<unknown> {
      if (!ctx.cdp.isConnected()) throw new Error('Not connected');
      const result = (await ctx.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        timeout: 10000,
      })) as Record<string, unknown>;
      if (result.exceptionDetails) {
        const details = result.exceptionDetails as Record<string, unknown>;
        const exception = details.exception as Record<string, unknown> | undefined;
        const message =
          (exception?.description as string) ||
          (details.text as string) ||
          'Evaluation failed';
        throw new Error(message);
      }
      return (result.result as Record<string, unknown>).value;
    }

    const AUDIT_EXPR = `
      (function() {
        var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook || !hook.getFiberRoots) return null;

        var fiberRoots;
        for (var i = 1; i <= 5; i++) {
          fiberRoots = hook.getFiberRoots(i);
          if (fiberRoots && fiberRoots.size > 0) break;
        }
        if (!fiberRoots || fiberRoots.size === 0) return null;

        var rootFiber = Array.from(fiberRoots)[0].current;
        var issues = [];

        var TOUCHABLE_TYPES = [
          'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback',
          'TouchableNativeFeedback', 'Pressable', 'Button',
        ];

        var IMAGE_TYPES = ['Image', 'FastImage', 'ExpoImage'];

        var INPUT_TYPES = ['TextInput', 'TextField'];

        function auditFiber(fiber, depth) {
          if (!fiber || depth > 50) return;

          var name = fiber.type?.displayName || fiber.type?.name;
          if (!name || typeof name !== 'string') {
            auditFiber(fiber.child, depth + 1);
            auditFiber(fiber.sibling, depth);
            return;
          }

          var props = fiber.memoizedProps || {};

          // Check touchable elements
          if (TOUCHABLE_TYPES.indexOf(name) >= 0 || props.onPress) {
            if (!props.accessibilityLabel && !props['aria-label']) {
              // Check if it has text children
              var hasTextChild = false;
              var child = fiber.child;
              while (child) {
                var cn = child.type?.displayName || child.type?.name;
                if (cn === 'Text' || cn === 'RCTText') { hasTextChild = true; break; }
                child = child.sibling;
              }
              if (!hasTextChild) {
                issues.push({
                  component: name,
                  issue: 'Missing accessibilityLabel on interactive element',
                  severity: 'error',
                  fix: 'Add accessibilityLabel prop describing the button action',
                  testID: props.testID || null,
                });
              }
            }
            if (!props.accessibilityRole && !props['role']) {
              issues.push({
                component: name,
                issue: 'Missing accessibilityRole',
                severity: 'warning',
                fix: 'Add accessibilityRole="button" (or appropriate role)',
                testID: props.testID || null,
              });
            }
            if (!props.testID) {
              issues.push({
                component: name,
                issue: 'Missing testID (needed for automated testing)',
                severity: 'info',
                fix: 'Add testID prop for test automation',
              });
            }
          }

          // Check images
          if (IMAGE_TYPES.indexOf(name) >= 0) {
            if (!props.accessibilityLabel && !props['aria-label'] && !props.alt) {
              issues.push({
                component: name,
                issue: 'Image missing alt text / accessibilityLabel',
                severity: 'error',
                fix: 'Add accessibilityLabel describing the image, or set accessible={false} for decorative images',
                testID: props.testID || null,
              });
            }
          }

          // Check text inputs
          if (INPUT_TYPES.indexOf(name) >= 0) {
            if (!props.accessibilityLabel && !props['aria-label'] && !props.placeholder) {
              issues.push({
                component: name,
                issue: 'Input missing label',
                severity: 'error',
                fix: 'Add accessibilityLabel describing what to enter',
                testID: props.testID || null,
              });
            }
          }

          // Check headings
          if (props.accessibilityRole === 'header' || props.role === 'heading') {
            if (!props.accessibilityLabel && !props['aria-label']) {
              issues.push({
                component: name,
                issue: 'Heading missing accessibilityLabel',
                severity: 'warning',
                fix: 'Add accessibilityLabel to heading element',
              });
            }
          }

          auditFiber(fiber.child, depth + 1);
          auditFiber(fiber.sibling, depth);
        }

        auditFiber(rootFiber, 0);
        return issues;
      })()
    `;

    ctx.registerTool('audit_accessibility', {
      description:
        'Run a full accessibility audit on the current screen. Checks for missing labels, roles, testIDs, alt text, and more.',
      parameters: z.object({
        severity: z.enum(['all', 'error', 'warning', 'info']).default('all').describe('Filter by severity level'),
      }),
      handler: async ({ severity }) => {
        const issues = (await evalInApp(AUDIT_EXPR)) as AccessibilityIssue[] | null;
        if (!issues) return 'Could not access component tree for audit.';
        if (issues.length === 0) return 'No accessibility issues found!';

        const filtered = severity === 'all' ? issues : issues.filter((i) => i.severity === severity);

        const errorCount = issues.filter((i) => i.severity === 'error').length;
        const warnCount = issues.filter((i) => i.severity === 'warning').length;
        const infoCount = issues.filter((i) => i.severity === 'info').length;

        return {
          summary: `${issues.length} issues found: ${errorCount} errors, ${warnCount} warnings, ${infoCount} info`,
          issues: filtered,
        };
      },
    });

    ctx.registerTool('check_element_accessibility', {
      description: 'Check accessibility properties of a specific component by name or testID.',
      parameters: z.object({
        name: z.string().optional().describe('Component name to check'),
        testID: z.string().optional().describe('testID to find'),
      }),
      handler: async ({ name, testID }) => {
        const searchBy = testID
          ? `props.testID === '${testID.replace(/'/g, "\\'")}'`
          : `(fiber.type?.displayName || fiber.type?.name) === '${(name || '').replace(/'/g, "\\'")}'`;

        const expr = `
          (function() {
            var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook || !hook.getFiberRoots) return null;
            var fiberRoots;
            for (var i = 1; i <= 5; i++) {
              fiberRoots = hook.getFiberRoots(i);
              if (fiberRoots && fiberRoots.size > 0) break;
            }
            if (!fiberRoots) return null;
            var rootFiber = Array.from(fiberRoots)[0].current;
            var target = null;

            function find(fiber) {
              if (!fiber || target) return;
              var props = fiber.memoizedProps || {};
              if (${searchBy}) { target = fiber; return; }
              find(fiber.child);
              find(fiber.sibling);
            }
            find(rootFiber);
            if (!target) return null;

            var props = target.memoizedProps || {};
            return {
              name: target.type?.displayName || target.type?.name,
              testID: props.testID,
              accessibilityLabel: props.accessibilityLabel || props['aria-label'],
              accessibilityRole: props.accessibilityRole || props['role'],
              accessibilityHint: props.accessibilityHint || props['aria-describedby'],
              accessibilityState: props.accessibilityState,
              accessible: props.accessible,
              importantForAccessibility: props.importantForAccessibility,
            };
          })()
        `;
        const result = await evalInApp(expr);
        if (!result) return `Element not found.`;
        return result;
      },
    });

    ctx.registerTool('get_accessibility_summary', {
      description: 'Quick overview: counts of elements with and without proper accessibility props.',
      parameters: z.object({}),
      handler: async () => {
        const expr = `
          (function() {
            var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook || !hook.getFiberRoots) return null;
            var fiberRoots;
            for (var i = 1; i <= 5; i++) {
              fiberRoots = hook.getFiberRoots(i);
              if (fiberRoots && fiberRoots.size > 0) break;
            }
            if (!fiberRoots) return null;
            var rootFiber = Array.from(fiberRoots)[0].current;

            var stats = {
              totalComponents: 0,
              withAccessibilityLabel: 0,
              withTestID: 0,
              withRole: 0,
              touchableWithoutLabel: 0,
              imagesWithoutAlt: 0,
            };

            function count(fiber) {
              if (!fiber) return;
              var name = fiber.type?.displayName || fiber.type?.name;
              if (name) {
                stats.totalComponents++;
                var props = fiber.memoizedProps || {};
                if (props.accessibilityLabel || props['aria-label']) stats.withAccessibilityLabel++;
                if (props.testID) stats.withTestID++;
                if (props.accessibilityRole || props['role']) stats.withRole++;
                if (props.onPress && !props.accessibilityLabel && !props['aria-label']) stats.touchableWithoutLabel++;
                if ((name === 'Image' || name === 'FastImage') && !props.accessibilityLabel && !props.alt) stats.imagesWithoutAlt++;
              }
              count(fiber.child);
              count(fiber.sibling);
            }
            count(rootFiber);
            return stats;
          })()
        `;
        const result = await evalInApp(expr);
        if (!result) return 'Could not access component tree.';
        return result;
      },
    });
  },
});
