import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const originalMkdir = fsp.mkdir
const [, , stateRoot] = process.argv
if (!stateRoot) throw new Error('usage: <stateRoot>')
const pathsRoot = join(stateRoot, 'capacity')
const pausePath = join(pathsRoot, 'acquire-pause.ready')
const continuePath = join(pathsRoot, 'acquire-pause.go')
let paused = false
fsp.mkdir = async (path, options) => {
  const result = await originalMkdir(path, options)
  if (!paused && (path === join(pathsRoot, 'registry.lock') || String(path).startsWith(join(pathsRoot, 'registry-reclaim-stage.')))) {
    paused = true
    await originalMkdir(pathsRoot, { recursive: true })
    await fsp.writeFile(pausePath, 'ready\n', 'utf8')
    while (true) {
      try {
        await fsp.readFile(continuePath, 'utf8')
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    await fsp.writeFile(join(pathsRoot, 'acquire-pause.resumed'), 'resumed\n', 'utf8')
  }
  return result
}
syncBuiltinESMExports()

const { withCapacityRegistryLock } = await import('../../src/capacity-registry-store.mjs')
const acquiredPath = join(pathsRoot, 'acquire-pause.acquired')
const releasePath = join(pathsRoot, 'acquire-pause.release')
await withCapacityRegistryLock(stateRoot, async () => {
  await fsp.writeFile(acquiredPath, 'acquired\n', 'utf8')
  while (true) {
    try {
      await fsp.readFile(releasePath, 'utf8')
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
})
