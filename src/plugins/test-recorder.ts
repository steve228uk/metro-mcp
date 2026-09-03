import { z } from 'zod';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { definePlugin } from '../plugin.js';
import {
  FIBER_WALKER_JS,
  GET_ROUTE_FUNC_JS,
  SWIPE_COORDS,
  buildFiberReadExpression,
} from '../utils/fiber.js';

// ── Resolve current navigation route from the nav ref set by the navigation plugin.
const CURRENT_ROUTE_JS = `
  (function() {
    try {
      var nav = globalThis.__METRO_MCP_NAV_REF__;
      if (nav && nav.getCurrentRoute) {
        var r = nav.getCurrentRoute();
        return r ? r.name : null;
      }
    } catch(e) {}
    return null;
  })()
`;

// ── JS injected into the app runtime to install the recorder instrumentation.
// Instrumentation and capture are deliberately separate. The first phase wraps
// future props, schedules refreshes for already-mounted props, and is followed
// by a bounded readiness scan. Capture is enabled only after that scan succeeds,
// so the first interaction after start_test_recording returns cannot be missed.
const START_RECORDING_JS = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return false;

  // A previous session may have been interrupted by a disconnected CDP
  // session. Clean it up when it is still the current installation.
  if (typeof globalThis.__METRO_MCP_REC_CLEANUP__ === 'function') {
    try { globalThis.__METRO_MCP_REC_CLEANUP__(); } catch (_) {}
  }

  var counter = Number(globalThis.__METRO_MCP_REC_SESSION_COUNTER__ || 0) + 1;
  globalThis.__METRO_MCP_REC_SESSION_COUNTER__ = counter;
  var state = {
    sessionId: 'recording-' + counter + '-' + Date.now(),
    capture: false,
    active: true,
    ready: false,
    events: []
  };
  globalThis.__METRO_MCP_REC_STATE__ = state;
  globalThis.__METRO_MCP_REC_EVENTS__ = state.events;

  ${GET_ROUTE_FUNC_JS}

  var HANDLERS = [
    'onPress', 'onLongPress', 'onChangeText', 'onSubmitEditing',
    'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'
  ];

  function isWrapped(fn) {
    return typeof fn === 'function' && fn.__mcpRecSession === state.sessionId;
  }

  function record(event) {
    if (state.capture && globalThis.__METRO_MCP_REC_STATE__ === state)
      state.events.push(event);
  }

  function wrap(obj, name, makeEvent) {
    var original = obj[name];
    if (typeof original !== 'function' || isWrapped(original)) return false;
    var wrapped = function() {
      if (state.capture && globalThis.__METRO_MCP_REC_STATE__ === state)
        record(makeEvent(arguments));
      return original.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, '__mcpRecSession', { value: state.sessionId });
      Object.defineProperty(wrapped, '__mcpRecOriginal', { value: original });
      obj[name] = wrapped;
      return obj[name] === wrapped;
    } catch (_) {
      return false;
    }
  }

  function isScrollable(obj) {
    return 'scrollEventThrottle' in obj || 'extraScrollHeight' in obj ||
      'showsVerticalScrollIndicator' in obj || 'showsHorizontalScrollIndicator' in obj ||
      'keyboardShouldPersistTaps' in obj || 'keyboardDismissMode' in obj ||
      'scrollEnabled' in obj || typeof obj.onScrollBeginDrag === 'function' ||
      typeof obj.onScrollEndDrag === 'function';
  }

  function wrapProps(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var tid = obj.testID || null;
    var lbl = obj.accessibilityLabel || obj['aria-label'] || null;
    var wrapped = false;
    wrapped = wrap(obj, 'onPress', function() {
      return { type: 'tap', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onLongPress', function() {
      return { type: 'long_press', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onChangeText', function(args) {
      return { type: 'type', testID: tid, label: lbl, text: args[0], route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onSubmitEditing', function() {
      return { type: 'submit', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;

    if (isScrollable(obj)) {
      var scrollStart = { x: null, y: null };
      var originalBegin = obj.onScrollBeginDrag;
      var originalEnd = obj.onScrollEndDrag;
      var originalMomentumEnd = obj.onMomentumScrollEnd;
      if (!isWrapped(originalBegin)) {
        var begin = function(e) {
          try {
            scrollStart.x = e.nativeEvent.contentOffset.x;
            scrollStart.y = e.nativeEvent.contentOffset.y;
          } catch (_) { scrollStart.x = scrollStart.y = null; }
          return originalBegin ? originalBegin.apply(this, arguments) : undefined;
        };
        try {
          Object.defineProperty(begin, '__mcpRecSession', { value: state.sessionId });
          obj.onScrollBeginDrag = begin;
          wrapped = obj.onScrollBeginDrag === begin || wrapped;
        } catch (_) {}
      }
      function emitSwipe(e) {
        if (scrollStart.x === null || !state.capture || globalThis.__METRO_MCP_REC_STATE__ !== state) return;
        try {
          var dx = e.nativeEvent.contentOffset.x - scrollStart.x;
          var dy = e.nativeEvent.contentOffset.y - scrollStart.y;
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            var direction = Math.abs(dx) > Math.abs(dy)
              ? (dx > 0 ? 'left' : 'right')
              : (dy > 0 ? 'up' : 'down');
            var last = state.events[state.events.length - 1];
            if (!(last && last.type === 'swipe' && Date.now() - last.timestamp < 100))
              record({ type: 'swipe', direction: direction, testID: tid, route: getRoute(), timestamp: Date.now() });
          }
        } catch (_) {}
        scrollStart.x = scrollStart.y = null;
      }
      if (!isWrapped(originalEnd)) {
        var end = function(e) { emitSwipe(e); return originalEnd ? originalEnd.apply(this, arguments) : undefined; };
        try {
          Object.defineProperty(end, '__mcpRecSession', { value: state.sessionId });
          obj.onScrollEndDrag = end;
          wrapped = obj.onScrollEndDrag === end || wrapped;
        } catch (_) {}
      }
      if (!isWrapped(originalMomentumEnd)) {
        var momentum = function(e) { emitSwipe(e); return originalMomentumEnd ? originalMomentumEnd.apply(this, arguments) : undefined; };
        try {
          Object.defineProperty(momentum, '__mcpRecSession', { value: state.sessionId });
          obj.onMomentumScrollEnd = momentum;
          wrapped = obj.onMomentumScrollEnd === momentum || wrapped;
        } catch (_) {}
      }
    }
    return wrapped;
  }

  // React Native (Hermes, dev mode) freezes props while they are still
  // mutable. Wrap handlers at that point, before the freeze is applied.
  var origFreeze = Object.freeze;
  Object.freeze = function(obj) {
    if (globalThis.__METRO_MCP_REC_STATE__ === state) wrapProps(obj);
    return origFreeze.call(this, obj);
  };

  // Already-mounted memoizedProps are usually frozen. Ask React to render
  // those fibers again so Object.freeze sees fresh mutable props. The shared
  // bounded walker keeps this initialization finite even for pathological
  // component trees.
  ${FIBER_WALKER_JS}
  metroWalkFibers({ maxDepth: 600, maxNodes: 5000 }, function(fiber) {
    var props = fiber && fiber.memoizedProps;
    if (!props || typeof props !== 'object') return;
    var needsRefresh = false;
    for (var i = 0; i < HANDLERS.length; i++) {
      if (typeof props[HANDLERS[i]] === 'function' && !isWrapped(props[HANDLERS[i]])) {
        needsRefresh = true;
        break;
      }
    }
    var scrollable = 'scrollEventThrottle' in props || 'extraScrollHeight' in props ||
      'showsVerticalScrollIndicator' in props || 'showsHorizontalScrollIndicator' in props ||
      'keyboardShouldPersistTaps' in props || 'keyboardDismissMode' in props ||
      'scrollEnabled' in props || typeof props.onScrollBeginDrag === 'function' ||
      typeof props.onScrollEndDrag === 'function';
    if (scrollable) {
      var scrollNames = ['onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'];
      for (var scrollIndex = 0; scrollIndex < scrollNames.length; scrollIndex++) {
        if (!isWrapped(props[scrollNames[scrollIndex]])) { needsRefresh = true; break; }
      }
    }
    if (!needsRefresh) return;
    var context = arguments[1] || {};
    var renderer = context.renderer || null;
    var refreshFiber = fiber;
    while (refreshFiber && (!refreshFiber.stateNode || typeof refreshFiber.stateNode.forceUpdate !== 'function'))
      refreshFiber = refreshFiber.return;
    if (refreshFiber && refreshFiber.stateNode && typeof refreshFiber.stateNode.forceUpdate === 'function') {
      try { refreshFiber.stateNode.forceUpdate(); return; } catch (_) {}
    }
    if (renderer && typeof renderer.overrideProps === 'function') {
      try {
        renderer.overrideProps(fiber, ['__mcpRecRefresh'], state.sessionId);
        // React DevTools schedules the update through pendingProps. Some
        // renderers do not call Object.freeze again for this path, so patch
        // the mutable pending copy as part of the same refresh operation.
        if (fiber.pendingProps && typeof fiber.pendingProps === 'object') wrapProps(fiber.pendingProps);
      } catch (_) {}
    }
  });

  // ── Track navigation events on every React commit ───────────────────────────
  var origCommit = hook.onCommitFiberRoot;
  var commitWrapper = function(id, root) {
    if (state.capture && globalThis.__METRO_MCP_REC_STATE__ === state) {
      var route = getRoute();
      var evts  = state.events;
      var last  = evts[evts.length - 1];
      if (route && (!last || last.type !== 'navigate' || last.route !== route))
        evts.push({ type: 'navigate', route: route, timestamp: Date.now() });
    }
    if (origCommit) origCommit.apply(this, arguments);
  };
  commitWrapper.__mcpRecState = state;
  commitWrapper.__mcpRecPrevious = origCommit;
  hook.onCommitFiberRoot = commitWrapper;

  globalThis.__METRO_MCP_REC_CLEANUP__ = function() {
    state.capture = false;
    state.active = false;
    state.ready = false;
    if (hook.onCommitFiberRoot === commitWrapper) {
      var predecessor = origCommit;
      // If a profiler that preceded us has already stopped, remove its
      // inactive wrapper as well once our own wrapper is removed.
      while (predecessor && predecessor.__mcpProfilerState && !predecessor.__mcpProfilerState.active)
        predecessor = predecessor.__mcpProfilerPrevious;
      hook.onCommitFiberRoot = predecessor;
    }
    if (Object.freeze === freezeWrapper) Object.freeze = origFreeze;
    if (globalThis.__METRO_MCP_REC_STATE__ === state) {
      globalThis.__METRO_MCP_REC_ACTIVE__ = false;
      delete globalThis.__METRO_MCP_REC_CLEANUP__;
      delete globalThis.__METRO_MCP_REC_STATE__;
    }
  };
  var freezeWrapper = Object.freeze;
  globalThis.__METRO_MCP_REC_CLEANUP__.origFreeze = origFreeze;
  return true;
})()
`;

const RECORDING_READINESS_JS = buildFiberReadExpression(`
  var state = globalThis.__METRO_MCP_REC_STATE__;
  if (!state) return { ready: false, error: 'no-session' };
  var handlers = [
    'onPress', 'onLongPress', 'onChangeText', 'onSubmitEditing',
    'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'
  ];
  var handlerCount = 0;
  var unwrapped = [];
  function isScrollable(props) {
    return 'scrollEventThrottle' in props || 'extraScrollHeight' in props ||
      'showsVerticalScrollIndicator' in props || 'showsHorizontalScrollIndicator' in props ||
      'keyboardShouldPersistTaps' in props || 'keyboardDismissMode' in props ||
      'scrollEnabled' in props || typeof props.onScrollBeginDrag === 'function' ||
      typeof props.onScrollEndDrag === 'function';
  }
  var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber) {
    var props = fiber && fiber.memoizedProps;
    if (!props || typeof props !== 'object') return;
    for (var index = 0; index < handlers.length; index++) {
      var name = handlers[index];
      if (typeof props[name] !== 'function') continue;
      handlerCount++;
      if (props[name].__mcpRecSession !== state.sessionId)
        unwrapped.push(name);
    }
    if (isScrollable(props)) {
      var scrollHandlers = ['onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'];
      for (var scrollIndex = 0; scrollIndex < scrollHandlers.length; scrollIndex++) {
        var scrollName = scrollHandlers[scrollIndex];
        if (typeof props[scrollName] !== 'function' || props[scrollName].__mcpRecSession !== state.sessionId)
          unwrapped.push(scrollName);
      }
    }
  });
  return {
    ready: traversal.complete && unwrapped.length === 0,
    handlerCount: handlerCount,
    unwrapped: unwrapped,
    traversal: traversal
  };
`, { maxDepth: 600, maxNodes: 5000 });

const ACTIVATE_RECORDING_JS = `(function() {
  var state = globalThis.__METRO_MCP_REC_STATE__;
  if (!state) return false;
  state.ready = true;
  state.capture = true;
  globalThis.__METRO_MCP_REC_ACTIVE__ = true;
  return true;
})()`;

const CLEANUP_RECORDING_JS = `(function() {
  if (globalThis.__METRO_MCP_REC_CLEANUP__) {
    try { globalThis.__METRO_MCP_REC_CLEANUP__(); } catch (_) {}
  }
  globalThis.__METRO_MCP_REC_ACTIVE__ = false;
  return true;
})()`;

interface RecordingReadiness {
  ready?: boolean;
  handlerCount?: number;
  unwrapped?: string[];
  traversal?: { complete?: boolean; truncationReason?: string };
}

// ── Recorded event shape (mirrors the JS-side object pushed to __METRO_MCP_REC_EVENTS__)
interface RecordedEvent {
  type: 'tap' | 'type' | 'long_press' | 'submit' | 'swipe' | 'navigate' | 'annotation';
  testID?:        string | null;
  label?:         string | null;
  componentName?: string | null;
  text?:          string;       // type events
  direction?:     string;       // swipe events
  route?:         string | null;
  note?:          string;       // annotation events
  timestamp:      number;
}

const RECORDINGS_DIR = join(homedir(), '.metro-mcp', 'recordings');

// ── Best WebdriverIO selector for an event
function appiumSelector(ev: RecordedEvent): string | null {
  if (ev.testID) return `~${ev.testID}`;
  if (ev.label)  return `~${ev.label}`;
  return null;
}

// ── Best Maestro selector string (id: / text:)
function maestroSelector(ev: RecordedEvent): string | null {
  if (ev.testID) return `id: "${ev.testID}"`;
  if (ev.label)  return `id: "${ev.label}"`;
  return null;
}

// ── Best Detox selector expression
function detoxSelector(ev: RecordedEvent): string | null {
  if (ev.testID) return `by.id(${JSON.stringify(ev.testID)})`;
  if (ev.label)  return `by.label(${JSON.stringify(ev.label)})`;
  return null;
}

// ── Deduplicate onChangeText keystrokes: keep only the final value per input field
// before the next non-type event (or end of list).
function deduplicateEvents(events: RecordedEvent[]): RecordedEvent[] {
  const result: RecordedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'type') {
      const next = events[i + 1];
      if (next?.type === 'type' && next.testID === ev.testID && next.label === ev.label) continue;
    }
    result.push(ev);
  }
  return result;
}

// ── Emit Appium capability lines into an array
function pushCaps(lines: string[], platform: 'ios' | 'android', bundleId: string | undefined, indent: string): void {
  if (platform === 'ios') {
    lines.push(`${indent}platformName: 'iOS',`);
    lines.push(`${indent}'appium:automationName': 'XCUITest',`);
    lines.push(bundleId
      ? `${indent}'appium:bundleId': '${bundleId}',`
      : `${indent}'appium:bundleId': 'com.example.app', // TODO: set bundle ID`);
  } else {
    lines.push(`${indent}platformName: 'Android',`);
    lines.push(`${indent}'appium:automationName': 'UiAutomator2',`);
    lines.push(bundleId
      ? `${indent}'appium:appPackage': '${bundleId}',`
      : `${indent}'appium:appPackage': 'com.example.app', // TODO: set app package`);
    lines.push(`${indent}'appium:appActivity': '.MainActivity',`);
  }
}

// ── Appium swipe touchAction block
function appiumSwipeLines(direction: string, indent: string): string[] {
  const [sx, sy, ex, ey] = SWIPE_COORDS[direction] ?? SWIPE_COORDS.up;
  return [
    `${indent}await driver.touchAction([`,
    `${indent}  { action: 'press',  x: ${sx}, y: ${sy} },`,
    `${indent}  { action: 'moveTo', x: ${ex}, y: ${ey} },`,
    `${indent}  { action: 'release' },`,
    `${indent}]);`,
  ];
}

// ── Persistent state for the recording session
let storedEvents: RecordedEvent[] | null = null;

export const testRecorderPlugin = definePlugin({
  name: 'test-recorder',

  description: 'Unified mobile test recorder: captures taps, text entry, swipes and navigation via fiber patching; generates Appium, Maestro, and Detox tests',

  async setup(ctx) {

    // ────────────────────────────────────────────────────────────────────────────
    // start_test_recording
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('start_test_recording', {
      description:
        'Inject interaction interceptors into the running app via the React fiber tree. ' +
        'Captures taps, text entry, long presses, keyboard submits, and scroll/swipe gestures — ' +
        'with no changes to your app code. Works with ScrollView, FlatList, SectionList, ' +
        'FlashList, and other scroll containers. ' +
        'Call stop_test_recording when done, then generate_test_from_recording to get the test.',
      annotations: { destructiveHint: false, idempotentHint: false },
      parameters: z.object({}),
      handler: async () => {
        storedEvents = null;

        let injected: unknown;
        let injectError = 'script returned false (check __REACT_DEVTOOLS_GLOBAL_HOOK__ availability)';
        try {
          injected = await ctx.evalInApp(START_RECORDING_JS, { timeout: 6000 });
        } catch (err) {
          injectError = err instanceof Error ? err.message : String(err);
          injected = false;
        }
        if (!injected) {
          // CDP can report a transport error after the app evaluated part of
          // the script. Always attempt cleanup for a partially-installed
          // session before returning the failure.
          await ctx.evalInApp(CLEANUP_RECORDING_JS, { timeout: 1000 }).catch(() => {});
          return `Could not inject recording hooks — ${injectError}`;
        }

        // The injection only installs instrumentation. Wait for a complete
        // bounded scan after React has had a chance to refresh frozen props;
        // enabling capture before this point loses the first interaction or
        // silently misses a deep handler.
        const deadline = Date.now() + 6000;
        let readiness: RecordingReadiness | null = null;
        while (Date.now() < deadline) {
          try {
            readiness = await ctx.evalInApp(RECORDING_READINESS_JS, { timeout: 1000 }) as RecordingReadiness;
            if (readiness?.ready) break;
          } catch (err) {
            injectError = err instanceof Error ? err.message : String(err);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!readiness?.ready) {
          await ctx.evalInApp(CLEANUP_RECORDING_JS, { timeout: 1000 }).catch(() => {});
          const reason = readiness?.traversal?.truncationReason
            ?? (readiness?.unwrapped?.length
              ? `unwrapped handlers: ${[...new Set(readiness.unwrapped)].join(', ')}`
              : injectError);
          return `Could not start recording — React handler coverage did not become ready within 6000ms (${reason}). Instrumentation was cleaned up.`;
        }

        const activated = await ctx.evalInApp(ACTIVATE_RECORDING_JS, { timeout: 1000 }).catch(() => false);
        if (!activated) {
          await ctx.evalInApp(CLEANUP_RECORDING_JS, { timeout: 1000 }).catch(() => {});
          return 'Could not start recording — capture activation failed. Instrumentation was cleaned up.';
        }

        const route = await ctx.evalInApp(CURRENT_ROUTE_JS, { timeout: 3000 }).catch(() => null) as string | null;
        const routeInfo = route ? ` on screen "${route}"` : '';
        return (
          `Recording started${routeInfo}. ` +
          `Interact with the app manually or ask me to navigate it for you. ` +
          `Call stop_test_recording when done.`
        );
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // stop_test_recording
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('stop_test_recording', {
      description:
        'Stop the active recording, retrieve all captured events, and store them for test generation. ' +
        'Returns a summary of what was recorded. ' +
        'Call generate_test_from_recording next to produce Appium, Maestro, or Detox test code.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      parameters: z.object({}),
      handler: async () => {
        // Cleanup injection
        await ctx.evalInApp(
          `(function(){
            if (globalThis.__METRO_MCP_REC_CLEANUP__) {
              globalThis.__METRO_MCP_REC_CLEANUP__();
              delete globalThis.__METRO_MCP_REC_CLEANUP__;
            }
          })()`,
          { timeout: 3000 }
        ).catch(() => {});

        // Retrieve events
        const raw = await ctx.evalInApp(
          `(globalThis.__METRO_MCP_REC_EVENTS__ || [])`,
          { timeout: 3000 }
        ).catch(() => []) as RecordedEvent[];

        if (!Array.isArray(raw) || raw.length === 0) {
          return 'No interactions were recorded. Make sure start_test_recording was called and the app was interacted with.';
        }

        storedEvents = deduplicateEvents(raw);

        const counts: Record<string, number> = {};
        for (const ev of storedEvents) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
        const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}${v !== 1 ? 's' : ''}`).join(', ');
        return `Recording complete. Captured ${storedEvents.length} events: ${summary}. Call generate_test_from_recording to produce test code.`;
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // generate_test_from_recording
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('generate_test_from_recording', {
      description:
        'Convert the most recent recording into a test file. ' +
        'Supports three formats: appium (WebdriverIO + Jest), maestro (YAML), and detox (Jest). ' +
        'Call stop_test_recording first.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        format: z.enum(['appium', 'maestro', 'detox']).describe('Output format'),
        testName: z.string().optional().describe('Name for the test / describe block'),
        platform: z.enum(['ios', 'android', 'both']).default('ios').describe('Target platform (appium only)'),
        bundleId: z.string().optional().describe('iOS bundle ID or Android app package'),
        includeSetup: z.boolean().default(true).describe('Include driver setup / teardown boilerplate'),
      }),
      handler: async ({ format, testName, platform, bundleId, includeSetup }) => {
        if (!storedEvents || storedEvents.length === 0) {
          return 'No recording found. Call start_test_recording, interact with the app, then stop_test_recording first.';
        }

        const name = testName ?? 'Recorded flow';
        const events = storedEvents;

        // Helper: first usable selector from the next events (for navigate assertions)
        function nextSelector(fromIdx: number, selectorFn: (e: RecordedEvent) => string | null): string | null {
          for (let j = fromIdx + 1; j < events.length; j++) {
            const sel = selectorFn(events[j]);
            if (sel) return sel;
            if (events[j].type === 'navigate') break; // stop at next nav boundary
          }
          return null;
        }

        if (format === 'maestro') return generateMaestro(name, events, bundleId, nextSelector);
        if (format === 'detox')   return generateDetox(name, events, includeSetup, nextSelector);
        return generateAppium(name, events, platform, bundleId, includeSetup, nextSelector);
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // generate_wdio_config
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('generate_wdio_config', {
      description:
        'Generate a minimal but runnable wdio.conf.ts for Appium + React Native testing, along with the npm install command.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'both']).default('ios'),
        bundleId: z.string().optional().describe('iOS bundle ID or Android app package'),
        appPath: z.string().optional().describe('Path to .app / .apk (leave empty to use a running simulator)'),
        outputPath: z.string().default('./wdio.conf.ts').describe('Shown in the output, not written to disk'),
      }),
      handler: async ({ platform, bundleId, appPath, outputPath }) => {
        const lines: string[] = [];

        const buildCaps = (p: 'ios' | 'android'): string[] => {
          const cap: string[] = [];
          cap.push(`      {`);
          if (p === 'ios') {
            cap.push(`        platformName: 'iOS',`);
            cap.push(`        'appium:automationName': 'XCUITest',`);
            cap.push(`        'appium:deviceName': 'iPhone 16',`);
            cap.push(`        'appium:platformVersion': '18.0',`);
            cap.push(appPath
              ? `        'appium:app': '${appPath}',`
              : (bundleId ? `        'appium:bundleId': '${bundleId}',` : `        'appium:bundleId': 'com.example.app',`));
          } else {
            cap.push(`        platformName: 'Android',`);
            cap.push(`        'appium:automationName': 'UiAutomator2',`);
            cap.push(`        'appium:deviceName': 'emulator-5554',`);
            if (appPath) {
              cap.push(`        'appium:app': '${appPath}',`);
            } else {
              cap.push(bundleId ? `        'appium:appPackage': '${bundleId}',` : `        'appium:appPackage': 'com.example.app',`);
              cap.push(`        'appium:appActivity': '.MainActivity',`);
            }
          }
          cap.push(`        'appium:newCommandTimeout': 240,`);
          cap.push(`      },`);
          return cap;
        };

        lines.push(`// ${outputPath}`);
        lines.push(`// Install deps: npm install --save-dev @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter appium wdio-appium-service`);
        lines.push(`import type { Options } from '@wdio/types';`);
        lines.push('');
        lines.push(`export const config: Options.Testrunner = {`);
        lines.push(`  runner: 'local',`);
        lines.push(`  autoCompileOpts: { autoCompile: true, tsNodeOpts: { project: './tsconfig.json' } },`);
        lines.push('');
        lines.push(`  port: 4723,`);
        lines.push(`  services: ['appium'],`);
        lines.push(`  appium: { command: 'appium' },`);
        lines.push('');
        lines.push(`  specs: ['./e2e/**/*.test.ts'],`);
        lines.push(`  exclude: [],`);
        lines.push('');
        lines.push(`  capabilities: [`);
        if (platform === 'both') {
          lines.push(...buildCaps('ios'));
          lines.push(...buildCaps('android'));
        } else {
          lines.push(...buildCaps(platform));
        }
        lines.push(`  ],`);
        lines.push('');
        lines.push(`  framework: 'mocha',`);
        lines.push(`  mochaOpts: { ui: 'bdd', timeout: 60000 },`);
        lines.push('');
        lines.push(`  reporters: ['spec'],`);
        lines.push('');
        lines.push(`  bail: 0,`);
        lines.push(`  waitforTimeout: 10000,`);
        lines.push(`  connectionRetryTimeout: 120000,`);
        lines.push(`  connectionRetryCount: 3,`);
        lines.push(`};`);
        lines.push('');
        lines.push(`/*`);
        lines.push(` * Run a single test:  npx wdio run ${outputPath} --spec ./e2e/login.test.ts`);
        lines.push(` * Run all tests:      npx wdio run ${outputPath}`);
        lines.push(` *`);
        lines.push(` * Install Appium:     npm install -g appium`);
        lines.push(` *                     appium driver install xcuitest`);
        lines.push(` *                     appium driver install uiautomator2`);
        lines.push(` */`);

        return lines.join('\n');
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // add_recording_annotation
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('add_recording_annotation', {
      description:
        'Add a human-readable annotation (comment marker) to the current recording. ' +
        'Useful for labelling major flow checkpoints like "reached checkout", "error appeared here", ' +
        '"navigated to payment". Annotations appear as code comments in generated tests.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        note: z.string().describe('Annotation text to embed in the recording'),
      }),
      handler: async ({ note }) => {
        const ADD_ANNOTATION_JS = `(function() {
          if (!globalThis.__METRO_MCP_REC_ACTIVE__) return false;
          var nav = globalThis.__METRO_MCP_NAV_REF__;
          var route = null;
          try { if (nav && nav.getCurrentRoute) { var r = nav.getCurrentRoute(); route = r ? r.name : null; } } catch(e) {}
          globalThis.__METRO_MCP_REC_EVENTS__.push({ type: 'annotation', note: ${JSON.stringify(note)}, route: route, timestamp: Date.now() });
          return true;
        })()`;
        const ok = await ctx.evalInApp(ADD_ANNOTATION_JS);
        if (!ok) return 'No active recording. Call start_test_recording first.';
        return `Annotation added: "${note}"`;
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // save_test_recording
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('save_test_recording', {
      description:
        'Save the current recording events to disk as JSON so they can be reloaded later. ' +
        'Useful for regenerating the same flow in a different test format without re-recording. ' +
        'Files are saved to ~/.metro-mcp/recordings/<filename>.json.',
      annotations: { destructiveHint: false, idempotentHint: true },
      parameters: z.object({
        filename: z.string().describe('Name for the saved recording (without .json extension)'),
      }),
      handler: async ({ filename }) => {
        const events = storedEvents;
        if (!events || events.length === 0) {
          return 'No recording to save. Call stop_test_recording first.';
        }
        const safe = filename.replace(/[^a-zA-Z0-9_-]/g, '_');
        await mkdir(RECORDINGS_DIR, { recursive: true });
        const filePath = join(RECORDINGS_DIR, `${safe}.json`);
        await writeFile(filePath, JSON.stringify({ savedAt: new Date().toISOString(), events }, null, 2), 'utf8');
        return { saved: filePath, eventCount: events.length };
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // load_test_recording
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('load_test_recording', {
      description:
        'Load a previously saved recording from disk and make it available for test generation. ' +
        'After loading, call generate_test_from_recording with any format to regenerate the test. ' +
        'Use list_test_recordings to see available files.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        filename: z.string().describe('Name of the saved recording (without .json extension)'),
      }),
      handler: async ({ filename }) => {
        const safe = filename.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = join(RECORDINGS_DIR, `${safe}.json`);
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          return `Recording not found: ${filePath}. Call list_test_recordings to see available files.`;
        }
        const parsed = JSON.parse(raw) as { savedAt?: string; events: RecordedEvent[] };
        storedEvents = parsed.events;
        return {
          loaded: filePath,
          savedAt: parsed.savedAt ?? 'unknown',
          eventCount: storedEvents.length,
          eventTypes: storedEvents.reduce<Record<string, number>>((acc, e) => {
            acc[e.type] = (acc[e.type] ?? 0) + 1;
            return acc;
          }, {}),
        };
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // list_test_recordings
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerTool('list_test_recordings', {
      description:
        'List all previously saved test recordings in ~/.metro-mcp/recordings/. ' +
        'Returns filenames and sizes. Use load_test_recording to load one for test generation.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        let entries: { name: string }[];
        try {
          const files = await readdir(RECORDINGS_DIR);
          entries = files
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ name: f.replace(/\.json$/, '') }));
        } catch {
          return 'No recordings found. Use save_test_recording after recording a flow.';
        }
        if (entries.length === 0) return 'No recordings found.';
        return entries;
      },
    });

    // ────────────────────────────────────────────────────────────────────────────
    // metro://recording/status resource
    // ────────────────────────────────────────────────────────────────────────────
    ctx.registerResource('metro://recording/status', {
      name: 'Recording Status',
      description: 'Live test recording state: whether a recording is active and how many events have been captured',
      handler: async () => {
        let isRecording = false;
        let eventCount = 0;
        let lastEventType: string | null = null;
        let lastEventTime: number | null = null;
        try {
          const status = (await ctx.evalInApp(`(function() {
            return {
              active: !!globalThis.__METRO_MCP_REC_ACTIVE__,
              count: (globalThis.__METRO_MCP_REC_EVENTS__ || []).length,
              last: (globalThis.__METRO_MCP_REC_EVENTS__ || []).slice(-1)[0] || null
            };
          })()`)) as { active: boolean; count: number; last: RecordedEvent | null } | null;
          if (status) {
            isRecording = status.active;
            eventCount = status.count;
            lastEventType = status.last?.type ?? null;
            lastEventTime = status.last?.timestamp ?? null;
          }
        } catch {
          // not connected
        }
        return JSON.stringify({ isRecording, eventCount, lastEventType, lastEventTime, storedEventCount: storedEvents?.length ?? 0 }, null, 2);
      },
    });
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// Code generators
// ────────────────────────────────────────────────────────────────────────────────

function generateAppium(
  name: string,
  events: RecordedEvent[],
  platform: 'ios' | 'android' | 'both',
  bundleId: string | undefined,
  includeSetup: boolean,
  nextSelector: (i: number, fn: (e: RecordedEvent) => string | null) => string | null,
): string {
  const lines: string[] = [];
  lines.push(`import { remote, Browser } from 'webdriverio';`);
  lines.push('');

  if (includeSetup) {
    if (platform === 'both') {
      lines.push(`const IOS_CAPS = {`);
      pushCaps(lines, 'ios', bundleId, '  ');
      lines.push(`};`);
      lines.push('');
      lines.push(`const ANDROID_CAPS = {`);
      pushCaps(lines, 'android', bundleId, '  ');
      lines.push(`};`);
      lines.push('');
    }
  }

  lines.push(`describe(${JSON.stringify(name)}, () => {`);

  if (includeSetup) {
    lines.push(`  let driver: Browser;`);
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    if (platform === 'both') {
      lines.push(`    // Run with IOS_CAPS or ANDROID_CAPS depending on target`);
      lines.push(`    driver = await remote({ capabilities: IOS_CAPS });`);
    } else {
      lines.push(`    driver = await remote({`);
      lines.push(`      capabilities: {`);
      pushCaps(lines, platform, bundleId, '        ');
      lines.push(`      },`);
      lines.push(`    });`);
    }
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await driver.deleteSession();`);
    lines.push(`  });`);
    lines.push('');
  }

  lines.push(`  it(${JSON.stringify(name)}, async () => {`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const sel = appiumSelector(ev);

    switch (ev.type) {
      case 'tap':
        lines.push(sel
          ? `    await driver.$(${JSON.stringify(sel)}).click();`
          : `    // TODO: tap ${ev.componentName ?? 'unknown element'}`);
        break;

      case 'long_press':
        lines.push(sel
          ? `    await driver.$(${JSON.stringify(sel)}).longClick();`
          : `    // TODO: long press ${ev.componentName ?? 'unknown element'}`);
        break;

      case 'type': {
        const inputSel = sel ?? '~TODO';
        lines.push(`    await driver.$(${JSON.stringify(inputSel)}).setValue(${JSON.stringify(ev.text ?? '')});`);
        break;
      }

      case 'submit':
        lines.push(`    await driver.keys(['Enter']);`);
        break;

      case 'swipe':
        lines.push(...appiumSwipeLines(ev.direction ?? 'up', '    '));
        break;

      case 'navigate': {
        const assertSel = nextSelector(i, appiumSelector);
        lines.push(`    // navigated to: ${ev.route ?? 'new screen'}`);
        lines.push(assertSel
          ? `    await driver.$(${JSON.stringify(assertSel)}).waitForDisplayed({ timeout: 5000 });`
          : `    // TODO: assert screen loaded`);
        break;
      }

      case 'annotation':
        lines.push(`    // ${ev.note ?? ''}`);
        break;
    }
  }

  lines.push(`  });`);
  lines.push(`});`);
  lines.push('');
  lines.push(`/*`);
  lines.push(` * Run with: npx wdio run wdio.conf.ts`);
  lines.push(` * Docs: https://webdriver.io/docs/gettingstarted`);
  lines.push(` * Selectors: https://webdriver.io/docs/selectors#accessibility-id`);
  lines.push(` */`);

  return lines.join('\n');
}

function generateMaestro(
  name: string,
  events: RecordedEvent[],
  appId: string | undefined,
  nextSelector: (i: number, fn: (e: RecordedEvent) => string | null) => string | null,
): string {
  const lines: string[] = [];
  if (appId) lines.push(`appId: ${appId}`);
  lines.push('---');
  lines.push(`# ${name}`);
  lines.push('');

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const sel = maestroSelector(ev);

    switch (ev.type) {
      case 'tap':
        if (sel) {
          lines.push(`- tapOn:`);
          lines.push(`    ${sel}`);
        } else {
          lines.push(`# TODO: tap ${ev.componentName ?? 'unknown element'}`);
        }
        break;

      case 'long_press':
        if (sel) {
          lines.push(`- longPressOn:`);
          lines.push(`    ${sel}`);
        } else {
          lines.push(`# TODO: long press ${ev.componentName ?? 'unknown element'}`);
        }
        break;

      case 'type':
        if (sel) {
          lines.push(`- tapOn:`);
          lines.push(`    ${sel}`);
        }
        lines.push(`- inputText: ${JSON.stringify(ev.text ?? '')}`);
        break;

      case 'submit':
        lines.push(`- pressKey: Enter`);
        break;

      case 'swipe': {
        const dir = ev.direction ?? 'up';
        const dirCap = dir.charAt(0).toUpperCase() + dir.slice(1);
        lines.push(`- swipe${dirCap}`);
        break;
      }

      case 'navigate': {
        const assertSel = nextSelector(i, maestroSelector);
        lines.push(`# navigated to: ${ev.route ?? 'new screen'}`);
        if (assertSel) {
          lines.push(`- assertVisible:`);
          lines.push(`    ${assertSel}`);
        } else {
          lines.push(`# TODO: assert screen loaded`);
        }
        break;
      }

      case 'annotation':
        lines.push(`# ${ev.note ?? ''}`);
        break;
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateDetox(
  name: string,
  events: RecordedEvent[],
  includeSetup: boolean,
  nextSelector: (i: number, fn: (e: RecordedEvent) => string | null) => string | null,
): string {
  const lines: string[] = [];

  if (includeSetup) {
    lines.push(`const { device, element, by, expect } = require('detox');`);
    lines.push('');
  }

  lines.push(`describe(${JSON.stringify(name)}, () => {`);

  if (includeSetup) {
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    await device.launchApp();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await device.terminateApp();`);
    lines.push(`  });`);
    lines.push('');
  }

  lines.push(`  it(${JSON.stringify(name)}, async () => {`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const sel = detoxSelector(ev);

    switch (ev.type) {
      case 'tap':
        lines.push(sel
          ? `    await element(${sel}).tap();`
          : `    // TODO: tap ${ev.componentName ?? 'unknown element'}`);
        break;

      case 'long_press':
        lines.push(sel
          ? `    await element(${sel}).longPress();`
          : `    // TODO: long press ${ev.componentName ?? 'unknown element'}`);
        break;

      case 'type':
        lines.push(sel
          ? `    await element(${sel}).typeText(${JSON.stringify(ev.text ?? '')});`
          : `    // TODO: type ${JSON.stringify(ev.text ?? '')} into unknown element`);
        break;

      case 'submit':
        lines.push(sel
          ? `    await element(${sel}).tapReturnKey();`
          : `    // TODO: tap return key on unknown element`);
        break;

      case 'swipe': {
        const dir = ev.direction ?? 'up';
        const scrollSel = sel ?? `by.type('RCTScrollView')`;
        lines.push(`    await element(${scrollSel}).scroll(300, ${JSON.stringify(dir)});`);
        break;
      }

      case 'navigate': {
        const assertSel = nextSelector(i, detoxSelector);
        lines.push(`    // navigated to: ${ev.route ?? 'new screen'}`);
        lines.push(assertSel
          ? `    await expect(element(${assertSel})).toBeVisible();`
          : `    // TODO: assert screen loaded`);
        break;
      }

      case 'annotation':
        lines.push(`    // ${ev.note ?? ''}`);
        break;
    }
  }

  lines.push(`  });`);
  lines.push(`});`);
  lines.push('');
  lines.push(`/*`);
  lines.push(` * Run with: npx detox test`);
  lines.push(` * Docs: https://wix.github.io/Detox/docs/introduction/getting-started`);
  lines.push(` */`);

  return lines.join('\n');
}
