/**
 * Controller maintenance and readiness workflows run on a nominal fifteen-minute schedule.
 * Allow four schedule intervals for GitHub scheduling and promotion jitter while retaining
 * the separate twenty-minute queued-job threshold.
 */
export const MAINTENANCE_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000
export const MAXIMUM_MAINTENANCE_AGE_MS = 4 * MAINTENANCE_SCHEDULE_INTERVAL_MS

/**
 * Reports whether a completed maintenance workflow run is within the bounded readiness window.
 *
 * @param {string} updatedAt ISO timestamp from the workflow run
 * @param {number} now current time in milliseconds since the Unix epoch
 * @returns {boolean} whether the run is recent enough
 */
export function isMaintenanceRunFresh(updatedAt, now = Date.now()) {
  const updatedAtMs = Date.parse(updatedAt)
  return Number.isFinite(updatedAtMs) && now - updatedAtMs <= MAXIMUM_MAINTENANCE_AGE_MS
}
