<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Demo {
  prompt: string
  response: string
}

const demos: Demo[] = [
  {
    prompt: 'Why is my FlatList re-rendering so often?',
    response: 'Found 14 unnecessary re-renders on <ProductList>. The issue is an inline arrow function in renderItem — move it outside the component or wrap with useCallback.',
  },
  {
    prompt: 'Are there any failed network requests?',
    response: '2 failed requests found:\n  POST /api/cart 401 Unauthorized\n  GET /api/recommendations 503 Service Unavailable',
  },
  {
    prompt: 'Show me the current navigation state',
    response: 'Stack: Home → ProductDetail → Cart\nActive route: Cart\nParams: { itemCount: 3, total: "$47.99" }',
  },
  {
    prompt: "What's in my Redux store?",
    response: '{\n  auth: { user: "steve@example.com", isLoggedIn: true },\n  cart: { items: 3, total: 47.99 },\n  ui: { theme: "dark", loading: false }\n}',
  },
  {
    prompt: 'Record a test for the checkout flow',
    response: 'Test recording started. Interact with your app to capture the checkout flow. Run stop_test_recording when done to generate your Detox/Maestro test.',
  },
]

const currentIndex = ref(0)
const displayedPrompt = ref('')
const displayedResponse = ref('')
const phase = ref<'typing-prompt' | 'showing-response' | 'pause'>('typing-prompt')

let timeout: ReturnType<typeof setTimeout> | null = null

function scheduleNext(fn: () => void, delay: number) {
  timeout = setTimeout(fn, delay)
}

function typePrompt() {
  const full = demos[currentIndex.value].prompt
  let i = displayedPrompt.value.length

  function tick() {
    if (i < full.length) {
      displayedPrompt.value = full.slice(0, i + 1)
      i++
      scheduleNext(tick, 28 + Math.random() * 20)
    } else {
      phase.value = 'showing-response'
      scheduleNext(showResponse, 400)
    }
  }

  tick()
}

function showResponse() {
  displayedResponse.value = demos[currentIndex.value].response
  scheduleNext(advance, 3200)
}

function advance() {
  phase.value = 'pause'
  displayedResponse.value = ''
  displayedPrompt.value = ''
  scheduleNext(() => {
    currentIndex.value = (currentIndex.value + 1) % demos.length
    phase.value = 'typing-prompt'
    typePrompt()
  }, 500)
}

onMounted(() => {
  scheduleNext(typePrompt, 800)
})

onUnmounted(() => {
  if (timeout) clearTimeout(timeout)
})
</script>

<template>
  <div class="prompt-demo">
    <div class="prompt-demo-inner">
      <div class="demo-window">
        <div class="demo-titlebar">
          <span class="dot dot-red" />
          <span class="dot dot-yellow" />
          <span class="dot dot-green" />
          <span class="demo-title">Claude</span>
        </div>
        <div class="demo-body">
          <div class="demo-prompt-row" v-if="displayedPrompt || phase === 'typing-prompt'">
            <span class="demo-prompt-prefix">You</span>
            <span class="demo-prompt-text">{{ displayedPrompt }}<span class="cursor" :class="{ visible: phase === 'typing-prompt' }">|</span></span>
          </div>
          <div
            class="demo-response"
            :class="{ visible: phase === 'showing-response' }"
          >
            <span class="demo-response-prefix">Claude</span>
            <pre class="demo-response-text">{{ displayedResponse }}</pre>
          </div>
        </div>
        <div class="demo-pills">
          <span
            v-for="(_, i) in demos"
            :key="i"
            class="demo-pill"
            :class="{ active: i === currentIndex }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt-demo {
  width: 100%;
}

.prompt-demo-inner {
  width: 100%;
  max-width: 480px;
}

@media (max-width: 959px) {
  .prompt-demo {
    padding: 0 24px;
  }

  .prompt-demo-inner {
    max-width: 100%;
  }
}

.demo-window {
  background: var(--vp-code-block-bg);
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}

.demo-titlebar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--vp-code-block-bg) 80%, #000 20%);
  border-bottom: 1px solid var(--vp-c-divider);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.dot-red { background: #ff5f57; }
.dot-yellow { background: #febc2e; }
.dot-green { background: #28c840; }

.demo-title {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-left: 6px;
}

.demo-body {
  padding: 20px;
  height: 175px;
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
}

.demo-prompt-row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.demo-prompt-prefix {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 44px;
}

.demo-prompt-text {
  color: var(--vp-c-text-1);
}

.cursor {
  opacity: 0;
  margin-left: 1px;
  color: var(--vp-c-brand-1);
  transition: opacity 0.1s;
}

.cursor.visible {
  animation: blink 0.9s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.demo-response {
  display: flex;
  gap: 10px;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.demo-response.visible {
  opacity: 1;
  transform: translateY(0);
}

.demo-response-prefix {
  color: var(--vp-c-text-3);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 44px;
}

.demo-response-text {
  margin: 0;
  padding: 0;
  background: transparent;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--vp-c-text-2);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

@media (min-width: 960px) {
  .demo-body {
    height: 220px;
  }
}

.demo-pills {
  display: flex;
  gap: 5px;
  justify-content: center;
  padding: 12px;
  border-top: 1px solid var(--vp-c-divider);
}

.demo-pill {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-divider);
  transition: background 0.3s;
}

.demo-pill.active {
  background: var(--vp-c-brand-1);
}
</style>
