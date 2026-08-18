/** Return whether the pull request head contains the current default-branch commit. */
export function needsDefaultBranchUpdate({ defaultBranch, defaultBranchHead, mergeBaseSha, pullRequest }) {
  return pullRequest.base?.ref === defaultBranch
    && mergeBaseSha !== defaultBranchHead
}

/** Return the Governor transition for one exact default-branch target. */
export function baseReconcileTransition(defaultBranchHead) {
  if (!/^[0-9a-f]{40}$/i.test(defaultBranchHead || '')) {
    throw new Error('Default-branch head must be a full commit SHA')
  }
  return `base-reconcile:${defaultBranchHead.toLowerCase()}`
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
