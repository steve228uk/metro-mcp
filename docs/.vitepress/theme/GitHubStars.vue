<script setup lang="ts">
import { ref, onMounted } from 'vue'

const stars = ref<number | null>(null)

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/steve228uk/metro-mcp')
    if (res.ok) {
      const data = await res.json()
      stars.value = data.stargazers_count
    }
  } catch {
    // silently fail — widget won't render
  }
})

function formatCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
</script>

<template>
  <a
    v-if="stars !== null"
    class="github-stars"
    href="https://github.com/steve228uk/metro-mcp"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Star metro-mcp on GitHub"
  >
    <svg class="github-stars-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>
    </svg>
    <span class="github-stars-count">{{ formatCount(stars) }}</span>
  </a>
</template>

<style scoped>
.github-stars {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.github-stars:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-text-2);
}

.github-stars-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.github-stars-count {
  line-height: 1;
}
</style>
