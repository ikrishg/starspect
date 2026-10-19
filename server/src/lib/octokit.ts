import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'

const StarspectOctokit = Octokit.plugin(throttling)

export const createOctokit = (token: string) =>
  new StarspectOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(`Rate limit hit for ${options.method} ${options.url}`)
        if (retryAfter <= 15) {
          return true
        }
        return false
      },
      onSecondaryRateLimit: () => false,
    },
  })
