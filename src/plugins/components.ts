import { z } from 'zod';
import { definePlugin } from '../plugin.js';

// JS expression to walk the React fiber tree
const WALK_FIBER_EXPR = `
(function() {
  var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return null;

  var roots = [];
  try {
    var fiberRoots = hook.getFiberRoots(1);
    if (!fiberRoots || fiberRoots.size === 0) {
      // Try renderer IDs 1-5
      for (var i = 1; i <= 5; i++) {
        fiberRoots = hook.getFiberRoots(i);
        if (fiberRoots && fiberRoots.size > 0) break;
      }
    }
    if (!fiberRoots || fiberRoots.size === 0) return null;
    roots = Array.from(fiberRoots);
  } catch(e) { return null; }

  var OPTIONS = __OPTIONS__;

  function getName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === 'string') return fiber.type;
    return fiber.type.displayName || fiber.type.name || null;
  }

  function walkFiber(fiber, depth) {
    if (!fiber || depth > (OPTIONS.maxDepth || 50)) return null;

    var name = getName(fiber);
    var node = null;

    if (name) {
      node = { name: name };

      if (!OPTIONS.structureOnly) {
        if (fiber.memoizedProps && Object.keys(fiber.memoizedProps).length > 0) {
          try {
            var props = {};
            var propKeys = Object.keys(fiber.memoizedProps);
            for (var i = 0; i < Math.min(propKeys.length, 20); i++) {
              var key = propKeys[i];
              var val = fiber.memoizedProps[key];
              if (key === 'children') continue;
              if (typeof val === 'function') { props[key] = '[function]'; }
              else if (typeof val === 'object' && val !== null) { props[key] = '[object]'; }
              else { props[key] = val; }
            }
            if (Object.keys(props).length > 0) node.props = props;
          } catch(e) {}
        }
      }

      if (OPTIONS.includeTestIds) {
        var testID = fiber.memoizedProps?.testID;
        var accessibilityLabel = fiber.memoizedProps?.accessibilityLabel;
        var accessibilityRole = fiber.memoizedProps?.accessibilityRole;
        if (testID) node.testID = testID;
        if (accessibilityLabel) node.accessibilityLabel = accessibilityLabel;
        if (accessibilityRole) node.accessibilityRole = accessibilityRole;
      }
    }

    var children = [];
    var child = fiber.child;
    while (child) {
      var childNode = walkFiber(child, depth + 1);
      if (childNode) children.push(childNode);
      child = child.sibling;
    }

    if (node) {
      if (children.length > 0) node.children = children;
      return node;
    }

    if (children.length === 1) return children[0];
    if (children.length > 1) return { name: 'Fragment', children: children };
    return null;
  }

  var rootFiber = roots[0].current;
  return walkFiber(rootFiber, 0);
})()
`;

export const componentsPlugin = definePlugin({
  name: 'components',
  version: '0.1.0',
  description: 'React component tree inspection via fiber tree walking',

  async setup(ctx) {
    async function evalInApp(expression: string): Promise<unknown> {
      if (!ctx.cdp.isConnected()) throw new Error('Not connected');
      const result = (await ctx.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        timeout: 5000,
      })) as Record<string, unknown>;

      if (result.exceptionDetails) {
        throw new Error('Failed to walk fiber tree');
      }
      return (result.result as Record<string, unknown>).value;
    }

    ctx.registerTool('get_component_tree', {
      description:
        'Get the React component tree of the running app. Use structureOnly=true for a compact view (~1-3KB).',
      parameters: z.object({
        structureOnly: z.boolean().default(false).describe('Return only component names without props/state'),
        maxDepth: z.number().default(30).describe('Maximum depth to traverse'),
        compact: z.boolean().default(false).describe('Return compact single-line format'),
      }),
      handler: async ({ structureOnly, maxDepth, compact: isCompact }) => {
        const options = JSON.stringify({ structureOnly, maxDepth, includeTestIds: true });
        const expr = WALK_FIBER_EXPR.replace('__OPTIONS__', options);
        const tree = await evalInApp(expr);
        if (!tree) return 'Component tree not available. Ensure React DevTools hook is present.';
        if (isCompact) return ctx.format.compact(tree);
        return tree;
      },
    });

    ctx.registerTool('find_components', {
      description: 'Search for components by name pattern in the React tree.',
      parameters: z.object({
        pattern: z.string().describe('Component name or pattern to search for'),
        includeProps: z.boolean().default(true).describe('Include component props in results'),
      }),
      handler: async ({ pattern, includeProps }) => {
        const options = JSON.stringify({
          structureOnly: !includeProps,
          maxDepth: 50,
          includeTestIds: true,
        });
        const expr = WALK_FIBER_EXPR.replace('__OPTIONS__', options);
        const tree = await evalInApp(expr);
        if (!tree) return 'Component tree not available.';

        const matches: unknown[] = [];
        const regex = new RegExp(pattern, 'i');

        function search(node: Record<string, unknown>) {
          if (typeof node.name === 'string' && regex.test(node.name)) {
            matches.push(node);
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              search(child as Record<string, unknown>);
            }
          }
        }

        search(tree as Record<string, unknown>);
        return matches.length > 0
          ? matches
          : `No components matching "${pattern}" found.`;
      },
    });

    ctx.registerTool('inspect_component', {
      description: 'Get detailed props, state, and hooks info for a specific component.',
      parameters: z.object({
        name: z.string().describe('Exact component name to inspect'),
      }),
      handler: async ({ name }) => {
        const expr = `
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
            var target = null;

            function find(fiber) {
              if (!fiber) return;
              var n = fiber.type?.displayName || fiber.type?.name;
              if (n === '${name.replace(/'/g, "\\'")}') { target = fiber; return; }
              find(fiber.child);
              if (!target) find(fiber.sibling);
            }
            find(rootFiber);

            if (!target) return null;

            var result = {
              name: '${name}',
              props: {},
              state: null,
              hooks: [],
            };

            // Props
            if (target.memoizedProps) {
              var pkeys = Object.keys(target.memoizedProps);
              for (var i = 0; i < pkeys.length; i++) {
                var k = pkeys[i];
                var v = target.memoizedProps[k];
                if (typeof v === 'function') result.props[k] = '[function]';
                else if (typeof v === 'object' && v !== null) {
                  try { result.props[k] = JSON.parse(JSON.stringify(v)); }
                  catch(e) { result.props[k] = '[object]'; }
                }
                else result.props[k] = v;
              }
            }

            // State (hooks)
            var hookState = target.memoizedState;
            var hookIdx = 0;
            while (hookState && hookIdx < 20) {
              try {
                var val = hookState.memoizedState;
                if (val !== undefined) {
                  if (typeof val === 'function') result.hooks.push({ index: hookIdx, value: '[function]' });
                  else if (typeof val === 'object' && val !== null) {
                    try { result.hooks.push({ index: hookIdx, value: JSON.parse(JSON.stringify(val)) }); }
                    catch(e) { result.hooks.push({ index: hookIdx, value: '[object]' }); }
                  }
                  else result.hooks.push({ index: hookIdx, value: val });
                }
              } catch(e) {}
              hookState = hookState.next;
              hookIdx++;
            }

            return result;
          })()
        `;
        const result = await evalInApp(expr);
        if (!result) return `Component "${name}" not found in the tree.`;
        return result;
      },
    });

    ctx.registerTool('get_testable_elements', {
      description:
        'Get all elements with testID or accessibilityLabel — useful for test generation.',
      parameters: z.object({}),
      handler: async () => {
        const options = JSON.stringify({
          structureOnly: true,
          maxDepth: 50,
          includeTestIds: true,
        });
        const expr = WALK_FIBER_EXPR.replace('__OPTIONS__', options);
        const tree = await evalInApp(expr);
        if (!tree) return 'Component tree not available.';

        const elements: Array<{ name: string; testID?: string; accessibilityLabel?: string; accessibilityRole?: string }> = [];

        function collect(node: Record<string, unknown>) {
          if (node.testID || node.accessibilityLabel) {
            elements.push({
              name: node.name as string,
              testID: node.testID as string | undefined,
              accessibilityLabel: node.accessibilityLabel as string | undefined,
              accessibilityRole: node.accessibilityRole as string | undefined,
            });
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              collect(child as Record<string, unknown>);
            }
          }
        }

        collect(tree as Record<string, unknown>);
        return elements.length > 0
          ? elements
          : 'No elements with testID or accessibilityLabel found.';
      },
    });
  },
});
