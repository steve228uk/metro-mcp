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

export default {
  async load(): Promise<CommunityPlugin[]> {
    const res = await fetch(
      'https://registry.npmjs.org/-/v1/search?text=metro-mcp-plugin&size=100',
    )

    if (!res.ok) {
      throw new Error(`npm registry error: ${res.status}`)
    }

    const { objects } = await res.json()

    return objects
      .map((o: any) => o.package)
      .filter(
        (p: any) =>
          p.name.startsWith('metro-mcp-plugin-') &&
          !PLUGIN_BLACKLIST.includes(p.name),
      )
      .map((p: any) => {
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
      })
  },
}
