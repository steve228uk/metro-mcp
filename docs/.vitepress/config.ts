import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'metro-mcp',
  description: 'Connect Claude, Cursor, or any AI agent to your React Native or Expo app. Inspect components, debug network requests, record tests, and more — no app code changes needed.',
  base: '/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'keywords', content: 'React Native MCP, Expo MCP, React Native AI debugger, React Native Claude, React Native debugging, MCP server React Native, Expo AI tools, React Native in Claude, metro-mcp' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://metromcp.dev' }],
    ['meta', { property: 'og:title', content: 'metro-mcp — Debug React Native with AI' }],
    ['meta', { property: 'og:description', content: 'Connect Claude, Cursor, or AI agent to your React Native or Expo app. Inspect components, debug network requests, record tests, and more — no app code changes needed.' }],
    ['meta', { property: 'og:image', content: 'https://metromcp.dev/og-image.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'metro-mcp — Debug React Native with AI' }],
    ['meta', { name: 'twitter:description', content: 'Connect Claude, Cursor, or AI agent to your React Native or Expo app. Inspect components, debug network requests, record tests, and more.' }],
    ['meta', { name: 'twitter:image', content: 'https://metromcp.dev/og-image.png' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Examples', link: '/examples' },
      { text: 'Troubleshooting', link: '/troubleshooting' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'npm', link: 'https://www.npmjs.com/package/metro-mcp' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Examples', link: '/examples' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Client SDK', link: '/sdk' },
          { text: 'Custom Plugins', link: '/plugins' },
          { text: 'Community Plugins', link: '/community-plugins' },
          { text: 'Profiling', link: '/profiling' },
          { text: 'Test Recording', link: '/testing' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/cli' },
          { text: 'Tools', link: '/tools' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    outline: 'deep',

    socialLinks: [
      { icon: 'github', link: 'https://github.com/steve228uk/metro-mcp' },
    ],

    editLink: {
      pattern: 'https://github.com/steve228uk/metro-mcp/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Stephen Radford',
    },

    search: {
      provider: 'local',
    },
  },
})
