/** Return whether the pull request head contains the current default-branch commit. */
export function needsDefaultBranchUpdate({ defaultBranch, defaultBranchHead, mergeBaseSha, pullRequest }) {
  return pullRequest.base?.ref === defaultBranch
    && mergeBaseSha !== defaultBranchHead
}

/** Return whether a default-branch change requires a fresh exact-pair review. */
export function needsExactReview({ repository, defaultBranch, pullRequest, reviewProof }) {
  if (pullRequest.draft
    || pullRequest.base?.ref !== defaultBranch
    || pullRequest.head?.repo?.full_name !== repository) return false
  return reviewProof?.base !== pullRequest.base.sha
    || reviewProof?.head !== pullRequest.head.sha
    || !['pass', 'block'].includes(reviewProof?.state)
}
