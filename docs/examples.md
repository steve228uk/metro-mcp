# Examples

A collection of example prompts you can ask your AI agent once metro-mcp is connected to your running app. These work with Claude, Cursor, VS Code, or any MCP-compatible client.

## Debugging

::: tip
Before diving in, ask your agent to connect to your running app: *"Connect to my React Native app and tell me what's on screen."*
:::

**Re-renders & performance**
- *"Why is my FlatList re-rendering so often?"*
- *"Which components are rendering the most? Show me the top 5."*
- *"My screen feels janky when scrolling — what's causing it?"*

**Crashes & errors**
- *"Are there any errors in the console?"*
- *"My app just crashed. What was the last error?"*
- *"Show me all warnings from the last 30 seconds."*

**Layout & UI**
- *"Why is my button not responding to taps?"*
- *"The header looks misaligned on this screen — inspect the component tree."*

---

## Inspecting Components

- *"Show me the component tree for the current screen."*
- *"What props and state does the \`CartButton\` component have?"*
- *"Find all \`Text\` components on screen and show me their content."*
- *"Inspect what's at coordinates (200, 400) on screen."*
- *"Is the \`LoginForm\` component mounted right now?"*

---

## Network Requests

- *"Are there any failed network requests?"*
- *"Show me what the \`/api/user\` endpoint returned."*
- *"How long are my API calls taking on average?"*
- *"Is my app sending any unexpected background requests?"*
- *"Show me the full response body for the last cart API call."*

---

## State Management

**Redux**
- *"What's in my Redux store?"*
- *"Why isn't my auth state updating after login?"*
- *"Dispatch a \`CLEAR_CART\` action and tell me what changed."*
- *"Show me all Redux actions dispatched in the last minute."*

**AsyncStorage / MMKV**
- *"What's saved in AsyncStorage right now?"*
- *"Read the \`user_preferences\` key from storage."*

---

## Navigation

- *"What's the current navigation state?"*
- *"Show me the full route history for this session."*
- *"Navigate to the \`Settings\` screen."*
- *"What deep link schemes does this app support?"*

---

## Testing

- *"Record a test for the checkout flow."*
- *"I just recorded a session — generate a Detox test from it."*
- *"Create a Maestro flow for the onboarding screens."*
- *"What elements on this screen are testable? Show me their IDs."*

---

## Profiling & Performance

- *"Profile the next 5 seconds of interaction and show me the flamegraph."*
- *"What's my app's current memory usage?"*
- *"Profile this screen transition and tell me what's slow."*
- *"Start a CPU profile, tap through the onboarding flow, then stop and summarise."*

---

## Accessibility

- *"Does this screen have any accessibility issues?"*
- *"Which elements are missing accessibility labels?"*
- *"Give me an accessibility summary of the current screen."*
