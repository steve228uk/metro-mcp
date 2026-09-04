import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { escapeJsString } from '../utils/format.js';
import {
  buildFiberReadExpression,
  DEFAULT_FIBER_MAX_DEPTH,
  DEFAULT_FIBER_MAX_NODES,
  MAX_FIBER_DEPTH,
  MAX_FIBER_NODES,
  type FiberTraversalMetadata,
} from '../utils/fiber.js';

interface AccessibilityIssue {
  component: string;
  issue: string;
  severity: 'error' | 'warning' | 'info';
  fix: string;
}

export const accessibilityPlugin = definePlugin({
  name: 'accessibility',

  description: 'Accessibility auditing via fiber tree inspection',

  async setup(ctx) {
    const AUDIT_BODY = `
        var issues = [];

        var TOUCHABLE_TYPES = [
          'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback',
          'TouchableNativeFeedback', 'Pressable', 'Button',
        ];

        var IMAGE_TYPES = ['Image', 'FastImage', 'ExpoImage'];

        var INPUT_TYPES = ['TextInput', 'TextField'];

        var records = [];
        var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
          var name = metroFiberName(fiber);
          var record = {
            name: name,
            props: fiber.memoizedProps || {},
            hasTextChild: false,
            childrenComplete: !fiber.child
          };
          var parent = context.parentContext;
          if (parent) {
            if (name === 'Text' || name === 'RCTText') parent.hasTextChild = true;
            if (!fiber.sibling) parent.childrenComplete = true;
          }
          records.push(record);
          return { childContext: record };
        });

        for (var record of records) {
          var name = record.name;
          if (!name || typeof name !== 'string') continue;
          var props = record.props;

          // Check touchable elements
          if (TOUCHABLE_TYPES.indexOf(name) >= 0 || props.onPress) {
            if (!props.accessibilityLabel && !props['aria-label']) {
              // Only report an absent text label when all immediate children
              // were inspected by the bounded walker.
              if (!record.hasTextChild && record.childrenComplete) {
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

        }
        return { issues: issues, traversal: traversal };
    `;

    ctx.registerTool('audit_accessibility', {
      description:
        'Audit the current screen within bounded Fiber traversal limits. Checks labels, roles, testIDs, and alt text; returns issues, summary, and traversal coverage.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        severity: z.enum(['all', 'error', 'warning', 'info']).default('all').describe('Filter by severity level'),
        maxDepth: z.number().int().min(0).max(MAX_FIBER_DEPTH).default(DEFAULT_FIBER_MAX_DEPTH)
          .describe('Maximum Fiber depth to inspect'),
        maxNodes: z.number().int().min(1).max(MAX_FIBER_NODES).default(DEFAULT_FIBER_MAX_NODES)
          .describe('Maximum Fibers to inspect'),
      }),
      handler: async ({ severity, maxDepth, maxNodes }) => {
        const result = (await ctx.evalInApp(buildFiberReadExpression(
          AUDIT_BODY, { maxDepth, maxNodes },
        ))) as { issues: AccessibilityIssue[]; traversal: FiberTraversalMetadata } | null;
        const issues = result?.issues ?? [];
        const traversal: FiberTraversalMetadata = result?.traversal ?? {
          scope: 'all-scenes',
          complete: false,
          scannedNodes: 0,
          depthReached: 0,
          truncationReason: 'fiber-roots-unavailable',
        };
        const filtered: AccessibilityIssue[] = [];
        const counts = { error: 0, warning: 0, info: 0 };
        for (const issue of issues) {
          counts[issue.severity]++;
          if (severity === 'all' || issue.severity === severity) filtered.push(issue);
        }

        let summary = `${issues.length} issues found: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info`;
        if (!traversal.complete) {
          summary = `Audit incomplete (${traversal.truncationReason}). ${summary}. Results cover only inspected components.`;
        } else if (issues.length === 0) {
          summary = 'No accessibility issues found!';
        }
        return { summary, issues: filtered, traversal };
      },
    });

    ctx.registerTool('check_element_accessibility', {
      description: 'Check accessibility properties of a specific component by name or testID.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        name: z.string().optional().describe('Component name to check'),
        testID: z.string().optional().describe('testID to find'),
      }),
      handler: async ({ name, testID }) => {
        const searchBy = testID
          ? `props.testID === '${escapeJsString(testID)}'`
          : `(fiber.type?.displayName || fiber.type?.name) === '${escapeJsString(name || '')}'`;

        const expr = `
          (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
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
        const result = await ctx.evalInApp(expr);
        if (!result) return `Element not found.`;
        return result;
      },
    });

    ctx.registerTool('get_accessibility_summary', {
      description: 'Quick overview: counts of elements with and without proper accessibility props.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const expr = `
          (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
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
        const result = await ctx.evalInApp(expr);
        if (!result) return 'Could not access component tree.';
        return result;
      },
    });
  },
});
