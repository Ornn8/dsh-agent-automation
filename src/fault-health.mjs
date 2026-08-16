const DIGEST = /^[0-9a-f]{64}$/

/** Validate one local, non-authorizing health observation state. */
export function parseFaultHealthState(value, faultId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'consecutiveHealthy,faultId,generation,status'
    || value.faultId !== faultId || !DIGEST.test(faultId || '')
    || !['failed', 'healthy'].includes(value.status)
    || !Number.isSafeInteger(value.consecutiveHealthy) || value.consecutiveHealthy < 0
    || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new Error('Fault health state is invalid')
  }
  return { ...value }
}

/** Record a health sample and advance generation only on the third consecutive recovery sample. */
export function observeFaultHealth(priorValue, { faultId, healthy }) {
  const prior = priorValue === undefined
    ? { faultId, status: 'failed', consecutiveHealthy: 0, generation: 0 }
    : parseFaultHealthState(priorValue, faultId)
  const consecutiveHealthy = healthy
    ? (prior.status === 'healthy' ? prior.consecutiveHealthy : 0) + 1
    : 0
  return parseFaultHealthState({
    faultId,
    status: healthy ? 'healthy' : 'failed',
    consecutiveHealthy,
    generation: prior.generation + (healthy && consecutiveHealthy === 3 ? 1 : 0),
  }, faultId)
}
