import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'dsh-capacity-acquire-pause-'))
const fixture = fileURLToPath(new URL('./capacity-store-process.mjs', import.meta.url))
const paused = fileURLToPath(new URL('./capacity-acquire-pause.mjs', import.meta.url))
const hidden = fileURLToPath(new URL('./capacity-store-hidden-candidate.mjs', import.meta.url))
const paths = join(root, 'capacity')
const waitFor = async path => {
  for (let i = 0; i < 500; i += 1) {
    try { await readFile(path, 'utf8'); return }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}
const result = child => new Promise(resolve => {
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
})
try {
  const first = spawn(process.execPath, [paused, root], { stdio: ['ignore', 'ignore', 'pipe'] })
  const firstResult = result(first)
  await waitFor(join(paths, 'acquire-pause.ready'))
  console.log('first paused')
  const second = spawn(process.execPath, [hidden, root], { stdio: ['ignore', 'ignore', 'pipe'] })
  const secondResult = result(second)
  await waitFor(join(paths, 'hidden-candidate.ready'))
  console.log('second ready')
  await writeFile(join(paths, 'acquire-pause.go'), 'go\n', 'utf8')
  await waitFor(join(paths, 'acquire-pause.resumed'))
  console.log('first resumed')
  const third = spawn(process.execPath, [fixture, 'lock', root, 'observer'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const thirdResult = result(third)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log('observer started')
  await writeFile(join(paths, 'hidden-candidate.go'), 'go\n', 'utf8')
  await waitFor(join(paths, 'acquire-pause.acquired'))
  console.log('first acquired')
  await writeFile(join(paths, 'acquire-pause.release'), 'release\n', 'utf8')
  let timeout
  const observed = await Promise.race([
    thirdResult,
    new Promise(resolve => { timeout = setTimeout(() => resolve({ timeout: true }), 2_000) }),
  ])
  clearTimeout(timeout)
  console.log(JSON.stringify(observed))
  const [firstOutcome, secondOutcome] = await Promise.all([firstResult, secondResult])
  console.log(JSON.stringify({ first: firstOutcome, second: secondOutcome }))
  if (observed.timeout || observed.code !== 0 || observed.stderr.includes('multiple owners')) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
