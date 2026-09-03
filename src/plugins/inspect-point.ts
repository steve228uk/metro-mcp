import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { awaitAppResult } from '../utils/await-app-result.js';
import {
  DEFAULT_FIBER_MAX_DEPTH,
  DEFAULT_FIBER_MAX_NODES,
  MAX_FIBER_DEPTH,
  MAX_FIBER_NODES,
  buildFiberReadExpression,
} from '../utils/fiber.js';

export const inspectPointPlugin = definePlugin({
  name: 'inspect-point',
  description: 'Coordinate-based React component inspection (experimental)',

  async setup(ctx) {
    ctx.registerTool('inspect_at_point', {
      description:
        'Inspect the smallest measured host component at screen coordinates. Uses awaited Fabric/Paper measurement and returns traversal completeness metadata.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        x: z.number().describe('X coordinate (points/dp)'),
        y: z.number().describe('Y coordinate (points/dp)'),
        includeProps: z
          .boolean()
          .default(true)
          .describe('Include component props in the result'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(MAX_FIBER_DEPTH)
          .default(DEFAULT_FIBER_MAX_DEPTH),
        maxNodes: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIBER_NODES)
          .default(DEFAULT_FIBER_MAX_NODES),
      }),
      handler: async ({ x, y, includeProps, maxDepth, maxNodes }) => {
        const expression = buildFiberReadExpression(
          `
            var targetX = ${JSON.stringify(x)};
            var targetY = ${JSON.stringify(y)};
            var candidates = [];
            var measurements = [];

            function hostInstance(fiber, renderer) {
              var stateNode = fiber && fiber.stateNode;
              var instances = [];
              if (renderer && typeof renderer.findHostInstanceByFiber === 'function') {
                try { instances.push(renderer.findHostInstanceByFiber(fiber)); }
                catch (_) {}
              }
              instances.push(
                stateNode && stateNode.canonical && stateNode.canonical.publicInstance,
                stateNode && stateNode.publicInstance,
                stateNode && stateNode.__internalInstanceHandle &&
                  stateNode.__internalInstanceHandle.stateNode &&
                  stateNode.__internalInstanceHandle.stateNode.canonical &&
                  stateNode.__internalInstanceHandle.stateNode.canonical.publicInstance,
                stateNode
              );
              for (var index = 0; index < instances.length; index++) {
                var instance = instances[index];
                if (instance && (
                  typeof instance.getBoundingClientRect === 'function' ||
                  typeof instance.measure === 'function'
                )) return instance;
              }
              return null;
            }

            function measureFiber(fiber, renderer, depth) {
              var instance = hostInstance(fiber, renderer);
              if (!instance) return Promise.resolve(null);
              return new Promise(function(resolve) {
                var settled = false;
                var finish = function(rect) {
                  if (settled) return;
                  settled = true;
                  if (!rect) return resolve(null);
                  var width = Number(rect.width);
                  var height = Number(rect.height);
                  var rectX = Number(rect.x != null ? rect.x : rect.left);
                  var rectY = Number(rect.y != null ? rect.y : rect.top);
                  if (![rectX, rectY, width, height].every(Number.isFinite)) {
                    return resolve(null);
                  }
                  resolve({
                    fiber: fiber,
                    depth: depth,
                    layout: { x: rectX, y: rectY, width: width, height: height }
                  });
                };
                var timer = setTimeout(function() { finish(null); }, 150);
                var done = function(rect) { clearTimeout(timer); finish(rect); };
                try {
                  if (typeof instance.getBoundingClientRect === 'function') {
                    var rect = instance.getBoundingClientRect();
                    if (rect && typeof rect.then === 'function') {
                      rect.then(done, function() { done(null); });
                    } else done(rect);
                  } else {
                    instance.measure(function(localX, localY, width, height, pageX, pageY) {
                      done({
                        x: pageX == null ? localX : pageX,
                        y: pageY == null ? localY : pageY,
                        width: width,
                        height: height
                      });
                    });
                  }
                } catch (_) { done(null); }
              });
            }

            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              if (typeof fiber.type !== 'string' || !fiber.stateNode) return;
              measurements.push(measureFiber(fiber, context.renderer, context.depth));
            });
            candidates = (await Promise.all(measurements)).filter(Boolean);

            var best = null;
            var bestArea = Infinity;
            candidates.forEach(function(candidate) {
              var layout = candidate.layout;
              if (
                layout.width <= 0 || layout.height <= 0 ||
                targetX < layout.x || targetX > layout.x + layout.width ||
                targetY < layout.y || targetY > layout.y + layout.height
              ) return;
              var area = layout.width * layout.height;
              if (area < bestArea) { best = candidate; bestArea = area; }
            });

            if (!best) {
              return {
                result: {
                  found: false,
                  message: 'No measured component contains (' + targetX + ', ' + targetY + ').'
                },
                traversal: traversal
              };
            }

            var owner = best.fiber;
            var componentName = null;
            var componentProps = null;
            while (owner) {
              if (typeof owner.type !== 'string') {
                componentName = metroFiberName(owner);
                if (componentName) {
                  componentProps = owner.memoizedProps;
                  break;
                }
              }
              owner = owner.return;
            }
            var result = {
              found: true,
              hostComponent: best.fiber.type,
              reactComponent: componentName || '(anonymous)',
              layout: best.layout,
              depth: best.depth
            };
            if (${includeProps} && componentProps) {
              result.props = metroSafeProps({ memoizedProps: componentProps }, 20);
            }
            return { result: result, traversal: traversal };
          `,
          { maxDepth, maxNodes },
          true,
        );

        return awaitAppResult(ctx.evalInApp, expression);
      },
    });
  },
});
