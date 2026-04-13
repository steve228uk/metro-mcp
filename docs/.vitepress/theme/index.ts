import { h } from 'vue'
import type { App } from 'vue'
import DefaultTheme from 'vitepress/theme'
import QuickInstall from './QuickInstall.vue'
import GitHubStars from './GitHubStars.vue'
import PromptDemo from './PromptDemo.vue'
import CommunityPlugins from './CommunityPlugins.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(GitHubStars),
      'home-hero-image': () => h('div', { class: 'hero-image-demo' }, [h(PromptDemo)]),
      'home-hero-after': () => h('div', { class: 'mobile-hero-demo' }, [h(PromptDemo)]),
      'home-features-before': () => h(QuickInstall),
    })
  },
  enhanceApp({ app }: { app: App }) {
    app.component('CommunityPlugins', CommunityPlugins)
  },
}
