import { reviewMarker } from './review-authority.mjs'

const GITHUB_ACTIONS_APP_ID = 15368
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const MAX_RESPONSE_COUNT = 3
const MAX_RESPONSE_LENGTH = 4_000

function repositoryRunUrl(value, repository) {
  try {
    const url = new URL(value)
    const prefix = `/${repository}/`
    return url.origin === 'https://github.com'
      && url.pathname.startsWith(prefix)
      && (/^actions\/runs\/\d+(?:\/.*)?$/.test(url.pathname.slice(prefix.length))
        || /^runs\/\d+(?:\/.*)?$/.test(url.pathname.slice(prefix.length)))
  } catch {
    return false
  }
}

function boundedBody(value) {
  return String(value || '').replaceAll('\0', '').slice(0, MAX_RESPONSE_LENGTH).trim()
}

function matchingReviewMarker(body, head) {
  const primary = reviewMarker(head)
  if (body.includes(primary)) return primary
  return body.match(new RegExp(`<!-- [a-z][a-z0-9-]{0,31}-review:${head} -->`))?.[0] || null
}

/** Build bounded, non-authoritative review context from controller-verified GitHub metadata. */
export function reviewObservations({ repository, head, checkRuns, comments }) {
  if (!Array.isArray(checkRuns?.check_runs)
    || !Number.isSafeInteger(checkRuns.total_count)
    || checkRuns.total_count > checkRuns.check_runs.length) {
    throw new Error('Exact-head check snapshot is incomplete')
  }
  if (!Array.isArray(comments)) throw new Error('Pull request comment snapshot is invalid')

  const latestChecks = new Map()
  for (const check of checkRuns.check_runs) {
    if (check?.app?.id !== GITHUB_ACTIONS_APP_ID
      || check.head_sha !== head
      || check.status !== 'completed'
      || !Number.isSafeInteger(check.id)
      || typeof check.name !== 'string'
      || !check.name.trim()
      || typeof check.conclusion !== 'string'
      || !repositoryRunUrl(check.details_url, repository)) continue
    const prior = latestChecks.get(check.name)
    if (!prior || check.id > prior.id) latestChecks.set(check.name, check)
  }

  const priorReviewComment = comments
    .filter(comment => comment?.user?.login === 'github-actions[bot]'
      && typeof comment.body === 'string'
      && matchingReviewMarker(comment.body, head))
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .at(-1)
  const priorCreatedAt = priorReviewComment?.created_at
  const priorMarker = priorReviewComment ? matchingReviewMarker(priorReviewComment.body, head) : null
  const priorReview = priorReviewComment
    ? boundedBody(priorReviewComment.body.replace(priorMarker, ''))
    : null
  const reviewResponses = priorCreatedAt
    ? comments
      .filter(comment => TRUSTED_ASSOCIATIONS.has(comment?.author_association)
        && String(comment.created_at) > String(priorCreatedAt)
        && boundedBody(comment.body))
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .slice(-MAX_RESPONSE_COUNT)
      .map(comment => ({
        authorAssociation: comment.author_association,
        body: boundedBody(comment.body),
      }))
    : []

  return {
    version: 1,
    exactHeadChecks: [...latestChecks.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(check => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.details_url,
      })),
    priorReview,
    reviewResponses,
  }
}
