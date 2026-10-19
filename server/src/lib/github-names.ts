const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

export type GithubRepositoryRef = {
  owner: string
  repo: string
  cacheKey: string
}

export const validateGithubOwner = (owner: string): boolean => GITHUB_OWNER_PATTERN.test(owner)

export const validateGithubRepo = (repo: string): boolean => {
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    return false
  }
  if (repo === '.' || repo === '..') {
    return false
  }
  return true
}

export const normalizeGithubRepository = (
  ownerInput: string,
  repoInput: string,
): GithubRepositoryRef | { error: string } => {
  const owner = ownerInput.trim()
  const repo = repoInput.trim()

  if (!owner || !repo) {
    return { error: 'Owner and repo are required' }
  }

  if (!validateGithubOwner(owner)) {
    return { error: 'Owner is invalid' }
  }

  if (!validateGithubRepo(repo)) {
    return { error: 'Repo is invalid' }
  }

  const ownerLower = owner.toLowerCase()
  const repoLower = repo.toLowerCase()

  return {
    owner: ownerLower,
    repo: repoLower,
    cacheKey: `${ownerLower}/${repoLower}`,
  }
}
