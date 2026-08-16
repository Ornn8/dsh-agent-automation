import { parseFaultRecord } from './fault-record.mjs'

const MARKER = '<!-- agent-fault-record:v1:'

/** Render one append-only FaultRecord transition with its producing workflow run. */
export function attestedFaultRecordBody(record, { repository, controllerSha, runId }) {
  const normalized = parseFaultRecord(record)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
    || !/^[0-9a-f]{40}$/.test(controllerSha || '')
    || !Number.isSafeInteger(runId) || runId < 1) throw new Error('FaultRecord attestation identity is invalid')
  return [
    `${MARKER}${normalized.faultId} -->`,
    '### Controller fault state',
    '',
    '```json',
    JSON.stringify(normalized),
    '```',
    '',
    `- Controller run: https://github.com/${repository}/actions/runs/${runId}`,
    `- Controller SHA: \`${controllerSha}\``,
  ].join('\n')
}

/** Parse one FaultRecord transition and its claimed workflow attestation. */
export function parseAttestedFaultRecord(body) {
  const text = String(body || '')
  const marker = /^<!-- agent-fault-record:v1:([0-9a-f]{64}) -->$/m.exec(text)
  const block = /### Controller fault state\s*```json\s*([^\r\n]+)\s*```/m.exec(text)
  const run = /^- Controller run: https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)$/m.exec(text)
  const sha = /^- Controller SHA: `([0-9a-f]{40})`$/m.exec(text)
  if (!marker || !block || !run || !sha) throw new Error('FaultRecord attestation is incomplete')
  let value
  try { value = JSON.parse(block[1]) } catch (error) { throw new Error(`FaultRecord attestation JSON is invalid: ${error.message}`) }
  const record = parseFaultRecord(value)
  if (record.faultId !== marker[1]) throw new Error('FaultRecord marker does not match the record')
  return { record, repository: run[1], runId: Number.parseInt(run[2], 10), controllerSha: sha[1] }
}

/** Select append-only FaultRecords proven by completed Controller maintenance runs. */
export async function trustedFaultRecords({ comments, faultId, controllerRepository, loadRun }) {
  const trusted = []
  for (const comment of comments || []) {
    if (comment?.user?.login !== 'github-actions[bot]' && !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment?.author_association)) continue
    let parsed
    try { parsed = parseAttestedFaultRecord(comment.body) } catch { continue }
    if (parsed.record.faultId !== faultId || parsed.repository !== controllerRepository) continue
    const run = await loadRun(parsed.runId)
    if (run?.repository?.full_name !== controllerRepository
      || run?.path !== '.github/workflows/controller-maintenance.yml'
      || run?.head_sha !== parsed.controllerSha
      || run?.status !== 'completed' || run?.conclusion !== 'success'
      || !['schedule', 'workflow_dispatch'].includes(run?.event)) continue
    trusted.push({ ...parsed, commentId: comment.id })
  }
  return trusted
}
