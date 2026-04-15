import { PLUGIN_BLACKLIST } from './plugin-blacklist'
import { sanitizeExternalUrl } from '../utils/sanitizeExternalUrl'

export interface CommunityPlugin {
  name: string
  description: string
  version: string
  author: string
  date: string
  links: { npm: string; homepage?: string; repository?: string }
  searchText: string
}

// Packages to fetch directly from the npm registry, bypassing search indexing delays.
const PINNED_PACKAGES = ['metro-mcp-plugin-zustand', 'metro-mcp-plugin-mmkv']

function mapPackage(p: any): CommunityPlugin {
  const name = p.name as string
  const description = (p.description ?? '') as string
  const author = (p.publisher?.username ?? p.author?.name ?? '') as string
  return {
    name,
    description,
    version: p.version as string,
    author,
    date: p.date as string,
    links: {
      npm: `https://www.npmjs.com/package/${name}`,
      homepage: sanitizeExternalUrl(p.links?.homepage),
      repository: sanitizeExternalUrl(p.links?.repository),
    },
    searchText: `${name} ${description} ${author}`.toLowerCase(),
  }
}

async function fetchPinnedPackages(): Promise<CommunityPlugin[]> {
  const results = await Promise.allSettled(
    PINNED_PACKAGES.map(async (name) => {
      const res = await fetch(`https://registry.npmjs.org/${name}/latest`)
      if (!res.ok) return null
      const p = await res.json()
      // Normalise to the shape mapPackage expects
      return mapPackage({
        name: p.name,
        description: p.description,
        version: p.version,
        date: p.time?.modified ?? p.time?.created ?? '',
        publisher: { username: p._npmUser?.name },
        author: p.author,
        links: {
          homepage: p.homepage,
          repository:
            typeof p.repository === 'string'
              ? p.repository
              : p.repository?.url,
        },
      })
    }),
  )
  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => (r as PromiseFulfilledResult<CommunityPlugin>).value)
}

export default {
  async load(): Promise<CommunityPlugin[]> {
    const res = await fetch(
      'https://registry.npmjs.org/-/v1/search?text=metro-mcp-plugin&size=100',
    )

    if (!res.ok) {
      throw new Error(`npm registry error: ${res.status}`)
    }

    const { objects } = await res.json()

    const fromSearch = objects
      .map((o: any) => o.package)
      .filter(
        (p: any) =>
          p.name.startsWith('metro-mcp-plugin-') &&
          !PLUGIN_BLACKLIST.includes(p.name),
      )
      .map(mapPackage)

    const pinned = await fetchPinnedPackages()

    // Merge pinned packages, skipping any already returned by the search.
    const searchNames = new Set(fromSearch.map((p: CommunityPlugin) => p.name))
    const extra = pinned.filter((p) => !searchNames.has(p.name))

    return [...fromSearch, ...extra].sort((a, b) => a.name.localeCompare(b.name))
  },
}
