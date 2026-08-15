import { run } from './common.mjs'
import { githubJson, githubPages } from './supervision-github.mjs'

function clip(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated by repository supervisor]`
}

function labelsOf(value) {
  return Array.isArray(value?.labels) ? value.labels.map(label => label.name).filter(Boolean) : []
}

function compactComment(comment) {
  return {
    id: comment.id,
    user: comment.user?.login || '',
    body: clip(comment.body, 8_000),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  }
}

function compactReviewComment(comment) {
  return {
    ...compactComment(comment),
    reviewId: comment.pull_request_review_id,
    replyToId: comment.in_reply_to_id,
    commitId: comment.commit_id,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    startLine: comment.start_line,
    startSide: comment.start_side,
  }
}

function compactIssue(issue, comments) {
  return {
    number: issue.number,
    title: clip(issue.title, 500),
    body: clip(issue.body, 30_000),
    state: issue.state,
    stateReason: issue.state_reason,
    labels: labelsOf(issue),
    authorAssociation: issue.author_association,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    url: issue.html_url,
    comments: (comments || []).map(compactComment),
  }
}

function compactRun(run) {
  return {
    id: run.id,
    workflowName: run.name,
    path: run.path,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
  }
}

function compactCheck(check) {
  return {
    id: check.id,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    startedAt: check.started_at,
    completedAt: check.completed_at,
    url: check.html_url || check.details_url,
  }
}

function compactReview(review) {
  return {
    id: review.id,
    user: review.user?.login || '',
    state: review.state,
    body: clip(review.body, 8_000),
    commitId: review.commit_id,
    submittedAt: review.submitted_at,
    url: review.html_url,
  }
}

function compactFile(file) {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: clip(file.patch, 12_000),
  }
}

function compactCommit(commit) {
  return {
    sha: commit.sha,
    message: clip(commit.commit?.message, 1_000),
    authorDate: commit.commit?.author?.date,
    committerDate: commit.commit?.committer?.date,
    url: commit.html_url,
  }
}

function uniqueByNumber(...lists) {
  const values = new Map()
  for (const list of lists) {
    for (const value of list || []) if (!values.has(value.number)) values.set(value.number, value)
  }
  return [...values.values()]
}

function issueIdentity(issue) {
  return JSON.stringify({
    state: issue.state,
    stateReason: issue.state_reason,
    updatedAt: issue.updated_at,
    title: issue.title,
    body: issue.body,
    labels: labelsOf(issue).sort(),
  })
}

function assertStableIssue(before, after) {
  if (issueIdentity(before) !== issueIdentity(after)) {
    throw new Error(`Issue #${before.number} changed while its exact audit state was being collected`)
  }
}

function pullRequestIdentity(pullRequest) {
  return JSON.stringify({
    state: pullRequest.state,
    draft: Boolean(pullRequest.draft),
    updatedAt: pullRequest.updated_at,
    mergedAt: pullRequest.merged_at,
    closedAt: pullRequest.closed_at,
    title: pullRequest.title,
    body: pullRequest.body,
    labels: labelsOf(pullRequest).sort(),
    headRef: pullRequest.head?.ref,
    headSha: pullRequest.head?.sha,
    baseRef: pullRequest.base?.ref,
    baseSha: pullRequest.base?.sha,
  })
}

function assertStablePullRequest(before, after) {
  if (pullRequestIdentity(before) !== pullRequestIdentity(after)) {
    throw new Error(`Pull request #${before.number} changed while its exact audit state was being collected`)
  }
}

async function loadAuditedIssue({ repository, number, config, environment }) {
  const before = await githubJson({
    config,
    environment,
    path: `repos/${repository}/issues/${number}`,
    description: `Issue #${number} exact state`,
  })
  if (before.pull_request) throw new Error(`Issue #${number} unexpectedly resolved to a pull request`)
  const comments = await githubPages({
    config,
    environment,
    path: `repos/${repository}/issues/${number}/comments?per_page=100`,
    description: `Issue #${number} comments`,
  })
  const after = await githubJson({
    config,
    environment,
    path: `repos/${repository}/issues/${number}`,
    description: `Issue #${number} stability check`,
  })
  assertStableIssue(before, after)
  return compactIssue(after, comments)
}

async function loadIssues({ repository, config, environment, rawIssues }) {
  const compact = []
  let recentClosed = 0
  for (const listedIssue of rawIssues.filter(issue => !issue.pull_request)) {
    const exactAudit = listedIssue.state === 'open' || recentClosed < 20
    if (listedIssue.state === 'closed') recentClosed += 1
    compact.push(exactAudit
      ? await loadAuditedIssue({ repository, number: listedIssue.number, config, environment })
      : compactIssue(listedIssue, []))
  }
  return compact
}

async function loadOpenPullRequest({ repository, number, config, environment }) {
  const before = await githubJson({
    config,
    environment,
    path: `repos/${repository}/pulls/${number}`,
    description: `pull request #${number} exact state`,
  })
  if (before.state !== 'open') {
    throw new Error(`Pull request #${number} stopped being open while its audit state was being collected`)
  }
  const headSha = before.head.sha
  const [comments, reviewComments, reviews, files, checkRuns, workflowRuns] = await Promise.all([
    githubPages({ config, environment, path: `repos/${repository}/issues/${number}/comments`, description: `pull request #${number} comments` }),
    githubPages({ config, environment, path: `repos/${repository}/pulls/${number}/comments`, description: `pull request #${number} inline review comments` }),
    githubPages({ config, environment, path: `repos/${repository}/pulls/${number}/reviews`, description: `pull request #${number} reviews` }),
    githubPages({ config, environment, path: `repos/${repository}/pulls/${number}/files`, description: `pull request #${number} files` }),
    githubPages({
      config,
      environment,
      path: `repos/${repository}/commits/${headSha}/check-runs`,
      description: `pull request #${number} checks`,
      headers: ['Accept: application/vnd.github+json'],
      collection: 'check_runs',
    }),
    githubPages({
      config,
      environment,
      path: `repos/${repository}/actions/runs?head_sha=${encodeURIComponent(headSha)}`,
      description: `pull request #${number} workflow runs`,
      collection: 'workflow_runs',
    }),
  ])
  const after = await githubJson({
    config,
    environment,
    path: `repos/${repository}/pulls/${number}`,
    description: `pull request #${number} stability check`,
  })
  assertStablePullRequest(before, after)
  return {
    pullRequest: after,
    comments,
    reviewComments,
    reviews,
    files,
    checkRuns,
    workflowRuns,
  }
}

async function loadPullRequests({ repository, config, environment, rawPullRequests }) {
  const compact = []
  for (const listedPullRequest of rawPullRequests) {
    let pullRequest = listedPullRequest
    let comments = []
    let reviewComments = []
    let reviews = []
    let files = []
    let checkRuns = { check_runs: [] }
    let workflowRuns = { workflow_runs: [] }
    if (listedPullRequest.state === 'open') {
      ({ pullRequest, comments, reviewComments, reviews, files, checkRuns, workflowRuns } = await loadOpenPullRequest({
        repository,
        number: listedPullRequest.number,
        config,
        environment,
      }))
    }
    compact.push({
      number: pullRequest.number,
      title: clip(pullRequest.title, 500),
      body: clip(pullRequest.body, 30_000),
      state: pullRequest.state,
      draft: Boolean(pullRequest.draft),
      mergedAt: pullRequest.merged_at,
      closedAt: pullRequest.closed_at,
      createdAt: pullRequest.created_at,
      updatedAt: pullRequest.updated_at,
      labels: labelsOf(pullRequest),
      head: { ref: pullRequest.head.ref, sha: pullRequest.head.sha },
      base: { ref: pullRequest.base.ref, sha: pullRequest.base.sha },
      url: pullRequest.html_url,
      comments: comments.map(compactComment),
      reviewComments: reviewComments.map(compactReviewComment),
      reviews: reviews.map(compactReview),
      files: files.map(compactFile),
      checks: (checkRuns.check_runs || []).map(compactCheck),
      runs: (workflowRuns.workflow_runs || []).map(compactRun),
    })
  }
  return compact
}

async function readDefaultBranches({ repository, upstreamRepository, defaultBranch, upstreamDefaultBranch, config, environment }) {
  return Promise.all([
    githubJson({ config, environment, path: `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`, description: 'target default branch' }),
    githubJson({ config, environment, path: `repos/${upstreamRepository}/branches/${encodeURIComponent(upstreamDefaultBranch)}`, description: 'upstream default branch' }),
  ])
}

/** Build one bounded snapshot whose default branches, Issues, and open pull request pairs stayed stable during collection. */
export async function buildRepositorySnapshot({
  repository,
  upstreamRepository,
  targetCheckout,
  config,
  environment,
  controller,
}) {
  const [targetRepo, upstreamRepo] = await Promise.all([
    githubJson({ config, environment, path: `repos/${repository}`, description: 'target repository' }),
    githubJson({ config, environment, path: `repos/${upstreamRepository}`, description: 'upstream repository' }),
  ])
  const defaultBranch = targetRepo.default_branch
  const upstreamDefaultBranch = upstreamRepo.default_branch
  const [targetBranch, upstreamBranch] = await readDefaultBranches({
    repository,
    upstreamRepository,
    defaultBranch,
    upstreamDefaultBranch,
    config,
    environment,
  })

  const checkedOutHead = (await run(config.gitExecutable, ['-C', targetCheckout, 'rev-parse', 'HEAD'])).stdout.trim()
  if (checkedOutHead !== targetBranch.commit.sha) {
    throw new Error(`Target checkout is ${checkedOutHead}, but ${defaultBranch} is ${targetBranch.commit.sha}`)
  }

  const upstreamRef = 'refs/remotes/repository-supervision/upstream'
  await run(config.gitExecutable, [
    '-C', targetCheckout,
    'fetch', '--force', '--no-tags', '--no-recurse-submodules',
    `https://github.com/${upstreamRepository}.git`,
    `+refs/heads/${upstreamDefaultBranch}:${upstreamRef}`,
  ])
  const fetchedUpstreamHead = (await run(config.gitExecutable, ['-C', targetCheckout, 'rev-parse', upstreamRef])).stdout.trim()
  if (fetchedUpstreamHead !== upstreamBranch.commit.sha) {
    throw new Error(`Fetched upstream is ${fetchedUpstreamHead}, expected ${upstreamBranch.commit.sha}`)
  }
  const [aheadText, behindText] = (await run(config.gitExecutable, [
    '-C', targetCheckout, 'rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`,
  ])).stdout.trim().split(/\s+/)
  const mergeBase = (await run(config.gitExecutable, ['-C', targetCheckout, 'merge-base', 'HEAD', upstreamRef])).stdout.trim()
  const forkDiffStat = (await run(config.gitExecutable, ['-C', targetCheckout, 'diff', '--stat', `${upstreamRef}...HEAD`])).stdout.trim()

  const [openIssues, recentClosedIssues, openPullRequests, recentClosedPullRequests, rawRuns, rawLabels, targetCommits, upstreamCommits, branches] = await Promise.all([
    githubPages({ config, environment, path: `repos/${repository}/issues?state=open&sort=updated&direction=desc`, description: 'open Issues' }),
    githubJson({ config, environment, path: `repos/${repository}/issues?state=closed&per_page=40&sort=updated&direction=desc`, description: 'recent closed Issues' }),
    githubPages({ config, environment, path: `repos/${repository}/pulls?state=open&sort=updated&direction=desc`, description: 'open pull requests' }),
    githubJson({ config, environment, path: `repos/${repository}/pulls?state=closed&per_page=40&sort=updated&direction=desc`, description: 'recent closed pull requests' }),
    githubPages({ config, environment, path: `repos/${repository}/actions/runs`, description: 'workflow runs', collection: 'workflow_runs' }),
    githubPages({ config, environment, path: `repos/${repository}/labels`, description: 'labels' }),
    githubJson({ config, environment, path: `repos/${repository}/commits?per_page=30`, description: 'target commits' }),
    githubJson({ config, environment, path: `repos/${upstreamRepository}/commits?sha=${encodeURIComponent(upstreamDefaultBranch)}&per_page=30`, description: 'upstream commits' }),
    githubPages({ config, environment, path: `repos/${repository}/branches`, description: 'branches' }),
  ])
  const rawIssues = uniqueByNumber(openIssues, recentClosedIssues)
  const rawPullRequests = uniqueByNumber(openPullRequests, recentClosedPullRequests)
  const [issues, pullRequests] = await Promise.all([
    loadIssues({ repository, config, environment, rawIssues }),
    loadPullRequests({ repository, config, environment, rawPullRequests }),
  ])
  const [finalTargetBranch, finalUpstreamBranch] = await readDefaultBranches({
    repository,
    upstreamRepository,
    defaultBranch,
    upstreamDefaultBranch,
    config,
    environment,
  })
  if (finalTargetBranch.commit.sha !== targetBranch.commit.sha) {
    throw new Error(`Target default branch changed from ${targetBranch.commit.sha} to ${finalTargetBranch.commit.sha} during snapshot collection`)
  }
  if (finalUpstreamBranch.commit.sha !== upstreamBranch.commit.sha) {
    throw new Error(`Upstream default branch changed from ${upstreamBranch.commit.sha} to ${finalUpstreamBranch.commit.sha} during snapshot collection`)
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repository,
    defaultBranch,
    headSha: targetBranch.commit.sha,
    upstream: {
      repository: upstreamRepository,
      defaultBranch: upstreamDefaultBranch,
      headSha: upstreamBranch.commit.sha,
      gitRef: upstreamRef,
      mergeBase,
      ahead: Number.parseInt(aheadText, 10),
      behind: Number.parseInt(behindText, 10),
      forkDiffStat: clip(forkDiffStat, 20_000),
      recentCommits: upstreamCommits.map(compactCommit),
    },
    recentCommits: targetCommits.map(compactCommit),
    branches: branches.map(branch => ({ name: branch.name, sha: branch.commit?.sha, protected: Boolean(branch.protected) })),
    labels: rawLabels.map(label => label.name),
    issues,
    pullRequests,
    runs: (rawRuns.workflow_runs || []).map(compactRun),
    controller,
  }
}
