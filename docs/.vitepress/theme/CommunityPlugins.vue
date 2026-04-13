<script setup lang="ts">
import { ref, computed } from 'vue'
import { data as plugins } from '../data/plugins.data'
import type { CommunityPlugin } from '../data/plugins.data'
import { sanitizeExternalUrl } from '../utils/sanitizeExternalUrl'

const query = ref('')

type CommunityPluginWithSafeLinks = CommunityPlugin & {
  safeLinks: { repository?: string; homepage?: string }
}

const filtered = computed<CommunityPluginWithSafeLinks[]>(() => {
  const q = query.value.toLowerCase().trim()
  const matching = !q
    ? plugins
    : plugins.filter((p: CommunityPlugin) => p.searchText.includes(q))

  return matching.map((plugin: CommunityPlugin) => ({
    ...plugin,
    safeLinks: {
      repository: sanitizeExternalUrl(plugin.links.repository),
      homepage: sanitizeExternalUrl(plugin.links.homepage),
    },
  }))
})

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
</script>

<template>
  <div class="community-plugins">
    <div class="search-bar">
      <input
        v-model="query"
        type="search"
        placeholder="Search plugins..."
        class="search-input"
        aria-label="Search community plugins"
      />
      <span v-if="plugins.length > 0" class="plugin-count">
        {{ filtered.length }} of {{ plugins.length }} plugins
      </span>
    </div>

    <div v-if="plugins.length === 0" class="empty-state">
      No community plugins found yet. Be the first to
      <a href="https://github.com/steve228uk/metro-mcp/issues" target="_blank" rel="noopener">publish one</a>!
    </div>

    <div v-else-if="filtered.length === 0" class="empty-state">
      No plugins match <strong>{{ query }}</strong>.
    </div>

    <ul v-else class="plugin-list">
      <li v-for="plugin in filtered" :key="plugin.name" class="plugin-card">
        <div class="plugin-header">
          <a :href="plugin.links.npm" target="_blank" rel="noopener" class="plugin-name">
            {{ plugin.name }}
          </a>
          <span class="plugin-version">v{{ plugin.version }}</span>
        </div>

        <p v-if="plugin.description" class="plugin-description">
          {{ plugin.description }}
        </p>

        <div class="plugin-meta">
          <span v-if="plugin.author" class="plugin-author">by {{ plugin.author }}</span>
          <span v-if="plugin.date" class="plugin-date">{{ formatDate(plugin.date) }}</span>
        </div>

        <div v-if="plugin.safeLinks.repository || plugin.safeLinks.homepage" class="plugin-links">
          <a
            v-if="plugin.safeLinks.repository"
            :href="plugin.safeLinks.repository"
            target="_blank"
            rel="noopener"
            class="plugin-link"
          >
            repository
          </a>
          <a
            v-if="plugin.safeLinks.homepage"
            :href="plugin.safeLinks.homepage"
            target="_blank"
            rel="noopener"
            class="plugin-link"
          >
            homepage
          </a>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.community-plugins {
  margin: 1.5rem 0;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 1.5rem;
}

.search-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--vp-c-brand-1);
}

.plugin-count {
  font-size: 13px;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}

.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-radius: 12px;
}

.plugin-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.plugin-card {
  padding: 16px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s;
}

.plugin-card:hover {
  border-color: var(--vp-c-brand-1);
}

.plugin-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.plugin-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  font-family: var(--vp-font-family-mono);
}

.plugin-name:hover {
  text-decoration: underline;
}

.plugin-version {
  font-size: 12px;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

.plugin-description {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

.plugin-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-bottom: 10px;
}

.plugin-links {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.plugin-link {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: border-color 0.15s, color 0.15s;
}

.plugin-link:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
</style>
