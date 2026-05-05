<script setup lang="ts">
import { ref } from 'vue'

const tabs = ['Multiple Agents', 'Claude Code', 'Codex', 'OpenCode', 'Cursor', 'VS Code']
const active = ref('Multiple Agents')
</script>

<template>
  <div class="quick-install">
    <div class="quick-install-inner">
    <h2 class="quick-install-heading">Quick Install</h2>
    <div class="quick-install-tabs-wrapper">
      <div class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab"
          :class="['tab', { active: active === tab }]"
          @click="active = tab"
        >
          {{ tab }}
        </button>
      </div>
      <div class="tab-content">
        <div v-if="active === 'Multiple Agents'">
          <pre><code>npx add-mcp metro-mcp --all -g -y</code></pre>
        </div>
        <div v-if="active === 'Claude Code'">
          <pre><code>claude mcp add metro-mcp -- npx -y metro-mcp</code></pre>
        </div>
        <div v-if="active === 'Codex'">
          <pre><code>codex mcp add metro-mcp -- npx -y metro-mcp</code></pre>
        </div>
        <div v-if="active === 'OpenCode'">
          <pre><code>opencode mcp add</code></pre>
        </div>
        <div v-if="active === 'Cursor'">
          <pre><code>{
  "mcpServers": {
    "metro-mcp": {
      "command": "npx",
      "args": ["-y", "metro-mcp"]
    }
  }
}</code></pre>
          <a
            class="one-click-btn"
            href="https://cursor.com/en/install-mcp?name=metro-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1ldHJvLW1jcCJdLCJlbnYiOnt9fQ=="
          >Install in Cursor →</a>
        </div>
        <div v-if="active === 'VS Code'">
          <pre><code>{
  "mcpServers": {
    "metro-mcp": {
      "command": "npx",
      "args": ["-y", "metro-mcp"]
    }
  }
}</code></pre>
          <a
            class="one-click-btn"
            href="https://vscode.dev/redirect/mcp/install?name=metro-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22metro-mcp%22%5D%2C%22env%22%3A%7B%7D%7D"
          >Install in VS Code →</a>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.quick-install {
  padding: 16px 24px;
}

@media (min-width: 640px) {
  .quick-install {
    padding: 16px 48px;
  }
}

@media (min-width: 960px) {
  .quick-install {
    padding: 16px 64px;
  }
}

.quick-install-inner {
  max-width: 1152px;
  margin: 0 auto;
}

.quick-install-heading {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 16px;
  border: none;
  padding: 0;
}

.quick-install-tabs-wrapper {
  width: 100%;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 0;
}

.tab {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-2);
  border: none;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
  transition: color 0.15s;
}

.tab.active {
  color: var(--vp-c-text-1);
  background: var(--vp-code-block-bg);
  box-shadow: inset 0 -2px 0 var(--vp-c-brand-1);
}

.tab-content {
  background: var(--vp-code-block-bg);
  border-radius: 0 6px 6px 6px;
  padding: 16px;
}

.tab-content pre {
  margin: 0;
  background: transparent;
  padding: 0;
  overflow-x: auto;
}

.tab-content code {
  font-size: 13px;
  color: var(--vp-code-block-color);
}

.one-click-btn {
  display: inline-block;
  margin-top: 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.one-click-btn:hover {
  text-decoration: underline;
}
</style>
