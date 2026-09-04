import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { definePlugin } from '../plugin.js';
import { getConnectedDeviceTarget } from '../utils/device-discovery.js';
import {
  FIBER_WALKER_JS,
  GET_ROUTE_FUNC_JS,
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
const RECORDING_HANDLERS = [
  'onPress', 'onLongPress', 'onChangeText', 'onSubmitEditing',
  'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd',
];
const SCROLLABLE_PROPS_JS = `
  function isScrollable(props) {
    return 'scrollEventThrottle' in props || 'extraScrollHeight' in props ||
      'showsVerticalScrollIndicator' in props || 'showsHorizontalScrollIndicator' in props ||
      'keyboardShouldPersistTaps' in props || 'keyboardDismissMode' in props ||
      'scrollEnabled' in props || typeof props.onScrollBeginDrag === 'function' ||
      typeof props.onScrollEndDrag === 'function' ||
      typeof props.onMomentumScrollEnd === 'function';
  }
`;

const RECORDER_METADATA_JS = `
  function hasMetadata(fn, tid, lbl, kind) {
    var metadata = fn && fn.__mcpRecMetadata;
    return typeof fn === 'function' && fn.__mcpRecSession === state.sessionId &&
      metadata && metadata.testID === tid && metadata.label === lbl && metadata.kind === kind;
  }
`;

const START_RECORDING_JS = (sessionId: string, epoch: string, attemptOrder: number) => `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return false;

  // Concurrent starts can be evaluated out of order. Once a later attempt
  // from this server instance has installed a recorder, an older attempt must
  // leave it intact rather than cleaning it up and taking ownership back.
  var currentState = globalThis.__METRO_MCP_REC_STATE__;
  if (currentState && currentState.epoch === ${JSON.stringify(epoch)} &&
      Number(currentState.attemptOrder) > ${attemptOrder}) {
    return { __mcpRecorderSession: ${JSON.stringify(RECORDER_SESSION_REPLACED)} };
  }

  // A previous session may have been interrupted by a disconnected CDP
  // session. Clean it up when it is still the current installation.
  if (typeof globalThis.__METRO_MCP_REC_CLEANUP__ === 'function') {
    try { globalThis.__METRO_MCP_REC_CLEANUP__(); } catch (_) {}
  }

  var state = {
    sessionId: ${JSON.stringify(sessionId)},
    epoch: ${JSON.stringify(epoch)},
    attemptOrder: ${attemptOrder},
    capture: false,
    active: true,
    ready: false,
    invocationDepth: 0,
    events: []
  };
  globalThis.__METRO_MCP_REC_STATE__ = state;
  globalThis.__METRO_MCP_REC_EVENTS__ = state.events;

  ${GET_ROUTE_FUNC_JS}

  var HANDLERS = ${JSON.stringify(RECORDING_HANDLERS)};

  function isWrapped(fn) {
    return typeof fn === 'function' && fn.__mcpRecSession === state.sessionId;
  }

  ${RECORDER_METADATA_JS}

  function record(event) {
    if (state.capture && globalThis.__METRO_MCP_REC_STATE__ === state)
      state.events.push(event);
  }

  function invokeOriginal(original, receiver, args, makeEvent) {
    var outermost = state.invocationDepth === 0;
    state.invocationDepth++;
    try {
      if (outermost && state.capture && globalThis.__METRO_MCP_REC_STATE__ === state) {
        try { record(makeEvent(args)); } catch (_) {}
      }
      return original.apply(receiver, args);
    } finally {
      state.invocationDepth--;
    }
  }

  function wrap(obj, name, tid, lbl, makeEvent) {
    var original = obj[name];
    if (typeof original !== 'function' || hasMetadata(original, tid, lbl, name)) return false;
    var wrapped = function() {
      return invokeOriginal(original, this, arguments, makeEvent);
    };
    try {
      Object.defineProperty(wrapped, '__mcpRecSession', { value: state.sessionId });
      Object.defineProperty(wrapped, '__mcpRecOriginal', { value: original });
      Object.defineProperty(wrapped, '__mcpRecMetadata', { value: { testID: tid, label: lbl, kind: name } });
      obj[name] = wrapped;
      return obj[name] === wrapped;
    } catch (_) {
      return false;
    }
  }

  ${SCROLLABLE_PROPS_JS}

  function wrapProps(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var tid = obj.testID || null;
    var lbl = obj.accessibilityLabel || obj['aria-label'] || null;
    var wrapped = false;
    wrapped = wrap(obj, 'onPress', tid, lbl, function() {
      return { type: 'tap', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onLongPress', tid, lbl, function() {
      return { type: 'long_press', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onChangeText', tid, lbl, function(args) {
      return { type: 'type', testID: tid, label: lbl, text: args[0], route: getRoute(), timestamp: Date.now() };
    }) || wrapped;
    wrapped = wrap(obj, 'onSubmitEditing', tid, lbl, function() {
      return { type: 'submit', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() };
    }) || wrapped;

    if (isScrollable(obj)) {
      var originalBegin = obj.onScrollBeginDrag;
      var originalEnd = obj.onScrollEndDrag;
      var originalMomentumEnd = obj.onMomentumScrollEnd;
      // A forwarded scroll callback can already belong to a previous props
      // object. Keep mutable gesture state with every wrapper so any existing
      // begin, end, or momentum callback can share it with newly created peers.
      function existingScrollState(fn) {
        return fn && fn.__mcpRecSession === state.sessionId && fn.__mcpRecScrollState;
      }
      var scrollStates = [];
      var existingStates = [originalBegin, originalEnd, originalMomentumEnd];
      for (var stateIndex = 0; stateIndex < existingStates.length; stateIndex++) {
        var existingState = existingScrollState(existingStates[stateIndex]);
        if (existingState && scrollStates.indexOf(existingState) < 0) scrollStates.push(existingState);
      }
      var scrollStateConflict = scrollStates.length > 1;
      var scrollStart = scrollStates[0] || { x: null, y: null };
      function unwrapScrollHandler(fn) {
        var seen = new Set();
        while (fn && fn.__mcpRecSession === state.sessionId && fn.__mcpRecOriginal && !seen.has(fn)) {
          seen.add(fn);
          fn = fn.__mcpRecOriginal;
        }
        return fn;
      }
      if (scrollStateConflict) {
        // Forwarded props can combine callbacks from separate renders. Rebuild
        // the complete callback set around one state so begin/end cannot split
        // a gesture between independent recorder sessions.
        originalBegin = unwrapScrollHandler(originalBegin);
        originalEnd = unwrapScrollHandler(originalEnd);
        originalMomentumEnd = unwrapScrollHandler(originalMomentumEnd);
      }
      function tagScrollWrapper(fn, kind, original) {
        Object.defineProperty(fn, '__mcpRecSession', { value: state.sessionId });
        Object.defineProperty(fn, '__mcpRecOriginal', { value: original });
        Object.defineProperty(fn, '__mcpRecMetadata', { value: { testID: tid, label: lbl, kind: kind } });
        Object.defineProperty(fn, '__mcpRecScrollState', { value: scrollStart });
      }
      if (scrollStateConflict || !hasMetadata(originalBegin, tid, lbl, 'onScrollBeginDrag')) {
        var begin = function(e) {
          var outermost = state.invocationDepth === 0;
          state.invocationDepth++;
          try {
            if (outermost) {
              try {
                scrollStart.x = e.nativeEvent.contentOffset.x;
                scrollStart.y = e.nativeEvent.contentOffset.y;
              } catch (_) { scrollStart.x = scrollStart.y = null; }
            }
            return originalBegin ? originalBegin.apply(this, arguments) : undefined;
          } finally { state.invocationDepth--; }
        };
        try {
          tagScrollWrapper(begin, 'onScrollBeginDrag', originalBegin);
          obj.onScrollBeginDrag = begin;
          wrapped = obj.onScrollBeginDrag === begin || wrapped;
        } catch (_) {}
      }
      function emitSwipe(e) {
        if (state.invocationDepth !== 1 || scrollStart.x === null || !state.capture || globalThis.__METRO_MCP_REC_STATE__ !== state) return;
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
      if (scrollStateConflict || !hasMetadata(originalEnd, tid, lbl, 'onScrollEndDrag')) {
        var end = function(e) {
          state.invocationDepth++;
          try { emitSwipe(e); return originalEnd ? originalEnd.apply(this, arguments) : undefined; }
          finally { state.invocationDepth--; }
        };
        try {
          tagScrollWrapper(end, 'onScrollEndDrag', originalEnd);
          obj.onScrollEndDrag = end;
          wrapped = obj.onScrollEndDrag === end || wrapped;
        } catch (_) {}
      }
      if (scrollStateConflict || !hasMetadata(originalMomentumEnd, tid, lbl, 'onMomentumScrollEnd')) {
        var momentum = function(e) {
          state.invocationDepth++;
          try { emitSwipe(e); return originalMomentumEnd ? originalMomentumEnd.apply(this, arguments) : undefined; }
          finally { state.invocationDepth--; }
        };
        try {
          tagScrollWrapper(momentum, 'onMomentumScrollEnd', originalMomentumEnd);
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
      var seen = new Set();
      while (predecessor) {
        if (seen.has(predecessor) || seen.size >= 1000) { predecessor = undefined; break; }
        seen.add(predecessor);
        if (predecessor.__mcpRecState && !predecessor.__mcpRecState.active)
          predecessor = predecessor.__mcpRecPrevious;
        else if (predecessor.__mcpProfilerState && !predecessor.__mcpProfilerState.active)
          predecessor = predecessor.__mcpProfilerPrevious;
        else break;
      }
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

  // Already-mounted memoizedProps are usually frozen. Ask React to render
  // those fibers again so Object.freeze sees fresh mutable props. The shared
  // bounded walker keeps this initialization finite even for pathological
  // component trees.
  ${FIBER_WALKER_JS}
  // An explicit empty navigation state disables pruning: every mounted
  // scene must be instrumented before it can later become focused.
  metroWalkFibers({ maxDepth: 600, maxNodes: 5000 }, function(fiber) {
    var props = fiber && fiber.memoizedProps;
    if (!props || typeof props !== 'object') return;
    var needsRefresh = false;
    for (var i = 0; i < HANDLERS.length; i++) {
      if (typeof props[HANDLERS[i]] === 'function' && !hasMetadata(props[HANDLERS[i]], props.testID || null, props.accessibilityLabel || props['aria-label'] || null, HANDLERS[i])) {
        needsRefresh = true;
        break;
      }
    }
    if (isScrollable(props)) {
      var scrollNames = ['onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'];
      var scrollStates = [];
      for (var scrollIndex = 0; scrollIndex < scrollNames.length; scrollIndex++) {
        var scrollHandler = props[scrollNames[scrollIndex]];
        if (scrollHandler && scrollHandler.__mcpRecScrollState &&
            scrollStates.indexOf(scrollHandler.__mcpRecScrollState) < 0) {
          scrollStates.push(scrollHandler.__mcpRecScrollState);
        }
        if (!isWrapped(scrollHandler)) { needsRefresh = true; break; }
      }
      if (scrollStates.length > 1) needsRefresh = true;
    }
    if (!needsRefresh) return;
    var context = arguments[1] || {};
    var renderer = context.renderer || null;
    var refreshFiber = fiber;
    var visitedAncestors = new Set();
    while (refreshFiber && (!refreshFiber.stateNode || typeof refreshFiber.stateNode.forceUpdate !== 'function')) {
      if (visitedAncestors.has(refreshFiber) || visitedAncestors.size >= 600) { refreshFiber = null; break; }
      visitedAncestors.add(refreshFiber);
      refreshFiber = refreshFiber.return;
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
    if (refreshFiber && refreshFiber.stateNode && typeof refreshFiber.stateNode.forceUpdate === 'function') {
      try { refreshFiber.stateNode.forceUpdate(); } catch (_) {}
    }
  }, { routes: [] });

  return state.sessionId;
})()
`;

const RECORDING_READINESS_JS = buildFiberReadExpression(`
  var state = globalThis.__METRO_MCP_REC_STATE__;
  if (!state) return { ready: false, error: 'no-session' };
  ${RECORDER_METADATA_JS}
  var handlers = ${JSON.stringify(RECORDING_HANDLERS)};
  var handlerCount = 0;
  var unwrapped = [];
  ${SCROLLABLE_PROPS_JS}
  var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber) {
    var props = fiber && fiber.memoizedProps;
    if (!props || typeof props !== 'object') return;
    for (var index = 0; index < handlers.length; index++) {
      var name = handlers[index];
      if (typeof props[name] !== 'function') continue;
      handlerCount++;
      var propTestID = props.testID || null;
      var propLabel = props.accessibilityLabel || props['aria-label'] || null;
      if (!hasMetadata(props[name], propTestID, propLabel, name))
        unwrapped.push(name);
    }
    if (isScrollable(props)) {
      var scrollHandlers = ['onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'];
      var scrollStates = [];
      for (var scrollIndex = 0; scrollIndex < scrollHandlers.length; scrollIndex++) {
        var scrollName = scrollHandlers[scrollIndex];
        var scrollTestID = props.testID || null;
        var scrollLabel = props.accessibilityLabel || props['aria-label'] || null;
        var scrollHandler = props[scrollName];
        if (typeof scrollHandler === 'function' && scrollHandler.__mcpRecScrollState &&
            scrollStates.indexOf(scrollHandler.__mcpRecScrollState) < 0) {
          scrollStates.push(scrollHandler.__mcpRecScrollState);
        }
        if (typeof scrollHandler !== 'function' || !hasMetadata(scrollHandler, scrollTestID, scrollLabel, scrollName))
          unwrapped.push(scrollName);
      }
      if (scrollStates.length > 1) unwrapped.push('scroll-state-conflict');
    }
  }, { routes: [] });
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

const RECORDER_SESSION_REPLACED = '__mcp_recorder_session_replaced__';

function sessionGuardedExpression(expression: string, sessionId: string): string {
  return `(function() {
    var state = globalThis.__METRO_MCP_REC_STATE__;
    if (!state || state.sessionId !== ${JSON.stringify(sessionId)})
      return { __mcpRecorderSession: ${JSON.stringify(RECORDER_SESSION_REPLACED)} };
    return (${expression});
  })()`;
}

function sessionCleanupExpression(sessionId: string): string {
  return `(function() {
    var state = globalThis.__METRO_MCP_REC_STATE__;
    if (!state || state.sessionId !== ${JSON.stringify(sessionId)}) return false;
    return ${CLEANUP_RECORDING_JS};
  })()`;
}

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
//
// Capabilities belong to the generated WDIO configuration. The generated spec
// deliberately consumes the runner-owned `browser` session instead of opening
// a second WebDriver connection.
function pushCaps(
  lines: string[],
  platform: 'ios' | 'android',
  options: {
    bundleId?: string;
    appPath?: string;
    udid?: string;
    deviceName?: string;
    platformVersion?: string;
    noReset: boolean;
  },
  indent: string,
): void {
  const push = (key: string, value: string | boolean) => lines.push(`${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  push('platformName', platform === 'ios' ? 'iOS' : 'Android');
  push('appium:automationName', platform === 'ios' ? 'XCUITest' : 'UiAutomator2');
  push('appium:noReset', options.noReset);
  if (options.udid) push('appium:udid', options.udid);
  if (options.deviceName) push('appium:deviceName', options.deviceName);
  if (options.platformVersion) push('appium:platformVersion', options.platformVersion);
  if (options.appPath) {
    push('appium:app', options.appPath);
  } else if (options.bundleId) {
    push(platform === 'ios' ? 'appium:bundleId' : 'appium:appPackage', options.bundleId);
    if (platform === 'android') push('appium:appActivity', '.MainActivity');
  }
}

// ── WebdriverIO W3C actions used by generated specs
function appiumActionHelpers(lines: string[]): void {
  lines.push(`type TouchAction = {`);
  lines.push(`  type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause';`);
  lines.push(`  duration?: number; x?: number; y?: number; button?: number;`);
  lines.push(`};`);
  lines.push('');
  lines.push(`async function performTouch(actions: TouchAction[]): Promise<void> {`);
  lines.push(`  try {`);
  lines.push(`    await browser.performActions([{`);
  lines.push(`      type: 'pointer',`);
  lines.push(`      id: 'metro-mcp-touch',`);
  lines.push(`      parameters: { pointerType: 'touch' },`);
  lines.push(`      actions,`);
  lines.push(`    }]);`);
  lines.push(`  } finally {`);
  lines.push(`    await browser.releaseActions();`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');
  lines.push(`async function longPress(selector: string): Promise<void> {`);
  lines.push(`  const element = await browser.$(selector);`);
  lines.push(`  const location = await element.getLocation();`);
  lines.push(`  const size = await element.getSize();`);
  lines.push(`  const x = Math.round(location.x + size.width / 2);`);
  lines.push(`  const y = Math.round(location.y + size.height / 2);`);
  lines.push(`  await performTouch([`);
  lines.push(`    { type: 'pointerMove', duration: 0, x, y },`);
  lines.push(`    { type: 'pointerDown', button: 0 },`);
  lines.push(`    { type: 'pause', duration: 800 },`);
  lines.push(`    { type: 'pointerUp', button: 0 },`);
  lines.push(`  ]);`);
  lines.push(`}`);
  lines.push('');
  lines.push(`async function swipe(direction: string): Promise<void> {`);
  lines.push(`  const { width, height } = await browser.getWindowSize();`);
  lines.push(`  const cx = Math.round(width / 2);`);
  lines.push(`  const cy = Math.round(height / 2);`);
  lines.push(`  const distanceX = Math.round(width * 0.35);`);
  lines.push(`  const distanceY = Math.round(height * 0.35);`);
  lines.push(`  let from = { x: cx, y: cy };`);
  lines.push(`  let to = { x: cx, y: cy - distanceY };`);
  lines.push(`  if (direction === 'down') { from = { x: cx, y: cy - distanceY }; to = { x: cx, y: cy }; }`);
  lines.push(`  if (direction === 'left') { from = { x: cx + distanceX, y: cy }; to = { x: cx, y: cy }; }`);
  lines.push(`  if (direction === 'right') { from = { x: cx - distanceX, y: cy }; to = { x: cx, y: cy }; }`);
  lines.push(`  await performTouch([`);
  lines.push(`    { type: 'pointerMove', duration: 0, x: from.x, y: from.y },`);
  lines.push(`    { type: 'pointerDown', button: 0 },`);
  lines.push(`    { type: 'pointerMove', duration: 500, x: to.x, y: to.y },`);
  lines.push(`    { type: 'pointerUp', button: 0 },`);
  lines.push(`  ]);`);
  lines.push(`}`);
  lines.push('');
}

// ── Persistent state for the recording session
let storedEvents: RecordedEvent[] | null = null;

export const testRecorderPlugin = definePlugin({
  name: 'test-recorder',

  description: 'Unified mobile test recorder: captures taps, text entry, swipes and navigation via fiber patching; generates Appium, Maestro, and Detox tests',

  async setup(ctx) {
    const recorderEpoch = randomUUID();
    let recorderStartCounter = 0;

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
        const attemptOrder = ++recorderStartCounter;
        const attemptSessionId = `recording-${recorderEpoch}-${attemptOrder}`;

        // Keep injection, readiness, activation, and the final route lookup
        // inside one startup budget. EvalOptions.deadline also bounds any
        // reconnect wait in the shared app evaluator; per-request timeouts
        // must never reserve time beyond this deadline.
        const deadline = Date.now() + 6000;
        const evaluateStartup = async (expression: string, timeout: number, sessionId?: string) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('recording startup deadline exceeded');
          // A later concurrent startup may replace the app-side session while
          // this request is waiting for readiness. Guard every post-injection
          // expression so the older request cannot activate or inspect the
          // newer recorder.
          return ctx.evalInApp(sessionId ? sessionGuardedExpression(expression, sessionId) : expression, {
            timeout: Math.min(timeout, remaining),
            deadline,
          });
        };
        const cleanupBestEffort = async (sessionId: string) => {
          // Cleanup has its own short deadline so an exhausted readiness budget
          // cannot leave recorder hooks installed, while reconnects and the
          // cleanup transport are still bounded.
          const cleanupDeadline = Date.now() + 1000;
          await ctx.evalInApp(sessionCleanupExpression(sessionId), {
            timeout: 1000,
            deadline: cleanupDeadline,
          }).catch(() => {});
        };

        let injected: unknown;
        let injectError = 'script returned false (check __REACT_DEVTOOLS_GLOBAL_HOOK__ availability)';
        try {
          injected = await evaluateStartup(
            START_RECORDING_JS(attemptSessionId, recorderEpoch, attemptOrder),
            6000,
          );
        } catch (err) {
          injectError = err instanceof Error ? err.message : String(err);
          injected = false;
        }
        if (isRecorderSessionReplaced(injected)) {
          return 'Could not start recording — this recorder startup was replaced by a newer startup; the newer recorder remains active.';
        }
        if (!injected) {
          // CDP can report a transport error after the app evaluated part of
          // the script. Always attempt cleanup for a partially-installed
          // session before returning the failure.
          await cleanupBestEffort(attemptSessionId);
          return `Could not inject recording hooks — ${injectError}`;
        }

        const sessionId = typeof injected === 'string' ? injected : attemptSessionId;
        let sessionReplaced = false;

        // The injection only installs instrumentation. Wait for a complete
        // bounded scan after React has had a chance to refresh frozen props;
        // enabling capture before this point loses the first interaction or
        // silently misses a deep handler.
        let readiness: RecordingReadiness | null = null;
        while (Date.now() < deadline) {
          try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const readinessResult = await evaluateStartup(RECORDING_READINESS_JS, Math.min(1000, remaining), sessionId);
            if (isRecorderSessionReplaced(readinessResult)) {
              sessionReplaced = true;
              break;
            }
            readiness = readinessResult as RecordingReadiness;
            if (readiness?.ready) break;
          } catch (err) {
            injectError = err instanceof Error ? err.message : String(err);
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
        }
        if (sessionReplaced) {
          return 'Could not start recording — this recorder startup was replaced by a newer startup; the newer recorder remains active.';
        }
        if (!readiness?.ready) {
          await cleanupBestEffort(sessionId);
          const reason = readiness?.traversal?.truncationReason
            ?? (readiness?.unwrapped?.length
              ? `unwrapped handlers: ${[...new Set(readiness.unwrapped)].join(', ')}`
              : injectError);
          return `Could not start recording — React handler coverage did not become ready within 6000ms (${reason}). Instrumentation cleanup was attempted.`;
        }

        const activationResult = (deadline - Date.now() > 0
          ? await evaluateStartup(ACTIVATE_RECORDING_JS, 1000, sessionId).catch(() => false)
          : false);
        if (isRecorderSessionReplaced(activationResult)) {
          return 'Could not start recording — this recorder startup was replaced by a newer startup; the newer recorder remains active.';
        }
        const activated = activationResult === true;
        if (!activated) {
          await cleanupBestEffort(sessionId);
          return 'Could not start recording — capture activation failed. Instrumentation cleanup was attempted.';
        }

        const routeResult = (deadline - Date.now() > 0
          ? await evaluateStartup(CURRENT_ROUTE_JS, 3000, sessionId).catch(() => null)
          : null) as string | null;
        if (isRecorderSessionReplaced(routeResult)) {
          return 'Could not start recording — this recorder startup was replaced by a newer startup; the newer recorder remains active.';
        }
        const route = routeResult;
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
        await ctx.evalInApp(CLEANUP_RECORDING_JS, { timeout: 3000 }).catch(() => {});

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
        'Supports three formats: appium (WebdriverIO + Mocha), maestro (YAML), and detox (Jest). ' +
        'Call stop_test_recording first.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        format: z.enum(['appium', 'maestro', 'detox']).describe('Output format'),
        testName: z.string().optional().describe('Name for the test / describe block'),
        platform: z.enum(['ios', 'android', 'both']).default('ios').describe('Target platform (appium only)'),
        bundleId: z.string().optional().describe('iOS bundle ID or Android app package'),
        includeSetup: z.boolean().default(true).describe('Include WDIO configuration usage comments (the runner owns setup and teardown)'),
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
        return generateAppium(name, events, includeSetup, nextSelector);
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
        iosBundleId: z.string().optional().describe('iOS bundle ID when platform is both'),
        androidPackageName: z.string().optional().describe('Android app package when platform is both'),
        iosAppPath: z.string().optional().describe('Path to the iOS .app when platform is both'),
        androidAppPath: z.string().optional().describe('Path to the Android .apk when platform is both'),
        udid: z.string().optional().describe('Optional device UDID / serial for a single-platform config'),
        deviceName: z.string().optional().describe('Optional Appium device name for a single-platform config'),
        platformVersion: z.string().optional().describe('Optional OS version for a single-platform config'),
        iosUdid: z.string().optional().describe('Optional iOS simulator UDID when platform is both'),
        androidUdid: z.string().optional().describe('Optional Android device serial when platform is both'),
        iosDeviceName: z.string().optional().describe('Optional iOS Appium device name when platform is both'),
        androidDeviceName: z.string().optional().describe('Optional Android Appium device name when platform is both'),
        iosPlatformVersion: z.string().optional().describe('Optional iOS version when platform is both'),
        androidPlatformVersion: z.string().optional().describe('Optional Android version when platform is both'),
        noReset: z.boolean().default(true).describe('Preserve installed app data; false allows Appium to reset the app'),
        outputPath: z.string().default('./wdio.conf.ts').describe('Shown in the output, not written to disk'),
      }),
      handler: async ({
        platform,
        bundleId,
        appPath,
        iosBundleId,
        androidPackageName,
        iosAppPath,
        androidAppPath,
        udid,
        deviceName,
        platformVersion,
        iosUdid,
        androidUdid,
        iosDeviceName,
        androidDeviceName,
        iosPlatformVersion,
        androidPlatformVersion,
        noReset,
        outputPath,
      }) => {
        if (platform === 'both' && (bundleId || appPath || udid || deviceName || platformVersion)) {
          return 'For platform "both", use separate iOS and Android app and device options so each Appium capability targets the correct app and device.';
        }
        const connectedAppId = platform === 'both'
          ? undefined
          : getConnectedDeviceTarget(ctx)?.appId;
        const resolvedBundleId = platform === 'both' ? undefined : (bundleId ?? connectedAppId);
        const hasIosAppTarget = Boolean(iosAppPath || iosBundleId);
        const hasAndroidAppTarget = Boolean(androidAppPath || androidPackageName);
        if (platform === 'both' && (!hasIosAppTarget || !hasAndroidAppTarget)) {
          return 'For platform "both", provide iosAppPath or iosBundleId and androidAppPath or androidPackageName.';
        }
        if (platform !== 'both' && !appPath && !resolvedBundleId) {
          return 'Cannot generate a runnable Appium config without an app target. Provide bundleId, appPath, or connect to a Metro app with a bundle ID first.';
        }
        const lines: string[] = [];

        const buildCaps = (p: 'ios' | 'android'): string[] => {
          const cap: string[] = [];
          cap.push(`      {`);
          pushCaps(cap, p, {
            bundleId: platform === 'both'
              ? (p === 'ios' ? iosBundleId : androidPackageName)
              : resolvedBundleId,
            appPath: platform === 'both'
              ? (p === 'ios' ? iosAppPath : androidAppPath)
              : appPath,
            udid: p === 'ios' ? (iosUdid ?? udid) : (androidUdid ?? udid),
            deviceName: p === 'ios' ? (iosDeviceName ?? deviceName) : (androidDeviceName ?? deviceName),
            platformVersion: p === 'ios' ? (iosPlatformVersion ?? platformVersion) : (androidPlatformVersion ?? platformVersion),
            noReset,
          }, '        ');
          cap.push(`        'appium:newCommandTimeout': 240,`);
          cap.push(`      },`);
          return cap;
        };

        lines.push(`// ${safeComment(outputPath)}`);
        lines.push(`// Install deps: npm install --save-dev @wdio/cli @wdio/local-runner @wdio/globals @wdio/mocha-framework @wdio/spec-reporter @wdio/appium-service appium`);
        lines.push(`import type {} from '@wdio/types';`);
        lines.push('');
        lines.push(`export const config: WebdriverIO.Config = {`);
        lines.push(`  runner: 'local',`);
        lines.push('');
        lines.push(`  port: 4723,`);
        lines.push(`  services: ['appium'],`);
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
        lines.push(` * Run a single test:  npx wdio run ${safeComment(outputPath)} --spec ./e2e/login.test.ts`);
        lines.push(` * Run all tests:      npx wdio run ${safeComment(outputPath)}`);
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

function isRecorderSessionReplaced(value: unknown): boolean {
  return !!value && typeof value === 'object' &&
    (value as { __mcpRecorderSession?: unknown }).__mcpRecorderSession === RECORDER_SESSION_REPLACED;
}

// ────────────────────────────────────────────────────────────────────────────────
// Code generators
// ────────────────────────────────────────────────────────────────────────────────

function safeComment(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /');
}

function generateAppium(
  name: string,
  events: RecordedEvent[],
  includeSetup: boolean,
  nextSelector: (i: number, fn: (e: RecordedEvent) => string | null) => string | null,
): string {
  const lines: string[] = [];
  lines.push(`import { browser } from '@wdio/globals';`);
  lines.push('');

  // WDIO owns the session lifecycle in its runner configuration. Keep the
  // option for compatibility, but never create a second remote session.
  if (includeSetup) {
    lines.push(`// The WDIO config supplies the Appium service and runner session.`);
    lines.push(`// Run with: npx wdio run wdio.conf.ts --spec ./e2e/recorded.test.ts`);
    lines.push('');
  }

  if (events.some((event) => event.type === 'long_press' || event.type === 'swipe')) {
    appiumActionHelpers(lines);
  }

  lines.push(`describe(${JSON.stringify(name)}, () => {`);
  lines.push(`  it(${JSON.stringify(name)}, async () => {`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const sel = appiumSelector(ev);

    switch (ev.type) {
      case 'tap':
        lines.push(sel
          ? `    await browser.$(${JSON.stringify(sel)}).click();`
          : `    // TODO: tap ${JSON.stringify(ev.componentName ?? 'unknown element')}`);
        break;

      case 'long_press':
        lines.push(sel
          ? `    await longPress(${JSON.stringify(sel)});`
          : `    // TODO: long press ${JSON.stringify(ev.componentName ?? 'unknown element')}`);
        break;

      case 'type':
        if (sel) lines.push(`    await browser.$(${JSON.stringify(sel)}).setValue(${JSON.stringify(ev.text ?? '')});`);
        else lines.push(`    // TODO: type ${JSON.stringify(ev.text ?? '')} into an element with an accessibility ID`);
        break;

      case 'submit':
        lines.push(`    await browser.keys(['Enter']);`);
        break;

      case 'swipe':
        lines.push(`    await swipe(${JSON.stringify(ev.direction ?? 'up')});`);
        break;

      case 'navigate': {
        const assertSel = nextSelector(i, appiumSelector);
        lines.push(`    // navigated to: ${safeComment(ev.route ?? 'new screen')}`);
        lines.push(assertSel
          ? `    await browser.$(${JSON.stringify(assertSel)}).waitForDisplayed({ timeout: 5000 });`
          : `    // TODO: assert screen loaded`);
        break;
      }

      case 'annotation':
        lines.push(`    // ${safeComment(ev.note ?? '')}`);
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
