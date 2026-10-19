export type CheckBody = {
  owner: string
  repo: string
}

export const parseCheckBody = (body: unknown): { ok: true; value: CheckBody } | { ok: false; error: string } => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object with string owner and repo' }
  }

  const record = body as Record<string, unknown>
  const { owner, repo } = record

  if (typeof owner !== 'string' || typeof repo !== 'string') {
    return { ok: false, error: 'Request body must be a JSON object with string owner and repo' }
  }

  return { ok: true, value: { owner, repo } }
}
