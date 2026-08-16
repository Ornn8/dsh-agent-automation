const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_*.-]+$/

function object(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${name} has unknown field ${key}`)
  return value
}

function required(value, fields, name) {
  for (const field of fields) if (!Object.hasOwn(value, field)) throw new Error(`${name} is missing ${field}`)
}

function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} must be a bounded identifier`)
  return value
}

function ids(value, name, maximum = 32) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`${name} must be a non-empty bounded array`)
  const result = value.map((item, index) => id(item, `${name}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${name} must be unique`)
  return result
}

function names(value, name, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 128 || /[\r\n]/.test(item))) {
    throw new Error(`${name} must contain bounded one-line names`)
  }
  const result = value.map(item => item.trim())
  if (new Set(result).size !== result.length) throw new Error(`${name} must be unique`)
  return result
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be from ${minimum} to ${maximum}`)
  return value
}

function paths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
    || value.some(path => typeof path !== 'string' || !SAFE_PATH.test(path))) {
    throw new Error('maintenance repair.allowedPaths must contain safe repository-relative globs')
  }
  if (new Set(value).size !== value.length) throw new Error('maintenance repair.allowedPaths must be unique')
  return [...value].sort()
}

/** Strictly validate the editable Controller maintenance Profile. */
export function parseMaintenanceProfile(value) {
  const root = object(value, 'Maintenance Profile', [
    'version', 'profileId', 'deterministic', 'repair', 'review', 'checks',
    'promotion', 'verification', 'resume', 'limits',
  ])
  required(root, ['version', 'profileId', 'deterministic', 'repair', 'review', 'checks', 'promotion', 'verification', 'resume', 'limits'], 'Maintenance Profile')
  if (root.version !== 1) throw new Error('Maintenance Profile version must be 1')

  const deterministic = object(root.deterministic, 'maintenance deterministic', ['actions', 'limit', 'backoffSeconds'])
  required(deterministic, ['actions', 'limit', 'backoffSeconds'], 'maintenance deterministic')
  const actions = ids(deterministic.actions, 'maintenance deterministic.actions', 16)
  const deterministicLimit = integer(deterministic.limit, 'maintenance deterministic.limit', 1, 10)
  if (!Array.isArray(deterministic.backoffSeconds) || deterministic.backoffSeconds.length !== deterministicLimit
    || deterministic.backoffSeconds.some(value => !Number.isSafeInteger(value) || value < 1 || value > 86_400)) {
    throw new Error('maintenance deterministic.backoffSeconds must match its limit')
  }

  const repair = object(root.repair, 'maintenance repair', ['procedure', 'allowedPaths', 'maxPullRequestsPerEpoch', 'failoverBackoffSeconds'])
  required(repair, ['procedure', 'allowedPaths', 'maxPullRequestsPerEpoch', 'failoverBackoffSeconds'], 'maintenance repair')
  const review = object(root.review, 'maintenance review', ['procedure', 'required', 'hardReadOnly'])
  required(review, ['procedure', 'required', 'hardReadOnly'], 'maintenance review')
  if (review.required !== true || review.hardReadOnly !== true) throw new Error('maintenance review cannot disable independent hard read-only review')
  const checks = object(root.checks, 'maintenance checks', ['workflowNames', 'requiredChecks', 'waitMinutes'])
  required(checks, ['workflowNames', 'requiredChecks', 'waitMinutes'], 'maintenance checks')
  const promotion = object(root.promotion, 'maintenance promotion', ['mode', 'limitPerEpoch'])
  required(promotion, ['mode', 'limitPerEpoch'], 'maintenance promotion')
  if (promotion.mode !== 'fault-bound' || promotion.limitPerEpoch !== 1) throw new Error('maintenance promotion must be one fault-bound release per epoch')
  const verification = object(root.verification, 'maintenance verification', ['procedure', 'healthySamples'])
  required(verification, ['procedure', 'healthySamples'], 'maintenance verification')
  const resume = object(root.resume, 'maintenance resume', ['procedure'])
  required(resume, ['procedure'], 'maintenance resume')
  const limits = object(root.limits, 'maintenance limits', ['maxEpochsPer24Hours', 'maintenanceWorkerAttemptsPerEpoch', 'concurrency'])
  required(limits, ['maxEpochsPer24Hours', 'maintenanceWorkerAttemptsPerEpoch', 'concurrency'], 'maintenance limits')

  return {
    version: 1,
    profileId: id(root.profileId, 'Maintenance Profile profileId'),
    deterministic: {
      actions,
      limit: deterministicLimit,
      backoffSeconds: [...deterministic.backoffSeconds],
    },
    repair: {
      procedure: id(repair.procedure, 'maintenance repair.procedure'),
      allowedPaths: paths(repair.allowedPaths),
      maxPullRequestsPerEpoch: integer(repair.maxPullRequestsPerEpoch, 'maintenance repair.maxPullRequestsPerEpoch', 1, 1),
      failoverBackoffSeconds: integer(repair.failoverBackoffSeconds, 'maintenance repair.failoverBackoffSeconds', 1, 86_400),
    },
    review: {
      procedure: id(review.procedure, 'maintenance review.procedure'),
      required: true,
      hardReadOnly: true,
    },
    checks: {
      workflowNames: names(checks.workflowNames, 'maintenance checks.workflowNames', 16),
      requiredChecks: names(checks.requiredChecks, 'maintenance checks.requiredChecks', 32),
      waitMinutes: integer(checks.waitMinutes, 'maintenance checks.waitMinutes', 1, 1_440),
    },
    promotion: { mode: 'fault-bound', limitPerEpoch: 1 },
    verification: {
      procedure: id(verification.procedure, 'maintenance verification.procedure'),
      healthySamples: integer(verification.healthySamples, 'maintenance verification.healthySamples', 3, 10),
    },
    resume: { procedure: id(resume.procedure, 'maintenance resume.procedure') },
    limits: {
      maxEpochsPer24Hours: integer(limits.maxEpochsPer24Hours, 'maintenance limits.maxEpochsPer24Hours', 1, 3),
      maintenanceWorkerAttemptsPerEpoch: integer(limits.maintenanceWorkerAttemptsPerEpoch, 'maintenance limits.maintenanceWorkerAttemptsPerEpoch', 1, 1),
      concurrency: integer(limits.concurrency, 'maintenance limits.concurrency', 1, 1),
    },
  }
}
