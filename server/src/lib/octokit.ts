import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'

const StarspectOctokit = Octokit.plugin(throttling)

const MAX_RATE_LIMIT_RETRIES = 2

export const createOctokit = (token: string) =>
  new StarspectOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`Rate limit hit for ${options.method} ${options.url}`)
        if (retryCount < MAX_RATE_LIMIT_RETRIES && retryAfter <= 15) {
          return true
        }
        return false
      },
      onSecondaryRateLimit: () => false,
    },
  })
