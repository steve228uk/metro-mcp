import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const inspectPointPlugin = definePlugin({
  name: 'inspect-point',

  description: 'Coordinate-based React component inspection (experimental)',

  async setup(ctx) {
    ctx.registerTool('inspect_at_point', {
      description:
        'Inspect the React component rendered at specific screen coordinates. ' +
        'Walks the React fiber tree to find the component whose layout contains the given point. ' +
        'Experimental: layout measurement varies between Old and New Architecture.',
      parameters: z.object({
        x: z.number().describe('X coordinate (points/dp)'),
        y: z.number().describe('Y coordinate (points/dp)'),
        includeProps: z.boolean().default(true).describe('Include component props in the result'),
      }),
      handler: async ({ x, y, includeProps }) => {
        const expression = `(function() {
          var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook || !hook.renderers || hook.renderers.size === 0) {
            return { error: 'React DevTools hook not available. Is the app running in __DEV__ mode?' };
          }

          // Get the first renderer
          var renderer = hook.renderers.values().next().value;
          if (!renderer) return { error: 'No React renderer found.' };

          var fiberRoots = hook.getFiberRoots ? hook.getFiberRoots(1) : null;
          if (!fiberRoots || fiberRoots.size === 0) {
            return { error: 'No fiber roots found.' };
          }
          var root = fiberRoots.values().next().value;
          if (!root || !root.current) return { error: 'No root fiber found.' };

          var targetX = ${x};
          var targetY = ${y};
          var bestMatch = null;
          var bestArea = Infinity;

          // Walk the fiber tree
          function walkFiber(fiber, depth) {
            if (!fiber || depth > 60) return;

            // Check if this is a host component with a native node
            if (fiber.stateNode && typeof fiber.type === 'string') {
              try {
                var node = fiber.stateNode;
                // New Architecture (Fabric): node has a direct layout
                var layout = null;
                if (node._nativeTag != null) {
                  // Try to read cached layout from the fiber's memoizedProps
                  var props = fiber.memoizedProps || {};
                  // On Fabric, we can try the node's layout info
                  if (typeof nativeFabricUIManager !== 'undefined' && nativeFabricUIManager.measure) {
                    // Async measurement not available synchronously, skip
                  }
                }
                // Try reading layout from the stateNode directly (some RN versions cache this)
                if (node.__internalInstanceHandle && node.__internalInstanceHandle.stateNode) {
                  var sn = node.__internalInstanceHandle.stateNode;
                  if (sn.canonical && sn.canonical.currentProps) {
                    var style = sn.canonical.currentProps.style;
                    if (style && style.left != null && style.top != null && style.width != null && style.height != null) {
                      layout = { x: style.left, y: style.top, width: style.width, height: style.height };
                    }
                  }
                }

                if (layout) {
                  if (targetX >= layout.x && targetX <= layout.x + layout.width &&
                      targetY >= layout.y && targetY <= layout.y + layout.height) {
                    var area = layout.width * layout.height;
                    if (area < bestArea) {
                      bestArea = area;
                      bestMatch = { fiber: fiber, layout: layout };
                    }
                  }
                }
              } catch(e) { /* skip this fiber */ }
            }

            // Recurse into children
            if (fiber.child) walkFiber(fiber.child, depth + 1);
            if (fiber.sibling) walkFiber(fiber.sibling, depth);
          }

          walkFiber(root.current, 0);

          if (!bestMatch) {
            return {
              found: false,
              message: 'No component found at (' + targetX + ', ' + targetY + '). Layout data may not be available synchronously in this architecture.'
            };
          }

          // Walk up from the host fiber to find the nearest named React component
          var f = bestMatch.fiber;
          var componentName = null;
          var componentProps = null;
          while (f) {
            if (typeof f.type === 'function' || (typeof f.type === 'object' && f.type !== null)) {
              componentName = (f.type.displayName || f.type.name || null);
              if (componentName) {
                componentProps = ${includeProps} ? f.memoizedProps : undefined;
                break;
              }
            }
            f = f.return;
          }

          var result = {
            found: true,
            hostComponent: typeof bestMatch.fiber.type === 'string' ? bestMatch.fiber.type : 'unknown',
            reactComponent: componentName || '(anonymous)',
            layout: bestMatch.layout,
          };
          if (${includeProps} && componentProps) {
            try {
              // Serialize props safely (avoid circular refs)
              var safeProps = {};
              var keys = Object.keys(componentProps);
              for (var i = 0; i < Math.min(keys.length, 20); i++) {
                var k = keys[i];
                var v = componentProps[k];
                if (typeof v === 'function') safeProps[k] = '[Function]';
                else if (typeof v === 'object' && v !== null) safeProps[k] = '[Object]';
                else safeProps[k] = v;
              }
              result.props = safeProps;
            } catch(e) {}
          }
          return result;
        })()`;

        return await ctx.evalInApp(expression);
      },
    });
  },
});
