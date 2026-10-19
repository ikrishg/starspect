import packageJson from '../../../package.json'

export const STARSPECT_STAR_TARGET = {
  owner: 'ikrishg',
  repo: 'starspect',
} as const

const githubRestHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': `starspect/${packageJson.version} (Cloudflare Worker; +https://github.com/ikrishg/starspect)`,
})

export async function putGitHubStar(accessToken: string) {
  const { owner, repo } = STARSPECT_STAR_TARGET
  const response = await fetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
    method: 'PUT',
    headers: githubRestHeaders(accessToken),
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`GitHub star failed (${response.status}): ${details.slice(0, 300)}`)
  }
}
