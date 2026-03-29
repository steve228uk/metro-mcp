import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { GET_ROUTE_FUNC_JS, SWIPE_COORDS } from '../utils/fiber.js';

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

// ── JS injected into the app runtime to intercept interactions via fiber patching.
const START_RECORDING_JS = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return false;

  globalThis.__METRO_MCP_REC_EVENTS__ = [];
  globalThis.__METRO_MCP_REC_ACTIVE__ = true;
  var patched = new WeakSet();

  ${GET_ROUTE_FUNC_JS}

  function patchFibers(rootFiber) {
    var stack = [{ f: rootFiber, d: 0 }];
    while (stack.length) {
      var item = stack.pop(); var fiber = item.f; var depth = item.d;
      if (!fiber || depth > 200) continue;
      if (!patched.has(fiber)) {
        patched.add(fiber);
        var props = fiber.memoizedProps;
        if (props && !props.__mcpRec) {
          var tid = props.testID || null;
          var lbl = props.accessibilityLabel || props['aria-label'] || null;
          var cn  = typeof fiber.type === 'string'
            ? fiber.type
            : (fiber.type && (fiber.type.displayName || fiber.type.name)) || null;

          // ── Tap / press ──────────────────────────────────────────────────────
          if (typeof props.onPress === 'function') {
            var op = props.onPress;
            props.onPress = function(e) {
              if (globalThis.__METRO_MCP_REC_ACTIVE__)
                globalThis.__METRO_MCP_REC_EVENTS__.push({ type: 'tap', testID: tid, label: lbl, componentName: cn, route: getRoute(), timestamp: Date.now() });
              return op.call(this, e);
            };
            props.__mcpRec = true;
          }

          // ── Long press ───────────────────────────────────────────────────────
          if (typeof props.onLongPress === 'function') {
            var olp = props.onLongPress;
            props.onLongPress = function(e) {
              if (globalThis.__METRO_MCP_REC_ACTIVE__)
                globalThis.__METRO_MCP_REC_EVENTS__.push({ type: 'long_press', testID: tid, label: lbl, componentName: cn, route: getRoute(), timestamp: Date.now() });
              return olp.call(this, e);
            };
          }

          // ── Text input ───────────────────────────────────────────────────────
          if (typeof props.onChangeText === 'function') {
            var oct = props.onChangeText;
            props.onChangeText = function(val) {
              if (globalThis.__METRO_MCP_REC_ACTIVE__)
                globalThis.__METRO_MCP_REC_EVENTS__.push({ type: 'type', testID: tid, label: lbl, text: val, route: getRoute(), timestamp: Date.now() });
              return oct.call(this, val);
            };
          }

          // ── Keyboard submit ──────────────────────────────────────────────────
          if (typeof props.onSubmitEditing === 'function') {
            var ose = props.onSubmitEditing;
            props.onSubmitEditing = function(e) {
              if (globalThis.__METRO_MCP_REC_ACTIVE__)
                globalThis.__METRO_MCP_REC_EVENTS__.push({ type: 'submit', testID: tid, label: lbl, route: getRoute(), timestamp: Date.now() });
              return ose.call(this, e);
            };
          }

          // ── Scroll / swipe ───────────────────────────────────────────────────
          // Target ScrollView-level fibers: covers FlatList → VirtualizedList → ScrollView
          // and FlashList → RecyclerListView → ScrollView chains, plus named third-party lists.
          // props.scrollEnabled !== undefined is the most universal scroll-container signal.
          // Exclude RCT host components (we want the JS composite layer).
          var isScrollable = cn === 'ScrollView' || cn === 'RecyclerListView' ||
                             cn === 'FlashList'  || cn === 'MasonryFlashList' ||
                             cn === 'BigList'    ||
                             (props.scrollEnabled !== undefined && cn && cn.indexOf('RCT') !== 0);
          if (isScrollable) {
            var scrollStart = { x: null, y: null };
            var origBegin = props.onScrollBeginDrag || null;
            var origEnd   = props.onScrollEndDrag   || null;
            props.onScrollBeginDrag = function(e) {
              scrollStart.x = e.nativeEvent.contentOffset.x;
              scrollStart.y = e.nativeEvent.contentOffset.y;
              if (origBegin) origBegin.call(this, e);
            };
            props.onScrollEndDrag = function(e) {
              if (scrollStart.x !== null && globalThis.__METRO_MCP_REC_ACTIVE__) {
                var dx = e.nativeEvent.contentOffset.x - scrollStart.x;
                var dy = e.nativeEvent.contentOffset.y - scrollStart.y;
                // dy > 0: content offset increased → user swiped UP (showed lower content)
                // dy < 0: content offset decreased → user swiped DOWN
                var dir = Math.abs(dx) > Math.abs(dy)
                  ? (dx > 0 ? 'left' : 'right')
                  : (dy > 0 ? 'up'   : 'down');
                // 100 ms dedup: prevent duplicate events when multiple scroll fibers are patched
                var evts = globalThis.__METRO_MCP_REC_EVENTS__;
                var last = evts[evts.length - 1];
                if (!(last && last.type === 'swipe' && Date.now() - last.timestamp < 100)) {
                  evts.push({ type: 'swipe', direction: dir, testID: tid, componentName: cn, route: getRoute(), timestamp: Date.now() });
                }
                scrollStart.x = null;
              }
              if (origEnd) origEnd.call(this, e);
            };
            props.__mcpRec = true;
          }
        }
      }
      if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
      if (fiber.child)   stack.push({ f: fiber.child,   d: depth + 1 });
    }
  }

  // Patch currently-rendered fibers
  for (var i = 1; i <= 5; i++) {
    var roots = hook.getFiberRoots(i);
    if (roots && roots.size > 0) {
      Array.from(roots).forEach(function(r) { patchFibers(r.current); });
      break;
    }
  }

  // Re-patch after every React commit (handles post-navigation new screens)
  var origCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function(id, root) {
    if (globalThis.__METRO_MCP_REC_ACTIVE__) {
      patchFibers(root.current);
      // Record navigation events when route changes
      var route = getRoute();
      var evts  = globalThis.__METRO_MCP_REC_EVENTS__;
      var last  = evts[evts.length - 1];
      if (route && (!last || last.type !== 'navigate' || last.route !== route))
        evts.push({ type: 'navigate', route: route, timestamp: Date.now() });
    }
    if (origCommit) origCommit.apply(this, arguments);
  };

  globalThis.__METRO_MCP_REC_CLEANUP__ = function() {
    globalThis.__METRO_MCP_REC_ACTIVE__ = false;
    hook.onCommitFiberRoot = origCommit;
  };
  return true;
})()
`;

// ── Recorded event shape (mirrors the JS-side object pushed to __METRO_MCP_REC_EVENTS__)
interface RecordedEvent {
  type: 'tap' | 'type' | 'long_press' | 'submit' | 'swipe' | 'navigate';
  testID?:       string | null;
  label?:        string | null;
  componentName?: string | null;
  text?:         string;       // type events
  direction?:    string;       // swipe events
  route?:        string | null;
  timestamp:     number;
}

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
  version: '0.1.0',
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
      parameters: z.object({}),
      handler: async () => {
        storedEvents = null;

        const injected = await ctx.evalInApp(START_RECORDING_JS, { timeout: 6000 }).catch(() => false);
        if (!injected) {
          return 'Could not inject recording hooks — ensure Metro is connected and the app is running.';
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
