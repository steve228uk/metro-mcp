# Test Recording

metro-mcp can record real user interactions and generate production-ready automated tests — with no changes to your app code.

## Contents

- [How It Works](#how-it-works)
- [Supported Formats](#supported-formats)
- [AI-Driven Test Generation](#ai-driven-test-generation)
- [Manual Recording](#manual-recording)
- [Output Examples](#output-examples)
- [Scroll and Swipe Capture](#scroll-and-swipe-capture)
- [Tips for Better Tests](#tips-for-better-tests)
- [Limitations](#limitations)

---

## How It Works

When you call `start_test_recording`, metro-mcp injects a JavaScript interceptor into the app runtime via Chrome DevTools Protocol. Startup has a bounded readiness phase: existing mounted props are refreshed where React can schedule an update, and a complete fiber scan (up to depth 600 and 5,000 nodes) must confirm the handlers are wrapped before capture is enabled. If React cannot provide complete coverage, startup fails and removes its instrumentation rather than reporting a partial recording. The interceptor then:

- **Wraps event handlers** on every React fiber: `onPress`, `onChangeText`, `onLongPress`, `onSubmitEditing`
- **Patches scroll containers** to capture swipe direction via `onScrollBeginDrag`/`onScrollEndDrag`
- **Hooks React's commit lifecycle** (`onCommitFiberRoot`) to automatically patch new fibers as screens mount after navigation

The recorder and profiler can run together. Each one keeps the hook chain intact when the other starts or stops, and an old recorder session stops recording without allowing its wrappers to capture into a later session.

Each interaction is recorded with the element's `testID`, `accessibilityLabel`, component name, current route, and timestamp. When you call `stop_test_recording`, the events are deduplicated (rapid-fire `onChangeText` keystrokes are collapsed to the final value) and stored for test generation.

This approach requires **zero app code changes** and works with Hermes on both iOS and Android.

---

## Supported Formats

| Format | Framework | Generated file type |
|--------|-----------|---------------------|
| `appium` | WebdriverIO + Mocha | `.test.ts` |
| `maestro` | Maestro | `.yaml` |
| `detox` | Detox + Jest | `.test.js` |

---

## AI-Driven Test Generation

The most powerful workflow: describe a user flow and the AI navigates the app, recording every step.

**Example prompt:**
> *"Write an Appium test for the guest checkout flow — start by tapping 'Start Shopping' on the welcome screen and finish once we've landed on the cart screen."*

**What happens:**
1. The AI calls `start_test_recording`
2. It inspects the current screen with `get_testable_elements`
3. It navigates step by step using `tap_element`, `type_text`, and `swipe`
4. Each action fires the patched fiber handlers, logging the real selector used
5. The AI calls `stop_test_recording`, then `generate_test_from_recording`
6. You get a complete test with accurate selectors and assertions

Use the built-in `record-test` prompt to trigger this workflow automatically:

```
/record-test flow="guest checkout: tap Start Shopping, add first product, proceed to cart" format=appium
```

---

## Manual Recording

Record while you interact with the app yourself (or have the AI drive specific steps):

```
start_test_recording
→ interact with the app
stop_test_recording
generate_test_from_recording format=appium testName="Login flow"
```

For `generate_test_from_recording`, additional parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `format` | — | Required. `appium`, `maestro`, or `detox` |
| `testName` | `"Recorded flow"` | Name for the describe/it block |
| `platform` | `ios` | `ios`, `android`, or `both` (Appium only) |
| `bundleId` | — | iOS bundle ID or Android app package |
| `includeSetup` | `true` | Include runner configuration comments in Appium output; WDIO always owns setup and teardown |

---

## Output Examples

### Appium (WebdriverIO)

```typescript
import { browser } from '@wdio/globals';

describe('Guest checkout', () => {
  it('Guest checkout', async () => {
    // navigated to: WelcomeScreen
    await browser.$('~startShoppingButton').waitForDisplayed({ timeout: 5000 });

    await browser.$('~startShoppingButton').click();

    // navigated to: ProductListScreen
    await browser.$('~productCard').waitForDisplayed({ timeout: 5000 });

    await browser.$('~productCard').click();
    await browser.$('~addToCartButton').click();

    // navigated to: CartScreen
    await browser.$('~checkoutButton').waitForDisplayed({ timeout: 5000 });
  });
});
```

Run with: `npx wdio run wdio.conf.ts`

The runner owns the Appium session. Generate its configuration separately with `generate_wdio_config`; set `platform` to `ios`, `android`, or `both`, and optionally provide `bundleId`, `appPath`, `udid`, `deviceName`, and `platformVersion`. The generated spec uses WDIO's `browser` instance and does not create or tear down a second session. Swipes and long presses use W3C pointer actions, while submit events use `browser.keys`.

The generated configuration defaults `noReset` to `true` to preserve installed app data. Appium may launch the target if it is not running. Return the app to the recording’s starting screen before replaying it. Set `noReset: false` only when the test should let Appium reset the app; that can clear onboarding or login state.

The configuration requires an app target. If `bundleId` and `appPath` are omitted, the connected Metro app's ID is used. With no connected app, provide one of those arguments.

For TypeScript checking, include `node`, `@wdio/globals/types`, and `@wdio/mocha-framework` in your `tsconfig.json` compiler `types`. This loads WDIO's browser and Mocha types for both generated setup modes.

---

### Maestro

```yaml
# Guest checkout
- tapOn:
    id: "startShoppingButton"

# navigated to: ProductListScreen
- assertVisible:
    id: "productCard"

- tapOn:
    id: "productCard"

- tapOn:
    id: "addToCartButton"

# navigated to: CartScreen
- assertVisible:
    id: "checkoutButton"
```

Run with: `maestro test flow.yaml`

---

### Detox

```javascript
const { device, element, by, expect } = require('detox');

describe('Guest checkout', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  afterAll(async () => {
    await device.terminateApp();
  });

  it('Guest checkout', async () => {
    // navigated to: WelcomeScreen
    await expect(element(by.id('startShoppingButton'))).toBeVisible();

    await element(by.id('startShoppingButton')).tap();

    // navigated to: ProductListScreen
    await expect(element(by.id('productCard'))).toBeVisible();

    await element(by.id('productCard')).tap();
    await element(by.id('addToCartButton')).tap();

    // navigated to: CartScreen
    await expect(element(by.id('checkoutButton'))).toBeVisible();
  });
});
```

Run with: `npx detox test`

---

## Scroll and Swipe Capture

Swipe gestures are captured automatically on standard React Native scroll containers:

| Component | Captured? |
|-----------|-----------|
| `ScrollView` | Yes |
| `FlatList` | Yes (via inner ScrollView) |
| `SectionList` | Yes (via inner ScrollView) |
| `VirtualizedList` | Yes (via inner ScrollView) |
| `FlashList` (Shopify) | Yes (via inner ScrollView) |
| `RecyclerListView` | Yes |
| `BigList` | Yes |
| Custom `PanResponder` gestures | No — see [Limitations](#limitations) |

**Deduplication:** If both a list wrapper and its inner `ScrollView` are patched, duplicate swipe events within 100ms are automatically discarded.

**Direction convention:**
- `up` — user swiped upward (content scrolled down to reveal more items)
- `down` — user swiped downward (content scrolled up)
- `left` / `right` — horizontal swipe

When the AI uses the `swipe` tool directly (e.g. during AI-driven navigation), the swipe is also logged to the recording regardless of whether a scroll container is present.

---

## Tips for Better Tests

### Add testIDs to your components

Tests are most readable and reliable when elements have `testID` props. Without them, the recorder falls back to `accessibilityLabel`, and if neither is present it emits a `// TODO` comment.

```tsx
// Good — testID gives a stable, readable selector
<TouchableOpacity testID="loginButton" onPress={handleLogin}>
  <Text>Log In</Text>
</TouchableOpacity>

// Also works — accessibilityLabel is used as fallback
<TouchableOpacity accessibilityLabel="Log In" onPress={handleLogin}>
  <Text>Log In</Text>
</TouchableOpacity>
```

Run `get_testable_elements` before recording to see which elements have selectors. Elements listed with neither `testID` nor `accessibilityLabel` will produce `// TODO` placeholders in the generated test.

### Give scroll containers a testID

Scroll containers with a `testID` produce more specific swipe steps — especially useful in Detox where you can target the exact list:

```tsx
<FlatList testID="productList" data={products} renderItem={...} />
```

Without a `testID`, Detox swipe steps fall back to `by.type('RCTScrollView')`.

### Use the `record-test` prompt for complex flows

The `record-test` prompt is tuned for multi-screen flows. It:
1. Inspects available selectors before each tap
2. Handles navigation by waiting for the next screen
3. Deduplicates redundant steps

### Break long flows into smaller `it()` blocks

Generate separate recordings for distinct sub-flows (e.g., sign-up, onboarding, checkout) and pass `testName` to keep each block focused.

---

## Limitations

- **Custom gesture handlers**: Swipes handled by `PanResponder` or `react-native-gesture-handler` directly (without a standard scroll container) are not captured. The fiber patcher only wraps standard scroll event callbacks.
- **iOS swipe via IDB**: When the `swipe` tool falls back to IDB (no CDP scroll target found), the swipe is still logged to the recording from the tool side.
- **Hermes required**: The fiber patcher uses the React DevTools hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`), which is only available with Hermes. JSC is not supported.
- **Recording is session-scoped**: Events are held in memory. If the Metro connection drops mid-recording, call `stop_test_recording` to retrieve whatever was captured before the drop.
