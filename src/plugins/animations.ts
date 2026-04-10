import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const LIST_ANIMATED_VALUES_EXPR = (limit: number, onlyAnimating: boolean) => `(function() {
  try {
    var Animated = require('react-native').Animated;
    // Try internal _nodes Map (stable across RN versions)
    var nodes = null;
    if (Animated && Animated._nodes) nodes = Animated._nodes;
    if (!nodes) return { error: 'Animated._nodes not accessible in this RN version.' };
    var result = [];
    nodes.forEach(function(node, id) {
      if (result.length >= ${limit}) return;
      var isAnimating = !!(node && node._animation);
      if (${onlyAnimating} && !isAnimating) return;
      var value = null;
      try {
        if (node._value !== undefined) value = node._value;
        else if (node._a !== undefined && node._b !== undefined) {
          // InterpolationAnimatedNode - skip raw value
          value = '(interpolation)';
        }
      } catch(e) {}
      result.push({
        id: id,
        value: value,
        type: (node && node.constructor && node.constructor.name) || 'unknown',
        isAnimating: isAnimating,
        animationType: (isAnimating && node._animation && node._animation.constructor && node._animation.constructor.name) || null,
        listenerCount: (node && node._listeners) ? Object.keys(node._listeners).length : 0,
      });
    });
    return { count: nodes.size, returned: result.length, values: result };
  } catch(e) {
    return { error: e.message };
  }
})()`;

const GET_ANIMATED_VALUE_EXPR = (id: number) => `(function() {
  try {
    var Animated = require('react-native').Animated;
    var nodes = Animated && Animated._nodes;
    if (!nodes) return { error: 'Animated._nodes not accessible.' };
    var node = nodes.get(${id});
    if (!node) return { error: 'Node ' + ${id} + ' not found.' };
    return {
      id: ${id},
      type: (node.constructor && node.constructor.name) || 'unknown',
      value: node._value !== undefined ? node._value : null,
      offset: node._offset !== undefined ? node._offset : null,
      isAnimating: !!(node._animation),
      animationType: (node._animation && node._animation.constructor && node._animation.constructor.name) || null,
      listenerCount: node._listeners ? Object.keys(node._listeners).length : 0,
      hasNativeID: node.__isNative || false,
    };
  } catch(e) {
    return { error: e.message };
  }
})()`;

const LIST_SHARED_VALUES_EXPR = (limit: number) => `(function() {
  try {
    if (!globalThis.__reanimatedModuleProxy) {
      return { available: false, error: 'Reanimated not available (__reanimatedModuleProxy not found).' };
    }
    // Reanimated 3 stores shared values in __reanimatedSharedValues (not always public)
    var reg = globalThis.__reanimatedSharedValues || globalThis.__shareableCache || null;
    if (!reg) {
      return {
        available: true,
        note: 'Reanimated is loaded but shared value registry not accessible. ' +
              'This is expected in production builds or Reanimated versions that do not expose __reanimatedSharedValues.',
        values: [],
        totalCount: null,
      };
    }
    var keys = Object.keys(reg).slice(0, ${limit});
    var values = keys.map(function(id) {
      var sv = reg[id];
      return {
        id: id,
        value: sv && sv.value !== undefined ? sv.value : null,
        type: (sv && sv._type) || 'unknown',
      };
    });
    return { available: true, totalCount: Object.keys(reg).length, returned: values.length, values: values };
  } catch(e) {
    return { available: false, error: e.message };
  }
})()`;

const GET_ANIMATION_SUMMARY_EXPR = `(function() {
  var result = {
    coreAnimated: { available: false },
    reanimated: { available: false },
  };

  try {
    var Animated = require('react-native').Animated;
    var nodes = Animated && Animated._nodes;
    if (nodes) {
      var animatingCount = 0;
      nodes.forEach(function(node) {
        if (node && node._animation) animatingCount++;
      });
      result.coreAnimated = {
        available: true,
        totalNodes: nodes.size,
        animatingNodes: animatingCount,
      };
    }
  } catch(e) {
    result.coreAnimated = { available: false, error: e.message };
  }

  try {
    if (globalThis.__reanimatedModuleProxy) {
      var reg = globalThis.__reanimatedSharedValues || globalThis.__shareableCache || null;
      result.reanimated = {
        available: true,
        sharedValueCount: reg ? Object.keys(reg).length : null,
        registryAccessible: !!reg,
      };
    }
  } catch(e) {
    result.reanimated = { available: false, error: e.message };
  }

  return result;
})()`;

export const animationsPlugin = definePlugin({
  name: 'animations',
  description:
    'Inspect active React Native Animated values and Reanimated shared values for debugging animation state.',

  async setup(ctx) {
    ctx.registerTool('get_animation_summary', {
      description:
        'Get a high-level summary of animation state in the app: ' +
        'total Animated node count, how many are actively animating, ' +
        'and whether Reanimated is available with its shared value count.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(GET_ANIMATION_SUMMARY_EXPR);
          return result ?? { error: 'Could not read animation state from app runtime.' };
        } catch (err) {
          return `Failed to get animation summary: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('list_animated_values', {
      description:
        'List React Native core Animated nodes with their current values and animation state. ' +
        'Accesses Animated._nodes (internal but stable across RN versions). ' +
        'Use onlyAnimating=true to filter to nodes currently running an animation.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe('Maximum number of nodes to return (default 50)'),
        onlyAnimating: z
          .boolean()
          .default(false)
          .describe('Only return nodes that are currently animating (default false)'),
      }),
      handler: async ({ limit, onlyAnimating }) => {
        try {
          const result = await ctx.evalInApp(LIST_ANIMATED_VALUES_EXPR(limit, onlyAnimating));
          return result ?? { error: 'No result returned from app runtime.' };
        } catch (err) {
          return `Failed to list animated values: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_animated_value', {
      description:
        'Get detailed information about a specific Animated node by its numeric ID. ' +
        'Use list_animated_values first to find node IDs. ' +
        'Returns current value, animation type, listener count, and native driver status.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        id: z.number().int().describe('Animated node ID (from list_animated_values)'),
      }),
      handler: async ({ id }) => {
        try {
          const result = await ctx.evalInApp(GET_ANIMATED_VALUE_EXPR(id));
          return result ?? { error: `Node ${id} not found.` };
        } catch (err) {
          return `Failed to get animated value: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('list_shared_values', {
      description:
        'List Reanimated 3 shared values from the JS thread. ' +
        'Returns values from __reanimatedSharedValues if accessible. ' +
        'Returns an error if Reanimated is not installed.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe('Maximum number of shared values to return (default 50)'),
      }),
      handler: async ({ limit }) => {
        try {
          const result = await ctx.evalInApp(LIST_SHARED_VALUES_EXPR(limit));
          return result ?? { available: false, error: 'No result returned from app runtime.' };
        } catch (err) {
          return `Failed to list shared values: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
