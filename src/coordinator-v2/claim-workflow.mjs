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
const TASK_ID = /^task-[0-9a-f]{64}$/
const CLAIMANT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/

function requiredEnvironment(env, name) {
  const value = env?.[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required environment variable ${name}`)
  return value.trim()
}

function positiveInteger(value, name) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`)
  return number
}

function normalizeRepository(value, name = 'Repository') {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) throw new Error(`${name} must use owner/name form`)
  return value.toLowerCase()
}

function splitRepository(repository) {
  const [owner, name] = repository.split('/')
  return { owner, name }
}

function normalizeApiUrl(value) {
  const url = new URL(value || DEFAULT_API_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub API URL must be one HTTPS origin')
  }
  return url.toString().replace(/\/$/, '')
}

export function parseClaimWorkflowEnvironment(env = process.env, now = new Date()) {
  const repository = normalizeRepository(requiredEnvironment(env, 'TARGET_REPOSITORY'), 'Target repository')
  const issueNumber = positiveInteger(requiredEnvironment(env, 'ISSUE_NUMBER'), 'Issue number')
  const expectedTaskId = requiredEnvironment(env, 'EXPECTED_TASK_ID')
  if (!TASK_ID.test(expectedTaskId)) throw new Error('Expected task id is invalid')
  const claimant = requiredEnvironment(env, 'CLAIMANT')
  if (!CLAIMANT.test(claimant)) throw new Error('Claimant identity is invalid')
  const leaseSeconds = positiveInteger(requiredEnvironment(env, 'CLAIM_LEASE_SECONDS'), 'Claim lease seconds')
  if (leaseSeconds < 60 || leaseSeconds > 21_600) throw new Error('Claim lease seconds must be from 60 through 21600')

  const appSlug = requiredEnvironment(env, 'CLAIM_APP_SLUG')
  if (!APP_SLUG.test(appSlug) || appSlug === 'github-actions') throw new Error('Dedicated Claim App slug is invalid')
  const appLogin = requiredEnvironment(env, 'CLAIM_APP_LOGIN')
  if (appLogin !== `${appSlug}[bot]`) throw new Error('Dedicated Claim App login does not match its slug')

  const controllerRepository = normalizeRepository(
    requiredEnvironment(env, 'CONTROLLER_REPOSITORY'),
    'Controller repository',
  )
  const controllerWorkflowPath = requiredEnvironment(env, 'CONTROLLER_WORKFLOW_PATH')
  if (!WORKFLOW_PATH.test(controllerWorkflowPath)) throw new Error('Controller workflow path is invalid')
  const controllerSha = requiredEnvironment(env, 'CONTROLLER_SHA')
  if (!FULL_SHA.test(controllerSha)) throw new Error('Controller SHA must be a full lowercase revision')
  const sourceRunId = positiveInteger(requiredEnvironment(env, 'SOURCE_RUN_ID'), 'Source run id')
  const sourceRunAttempt = positiveInteger(requiredEnvironment(env, 'SOURCE_RUN_ATTEMPT'), 'Source run attempt')
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

function encodedRepository(repository) {
  const { owner, name } = splitRepository(repository)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function safeMessage(data, fallback) {
  const message = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : fallback
  return message.slice(0, 500)
}

export function createGitHubApiClient({ token, apiUrl = DEFAULT_API_URL, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('GitHub token is required')
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
  const origin = normalizeApiUrl(apiUrl)

  return {
    async request(path, { method = 'GET', body } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('GitHub API path is invalid')
      const response = await fetchImpl(`${origin}${path}`, {
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
      let data = null
      if (text) {
        try { data = JSON.parse(text) } catch (error) {
          throw new Error(`GitHub API returned invalid JSON: ${error.message}`, { cause: error })
        }
      }
      if (!response.ok) {
        throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${safeMessage(data, response.statusText)}`)
      }
      return data
    },
  }
}

function issueObservation(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('GitHub Issue response is invalid')
  return {
    number: issue.number,
    state: issue.state,
    type: issue.pull_request ? 'pull-request' : 'issue',
    trustedAuthor: TRUSTED_ASSOCIATIONS.has(issue.author_association),
    body: issue.body ?? '',
  }
}

async function loadDependencyObservations(client, repository, issue) {
  let task
  try { task = parseTaskDeclaration(issue.body ?? '', { issueNumber: issue.number }) } catch { return [] }
  if (!task) return []
  const encoded = encodedRepository(repository)
  return Promise.all(task.dependsOn.map(async number => {
    const dependency = await client.request(`/repos/${encoded}/issues/${number}`)
    return {
      number: dependency.number,
      state: dependency.state,
      type: dependency.pull_request ? 'pull-request' : 'issue',
    }
  }))
}

async function loadOpenPullRequests(client, repository, issueNumber) {
  const { owner, name } = splitRepository(repository)
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:false){nodes{number state repository{nameWithOwner}}pageInfo{hasNextPage endCursor}}}}}`
  const seen = new Map()
  const cursors = new Set()
  let cursor = null
  for (let page = 1; ; page += 1) {
    if (page > MAX_CLOSING_PULL_REQUEST_PAGES) throw new Error('Closing pull request pagination is too large')
    const result = await client.request('/graphql', {
      method: 'POST',
      body: { query, variables: { owner, name, number: issueNumber, cursor } },
    })
    if (Array.isArray(result?.errors) && result.errors.length) {
      throw new Error(`GitHub GraphQL request failed: ${safeMessage(result.errors[0], 'unknown GraphQL error')}`)
    }
    const connection = result?.data?.repository?.issue?.closedByPullRequestsReferences
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new Error('GitHub closing pull request response is incomplete')
    }
    for (const pullRequest of connection.nodes) {
      if (pullRequest?.state !== 'OPEN'
        || pullRequest?.repository?.nameWithOwner?.toLowerCase() !== repository) continue
      const number = positiveInteger(pullRequest.number, 'Pull request number')
      seen.set(number, { repository, issueNumber, number, state: 'open' })
      if (seen.size > MAX_CLOSING_PULL_REQUESTS) throw new Error('Closing pull request snapshot is too large')
    }
    if (connection.pageInfo.hasNextPage !== true) break
    if (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor) {
      throw new Error('GitHub closing pull request cursor is missing')
    }
    cursor = connection.pageInfo.endCursor
    if (cursors.has(cursor)) throw new Error('GitHub closing pull request cursor repeated')
    cursors.add(cursor)
  }
  return [...seen.values()].sort((left, right) => left.number - right.number)
}

function commentObservation(comment) {
  return {
    id: comment?.id,
    authorLogin: comment?.user?.login ?? '',
    authorType: comment?.user?.type ?? '',
    appSlug: comment?.performed_via_github_app?.slug ?? '',
    body: comment?.body ?? '',
  }
}

async function loadComments(client, repository, issueNumber, maxComments) {
  const encoded = encodedRepository(repository)
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

export function createClaimWorkflowGitHubAdapter({ targetClient, controllerClient, controllerRepository }) {
  if (!targetClient?.request || !controllerClient?.request) throw new Error('GitHub API clients are required')
  const normalizedControllerRepository = normalizeRepository(controllerRepository, 'Controller repository')

  return {
    async loadRun(runId) {
      const run = await controllerClient.request(
        `/repos/${encodedRepository(normalizedControllerRepository)}/actions/runs/${positiveInteger(runId, 'Run id')}`,
      )
      return {
        id: run?.id,
        runAttempt: run?.run_attempt,
        repository: run?.repository?.full_name,
        controller: {
          repository: run?.repository?.full_name,
          workflowPath: run?.path,
          sha: run?.head_sha,
        },
      }
    },

    async readTaskSnapshot({ repository, issueNumber, maxComments }) {
      const normalizedRepository = normalizeRepository(repository, 'Target repository')
      const encoded = encodedRepository(normalizedRepository)
      const issue = await targetClient.request(`/repos/${encoded}/issues/${positiveInteger(issueNumber, 'Issue number')}`)
      const [dependencies, openPullRequests, comments] = await Promise.all([
        loadDependencyObservations(targetClient, normalizedRepository, issue),
        loadOpenPullRequests(targetClient, normalizedRepository, issueNumber),
        loadComments(targetClient, normalizedRepository, issueNumber, positiveInteger(maxComments, 'Maximum comments')),
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
      const result = await targetClient.request(
        `/repos/${encodedRepository(normalizeRepository(repository))}/issues/${positiveInteger(issueNumber, 'Issue number')}/comments`,
        { method: 'POST', body: { body } },
      )
      return { id: result?.id }
    },

    async updateComment({ repository, commentId, body }) {
      const result = await targetClient.request(
        `/repos/${encodedRepository(normalizeRepository(repository))}/issues/comments/${positiveInteger(commentId, 'Comment id')}`,
        { method: 'PATCH', body: { body } },
      )
      return { id: result?.id }
    },
  }
}

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
  if (result?.status === 'blocked') process.exitCode = 1
}
