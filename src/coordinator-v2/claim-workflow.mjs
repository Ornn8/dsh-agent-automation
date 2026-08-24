// @ts-check

import { pathToFileURL } from 'node:url'
import { acquireTaskClaimThroughGateway } from './claim-gateway.mjs'
import { parseTaskDeclaration } from './task-policy.mjs'

const DEFAULT_API_URL = 'https://api.github.com'
const PAGE_SIZE = 100
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_COMMENT_BYTES = 16 * 1024 * 1024
const MAX_CLOSING_PULL_REQUESTS = 1_000
const MAX_CLOSING_PULL_REQUEST_PAGES = 11
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CANONICAL_REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/
const TASK_ID = /^task-[0-9a-f]{64}$/
const CLAIMANT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/

/** @typedef {import('./claim-gateway.mjs').ClaimRequest} ClaimRequest */
/** @typedef {import('./claim-gateway.mjs').ClaimGatewayConfig} ClaimGatewayConfig */
/** @typedef {import('./claim-gateway.mjs').GitHubClaimGateway} GitHubClaimGateway */
/** @typedef {import('./claim-gateway.mjs').ClaimGatewayResult} ClaimGatewayResult */
/** @typedef {Record<string, string | undefined>} WorkflowEnvironment */
/** @typedef {{ request: ClaimRequest, config: ClaimGatewayConfig, apiUrl: string, targetToken: string, controllerToken: string }} ParsedClaimWorkflowEnvironment */
/** @typedef {{ method?: string, body?: unknown }} GitHubRequestOptions */
/** @typedef {{ request: (path: string, options?: GitHubRequestOptions) => Promise<unknown> }} GitHubApiClient */
/** @typedef {{ number: unknown, state: unknown, type: 'issue' | 'pull-request', trustedAuthor: boolean, body: unknown }} RawIssueObservation */
/** @typedef {{ number: unknown, state: unknown, type: 'issue' | 'pull-request' }} RawDependencyObservation */
/** @typedef {{ repository: string, issueNumber: number, number: number, state: 'open' }} OpenPullRequestObservation */
/** @typedef {{ id: unknown, authorLogin: unknown, authorType: unknown, appSlug: unknown, body: string }} RawCommentObservation */
/** @typedef {(input: { request: ClaimRequest, config: ClaimGatewayConfig, github: GitHubClaimGateway }) => ClaimGatewayResult | Promise<ClaimGatewayResult>} ClaimAcquirer */
/** @typedef {(line: string) => unknown} ResultWriter */
/** @typedef {() => Date} Clock */

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {WorkflowEnvironment} env @param {string} name @returns {string} */
function requiredEnvironment(env, name) {
  const value = env?.[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required environment variable ${name}`)
  return value.trim()
}

/** @param {WorkflowEnvironment} env @param {string} name @returns {string} */
function exactEnvironment(env, name) {
  const value = env?.[name]
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a canonical non-empty value`)
  }
  return value
}

/** @param {unknown} value @param {string} name @returns {number} */
function positiveInteger(value, name) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`)
  return number
}

/** @param {unknown} value @param {string} name @returns {number} */
function canonicalPositiveInteger(value, name) {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a canonical positive integer`)
  }
  return positiveInteger(value, name)
}

/** @param {unknown} value @param {string} [name] @returns {string} */
function normalizeRepository(value, name = 'Repository') {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) throw new Error(`${name} must use owner/name form`)
  return value.toLowerCase()
}

/** @param {unknown} value @param {string} [name] @returns {string} */
function canonicalRepository(value, name = 'Repository') {
  if (typeof value !== 'string' || !CANONICAL_REPOSITORY.test(value)) {
    throw new Error(`${name} must use canonical lowercase owner/name form`)
  }
  return value
}

/** @param {string} repository @returns {{ owner: string, name: string }} */
function splitRepository(repository) {
  const [owner = '', name = ''] = repository.split('/')
  return { owner, name }
}

/** @param {unknown} value @returns {string} */
function normalizeApiUrl(value) {
  const candidate = value === undefined || value === null || value === '' ? DEFAULT_API_URL : value
  if (typeof candidate !== 'string') throw new Error('GitHub API URL must be one HTTPS origin')
  const url = new URL(candidate)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub API URL must be one HTTPS origin')
  }
  return url.toString().replace(/\/$/, '')
}

/** @param {WorkflowEnvironment} [env] @param {Date} [now] @returns {ParsedClaimWorkflowEnvironment} */
export function parseClaimWorkflowEnvironment(env = process.env, now = new Date()) {
  const repository = canonicalRepository(exactEnvironment(env, 'TARGET_REPOSITORY'), 'Target repository')
  const issueNumber = canonicalPositiveInteger(exactEnvironment(env, 'ISSUE_NUMBER'), 'Issue number')
  const expectedTaskId = exactEnvironment(env, 'EXPECTED_TASK_ID')
  if (!TASK_ID.test(expectedTaskId)) throw new Error('Expected task id is invalid')
  const claimant = exactEnvironment(env, 'CLAIMANT')
  if (!CLAIMANT.test(claimant)) throw new Error('Claimant identity is invalid')
  const leaseSeconds = canonicalPositiveInteger(
    exactEnvironment(env, 'CLAIM_LEASE_SECONDS'),
    'Claim lease seconds',
  )
  if (leaseSeconds < 60 || leaseSeconds > 21_600) throw new Error('Claim lease seconds must be from 60 through 21600')

  const appSlug = exactEnvironment(env, 'CLAIM_APP_SLUG')
  if (!APP_SLUG.test(appSlug) || appSlug === 'github-actions') throw new Error('Dedicated Claim App slug is invalid')
  const appLogin = exactEnvironment(env, 'CLAIM_APP_LOGIN')
  if (appLogin !== `${appSlug}[bot]`) throw new Error('Dedicated Claim App login does not match its slug')

  const controllerRepository = normalizeRepository(
    exactEnvironment(env, 'CONTROLLER_REPOSITORY'),
    'Controller repository',
  )
  const controllerWorkflowPath = exactEnvironment(env, 'CONTROLLER_WORKFLOW_PATH')
  if (!WORKFLOW_PATH.test(controllerWorkflowPath)) throw new Error('Controller workflow path is invalid')
  const controllerSha = exactEnvironment(env, 'CONTROLLER_SHA')
  if (!FULL_SHA.test(controllerSha)) throw new Error('Controller SHA must be a full lowercase revision')
  const sourceRunId = canonicalPositiveInteger(exactEnvironment(env, 'SOURCE_RUN_ID'), 'Source run id')
  const sourceRunAttempt = canonicalPositiveInteger(
    exactEnvironment(env, 'SOURCE_RUN_ATTEMPT'),
    'Source run attempt',
  )
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Observation time is invalid')

  return {
    request: { repository, issueNumber, expectedTaskId, claimant },
    config: {
      author: { login: appLogin, type: 'Bot', appSlug },
      controller: {
        repository: controllerRepository,
        workflowPath: controllerWorkflowPath,
        sha: controllerSha,
      },
      source: { runId: sourceRunId, runAttempt: sourceRunAttempt },
      now: now.toISOString(),
      leaseMs: leaseSeconds * 1_000,
    },
    apiUrl: normalizeApiUrl(env.GITHUB_API_URL || DEFAULT_API_URL),
    targetToken: requiredEnvironment(env, 'TARGET_GITHUB_TOKEN'),
    controllerToken: requiredEnvironment(env, 'CONTROLLER_GITHUB_TOKEN'),
  }
}

/** @param {string} repository @returns {string} */
function encodedRepository(repository) {
  const { owner, name } = splitRepository(repository)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** @param {unknown} data @param {string} fallback @returns {string} */
function safeMessage(data, fallback) {
  const record = objectRecord(data)
  const message = record && typeof record.message === 'string' ? record.message : fallback
  return message.slice(0, 500)
}

/** @param {{ token?: unknown, apiUrl?: unknown, fetchImpl?: unknown }} input @returns {GitHubApiClient} */
export function createGitHubApiClient({
  token,
  apiUrl = DEFAULT_API_URL,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('GitHub token is required')
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
  const origin = normalizeApiUrl(apiUrl)
  const requestFetch = /** @type {typeof globalThis.fetch} */ (fetchImpl)

  return {
    async request(path, { method = 'GET', body } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('GitHub API path is invalid')
      const response = await requestFetch(`${origin}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'dsh-agent-automation-coordinator-v2',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('GitHub API response is too large')
      /** @type {unknown} */
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch (error) {
          throw new Error(`GitHub API returned invalid JSON: ${errorMessage(error)}`, { cause: error })
        }
      }
      if (!response.ok) {
        throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${safeMessage(data, response.statusText)}`)
      }
      return data
    },
  }
}

/** @param {unknown} issue @returns {RawIssueObservation} */
function issueObservation(issue) {
  const record = objectRecord(issue)
  if (!record) throw new Error('GitHub Issue response is invalid')
  return {
    number: record.number,
    state: record.state,
    type: record.pull_request ? 'pull-request' : 'issue',
    trustedAuthor: typeof record.author_association === 'string'
      && TRUSTED_ASSOCIATIONS.has(record.author_association),
    body: record.body ?? '',
  }
}

/** @param {GitHubApiClient} client @param {string} repository @param {unknown} issue @returns {Promise<RawDependencyObservation[]>} */
async function loadDependencyObservations(client, repository, issue) {
  const issueRecord = objectRecord(issue)
  if (!issueRecord) throw new Error('GitHub Issue response is invalid')
  let task
  try {
    task = parseTaskDeclaration(issueRecord.body ?? '', { issueNumber: issueRecord.number })
  } catch {
    return []
  }
  if (!task) return []
  const encoded = encodedRepository(repository)
  return Promise.all(task.dependsOn.map(async number => {
    const dependency = objectRecord(await client.request(`/repos/${encoded}/issues/${number}`))
    return {
      number: dependency?.number,
      state: dependency?.state,
      type: dependency?.pull_request ? 'pull-request' : 'issue',
    }
  }))
}

/** @param {GitHubApiClient} client @param {string} repository @param {number} issueNumber @returns {Promise<OpenPullRequestObservation[]>} */
async function loadOpenPullRequests(client, repository, issueNumber) {
  const { owner, name } = splitRepository(repository)
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:false){nodes{number state repository{nameWithOwner}}pageInfo{hasNextPage endCursor}}}}}`
  /** @type {Map<number, OpenPullRequestObservation>} */
  const seen = new Map()
  /** @type {Set<string>} */
  const cursors = new Set()
  /** @type {string | null} */
  let cursor = null
  for (let page = 1; ; page += 1) {
    if (page > MAX_CLOSING_PULL_REQUEST_PAGES) throw new Error('Closing pull request pagination is too large')
    const result = objectRecord(await client.request('/graphql', {
      method: 'POST',
      body: { query, variables: { owner, name, number: issueNumber, cursor } },
    }))
    const errors = result?.errors
    if (Array.isArray(errors) && errors.length) {
      throw new Error(`GitHub GraphQL request failed: ${safeMessage(errors[0], 'unknown GraphQL error')}`)
    }
    const data = objectRecord(result?.data)
    const repositoryRecord = objectRecord(data?.repository)
    const issueRecord = objectRecord(repositoryRecord?.issue)
    const connection = objectRecord(issueRecord?.closedByPullRequestsReferences)
    const nodes = connection?.nodes
    const pageInfo = objectRecord(connection?.pageInfo)
    if (!connection || !Array.isArray(nodes) || !pageInfo) {
      throw new Error('GitHub closing pull request response is incomplete')
    }
    for (const pullRequest of nodes) {
      const record = objectRecord(pullRequest)
      const pullRequestRepository = objectRecord(record?.repository)
      if (record?.state !== 'OPEN'
        || typeof pullRequestRepository?.nameWithOwner !== 'string'
        || pullRequestRepository.nameWithOwner.toLowerCase() !== repository) continue
      const number = positiveInteger(record.number, 'Pull request number')
      seen.set(number, { repository, issueNumber, number, state: 'open' })
      if (seen.size > MAX_CLOSING_PULL_REQUESTS) throw new Error('Closing pull request snapshot is too large')
    }
    if (pageInfo.hasNextPage !== true) break
    if (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor) {
      throw new Error('GitHub closing pull request cursor is missing')
    }
    cursor = pageInfo.endCursor
    if (cursors.has(cursor)) throw new Error('GitHub closing pull request cursor repeated')
    cursors.add(cursor)
  }
  return [...seen.values()].sort((left, right) => left.number - right.number)
}

/** @param {unknown} comment @returns {RawCommentObservation} */
function commentObservation(comment) {
  const record = objectRecord(comment)
  const user = objectRecord(record?.user)
  const app = objectRecord(record?.performed_via_github_app)
  const body = record?.body ?? ''
  if (typeof body !== 'string') throw new Error('GitHub Issue comment body is invalid')
  return {
    id: record?.id,
    authorLogin: user?.login ?? '',
    authorType: user?.type ?? '',
    appSlug: app?.slug ?? '',
    body,
  }
}

/** @param {GitHubApiClient} client @param {string} repository @param {number} issueNumber @param {number} maxComments @returns {Promise<RawCommentObservation[]>} */
async function loadComments(client, repository, issueNumber, maxComments) {
  const encoded = encodedRepository(repository)
  /** @type {RawCommentObservation[]} */
  const comments = []
  let totalBytes = 0
  for (let page = 1; ; page += 1) {
    const data = await client.request(`/repos/${encoded}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(data)) throw new Error('GitHub Issue comments response is invalid')
    for (const raw of data) {
      const comment = commentObservation(raw)
      totalBytes += Buffer.byteLength(comment.body, 'utf8')
        + Buffer.byteLength(JSON.stringify([comment.id, comment.authorLogin, comment.authorType, comment.appSlug]), 'utf8')
      if (totalBytes > MAX_COMMENT_BYTES) throw new Error('Claim comment snapshot exceeds its byte limit')
      comments.push(comment)
      if (comments.length > maxComments) throw new Error('Claim comment snapshot exceeds its item limit')
    }
    if (data.length < PAGE_SIZE) break
  }
  return comments
}

/** @param {{ targetClient?: unknown, controllerClient?: unknown, controllerRepository?: unknown }} input @returns {GitHubClaimGateway} */
export function createClaimWorkflowGitHubAdapter({
  targetClient,
  controllerClient,
  controllerRepository,
}) {
  const targetRecord = objectRecord(targetClient)
  const controllerRecord = objectRecord(controllerClient)
  if (typeof targetRecord?.request !== 'function' || typeof controllerRecord?.request !== 'function') {
    throw new Error('GitHub API clients are required')
  }
  const target = /** @type {GitHubApiClient} */ (targetRecord)
  const controller = /** @type {GitHubApiClient} */ (controllerRecord)
  const normalizedControllerRepository = normalizeRepository(controllerRepository, 'Controller repository')

  return {
    async loadRun(runId, runAttempt) {
      const id = positiveInteger(runId, 'Run id')
      const attempt = positiveInteger(runAttempt, 'Run attempt')
      const run = objectRecord(await controller.request(
        `/repos/${encodedRepository(normalizedControllerRepository)}/actions/runs/${id}/attempts/${attempt}`,
      ))
      const runRepository = objectRecord(run?.repository)
      return {
        id: run?.id,
        runAttempt: run?.run_attempt,
        repository: runRepository?.full_name,
        controller: {
          repository: runRepository?.full_name,
          workflowPath: run?.path,
          sha: run?.head_sha,
        },
      }
    },

    async readTaskSnapshot({ repository, issueNumber, maxComments }) {
      const normalizedRepository = normalizeRepository(repository, 'Target repository')
      const encoded = encodedRepository(normalizedRepository)
      const issue = await target.request(`/repos/${encoded}/issues/${positiveInteger(issueNumber, 'Issue number')}`)
      const [dependencies, openPullRequests, comments] = await Promise.all([
        loadDependencyObservations(target, normalizedRepository, issue),
        loadOpenPullRequests(target, normalizedRepository, issueNumber),
        loadComments(target, normalizedRepository, issueNumber, positiveInteger(maxComments, 'Maximum comments')),
      ])
      return {
        issue: issueObservation(issue),
        dependencies,
        openPullRequests,
        comments,
        commentsComplete: true,
      }
    },

    async createComment({ repository, issueNumber, body }) {
      const result = objectRecord(await target.request(
        `/repos/${encodedRepository(normalizeRepository(repository))}/issues/${positiveInteger(issueNumber, 'Issue number')}/comments`,
        { method: 'POST', body: { body } },
      ))
      return { id: result?.id }
    },

    async updateComment({ repository, commentId, body }) {
      const result = objectRecord(await target.request(
        `/repos/${encodedRepository(normalizeRepository(repository))}/issues/comments/${positiveInteger(commentId, 'Comment id')}`,
        { method: 'PATCH', body: { body } },
      ))
      return { id: result?.id }
    },
  }
}

/** @param {{ env?: WorkflowEnvironment, fetchImpl?: typeof globalThis.fetch, clock?: Clock, acquire?: ClaimAcquirer, write?: ResultWriter, }} [options] @returns {Promise<ClaimGatewayResult>} */
export async function runClaimWorkflow({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  acquire = acquireTaskClaimThroughGateway,
  write = line => process.stdout.write(`${line}\n`),
} = {}) {
  const parsed = parseClaimWorkflowEnvironment(env, clock())
  const targetClient = createGitHubApiClient({ token: parsed.targetToken, apiUrl: parsed.apiUrl, fetchImpl })
  const controllerClient = createGitHubApiClient({ token: parsed.controllerToken, apiUrl: parsed.apiUrl, fetchImpl })
  const github = createClaimWorkflowGitHubAdapter({
    targetClient,
    controllerClient,
    controllerRepository: parsed.config.controller.repository,
  })
  const result = await acquire({ request: parsed.request, config: parsed.config, github })
  write(`COORDINATOR_V2_CLAIM_RESULT=${JSON.stringify(result)}`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runClaimWorkflow()
  if (result.status === 'blocked') process.exitCode = 1
}
