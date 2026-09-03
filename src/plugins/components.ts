import { z } from 'zod';
import { buildComponentsHtml } from '../apps/components.js';
import { definePlugin } from '../plugin.js';
import {
  DEFAULT_FIBER_MAX_DEPTH,
  DEFAULT_FIBER_MAX_NODES,
  MAX_FIBER_DEPTH,
  MAX_FIBER_NODES,
  buildFiberReadExpression,
  type FiberTraversalMetadata,
} from '../utils/fiber.js';
import {
  FiberSnapshotStore,
  type FlatFiberNode,
} from '../utils/fiber-snapshots.js';

const traversalParameters = {
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(MAX_FIBER_DEPTH)
    .default(DEFAULT_FIBER_MAX_DEPTH)
    .describe('Maximum fiber depth to traverse (default 200, maximum 600)'),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(MAX_FIBER_NODES)
    .default(DEFAULT_FIBER_MAX_NODES)
    .describe('Maximum fibers to scan (default 1200)'),
};

interface RuntimeTreeResult {
  nodes: FlatFiberNode[];
  traversal: FiberTraversalMetadata;
}

export const componentsPlugin = definePlugin({
  name: 'components',
  description: 'React component tree inspection via bounded fiber traversal',

  async setup(ctx) {
    const snapshots = new FiberSnapshotStore();

    ctx.registerAppResource('ui://metro/components', {
      name: 'Component Tree',
      description:
        'Interactive React fiber tree explorer with props, state, and testID viewer',
      handler: async () => buildComponentsHtml(),
    });

    ctx.registerTool('get_component_tree', {
      description:
        'Get a paged flat React component tree. Follow nextCursor to complete the snapshot and check traversal.complete before treating an empty page as authoritative.',
      annotations: { readOnlyHint: true },
      appUri: 'ui://metro/components',
      parameters: z.object({
        structureOnly: z
          .boolean()
          .default(false)
          .describe('Return component names and selectors without props'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(250)
          .default(100)
          .describe('Nodes per page (default 100, maximum 250)'),
        cursor: z
          .string()
          .optional()
          .describe('Opaque nextCursor returned by the previous page'),
        ...traversalParameters,
      }),
      handler: async ({
        structureOnly,
        pageSize,
        cursor,
        maxDepth,
        maxNodes,
      }) => {
        if (cursor) return snapshots.read(cursor, pageSize);

        const expression = buildFiberReadExpression(
          `
            var nodes = [];
            var nextId = 1;
            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              var name = metroFiberName(fiber);
              if (!name) return;
              var props = fiber.memoizedProps || {};
              var id = 'fiber-' + nextId++;
              var node = {
                id: id,
                parentId: context.parentContext || null,
                depth: context.depth,
                name: name
              };
              if (!${structureOnly}) {
                var safeProps = metroSafeProps(fiber, 20);
                if (Object.keys(safeProps).length) node.props = safeProps;
              }
              if (typeof props.testID === 'string') node.testID = props.testID;
              if (typeof props.accessibilityLabel === 'string') {
                node.accessibilityLabel = props.accessibilityLabel;
              }
              if (typeof props.accessibilityRole === 'string') {
                node.accessibilityRole = props.accessibilityRole;
              }
              nodes.push(node);
              return { childContext: id };
            });
            return { nodes: nodes, traversal: traversal };
          `,
          { maxDepth, maxNodes },
        );
        const result = (await ctx.evalInApp(expression, {
          timeout: 10_000,
        })) as RuntimeTreeResult | null;
        if (!result) {
          return snapshots.create(
            [],
            {
              scope: 'all-scenes',
              complete: false,
              depthReached: 0,
              scannedNodes: 0,
              truncationReason: 'fiber-roots-unavailable',
            },
            pageSize,
          );
        }
        return snapshots.create(result.nodes, result.traversal, pageSize);
      },
    });

    ctx.registerTool('find_components', {
      description:
        'Search for components by name inside the app runtime. Check traversal.complete before treating no matches as definitive.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        pattern: z.string().describe('Case-insensitive component name pattern'),
        includeProps: z
          .boolean()
          .default(true)
          .describe('Include component props in matches'),
        ...traversalParameters,
      }),
      handler: async ({ pattern, includeProps, maxDepth, maxNodes }) => {
        // Validate here for a concise tool error; matching itself stays in-app.
        new RegExp(pattern, 'i');
        const expression = buildFiberReadExpression(
          `
            var matches = [];
            var matcher = new RegExp(${JSON.stringify(pattern)}, 'i');
            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              var name = metroFiberName(fiber);
              if (!name || !matcher.test(name)) return;
              var props = fiber.memoizedProps || {};
              var match = { name: name, depth: context.depth };
              if (${includeProps}) match.props = metroSafeProps(fiber, 20);
              if (typeof props.testID === 'string') match.testID = props.testID;
              if (typeof props.accessibilityLabel === 'string') {
                match.accessibilityLabel = props.accessibilityLabel;
              }
              if (typeof props.accessibilityRole === 'string') {
                match.accessibilityRole = props.accessibilityRole;
              }
              matches.push(match);
            });
            return { matches: matches, traversal: traversal };
          `,
          { maxDepth, maxNodes },
        );
        return ctx.evalInApp(expression, { timeout: 10_000 });
      },
    });

    ctx.registerTool('inspect_component', {
      description:
        'Get props, state, and hooks for the first exact component-name match, with traversal completeness metadata.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        name: z.string().describe('Exact component name to inspect'),
        ...traversalParameters,
      }),
      handler: async ({ name, maxDepth, maxNodes }) => {
        const expression = buildFiberReadExpression(
          `
            var result = null;
            var targetName = ${JSON.stringify(name)};
            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              if (result || metroFiberName(fiber) !== targetName) return;
              var hooks = [];
              var hookState = fiber.memoizedState;
              var hookIndex = 0;
              while (hookState && hookIndex < 20) {
                try {
                  var value = hookState.memoizedState;
                  if (value !== undefined) {
                    if (typeof value === 'function') value = '[function]';
                    else if (value && typeof value === 'object') {
                      try { value = JSON.parse(JSON.stringify(value)); }
                      catch (_) { value = '[object]'; }
                    }
                    hooks.push({ index: hookIndex, value: value });
                  }
                } catch (_) {}
                hookState = hookState.next;
                hookIndex++;
              }
              result = {
                name: targetName,
                depth: context.depth,
                props: metroSafeProps(fiber, 50),
                state: null,
                hooks: hooks
              };
            });
            return { result: result, traversal: traversal };
          `,
          { maxDepth, maxNodes },
        );
        return ctx.evalInApp(expression, { timeout: 10_000 });
      },
    });

    ctx.registerTool('get_testable_elements', {
      description:
        'Get elements with testID or accessibilityLabel. Check traversal.complete before treating an empty elements array as definitive.',
      annotations: { readOnlyHint: true },
      parameters: z.object({ ...traversalParameters }),
      handler: async ({ maxDepth, maxNodes }) => {
        const expression = buildFiberReadExpression(
          `
            var elements = [];
            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              var element = metroElementFromFiber(fiber);
              if (!element || (!element.testID && !element.accessibilityLabel)) return;
              element.depth = context.depth;
              elements.push(element);
            });
            return { elements: elements, traversal: traversal };
          `,
          { maxDepth, maxNodes },
        );
        return ctx.evalInApp(expression, { timeout: 10_000 });
      },
    });
  },
});
