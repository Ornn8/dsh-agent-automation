/** Parse the bounded ordinary-scan batch size supplied by the reusable workflow. */
export function parseMaximumBatchSize(value) {
  const source = value?.trim() || '4'
  if (!/^\d+$/.test(source)) throw new Error('MAXIMUM_BATCH_SIZE must be a positive integer')
  const number = Number.parseInt(source, 10)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('MAXIMUM_BATCH_SIZE must be a positive safe integer')
  }
  return number
}

/** Select one requested wake or the ordinary batch without mixing their paths. */
export function selectBacklogDispatches({ requestedIssueNumber = null, selectSingle, selectBatch } = {}) {
  if (requestedIssueNumber !== null) {
    const selected = selectSingle()
    return selected ? [selected] : []
  }
  return [...selectBatch()]
}

/** Attempt every selected member once and surface failures after all members finish. */
export async function runBacklogBatch(selections, dispatchOne) {
  const outcomes = []
  for (const selection of selections) {
    try {
      const result = await dispatchOne(selection)
      outcomes.push({ number: selection.number, status: result?.status || 'completed', result })
    } catch (error) {
      outcomes.push({ number: selection.number, status: 'failed', error })
    }
  }
  const failures = outcomes.filter(outcome => outcome.status === 'failed')
  if (failures.length) {
    const aggregate = new AggregateError(failures.map(failure => failure.error), 'Backlog batch dispatch failed')
    aggregate.outcomes = outcomes
    throw aggregate
  }
  return outcomes
}
