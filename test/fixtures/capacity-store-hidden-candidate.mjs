import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const originalReaddir = fsp.readdir
const [, , stateRoot] = process.argv
if (!stateRoot) throw new Error('usage: <stateRoot>')
const directory = join(stateRoot, 'capacity')
fsp.readdir = async (path, options) => {
  const names = await originalReaddir(path, options)
  if (path !== directory || !Array.isArray(names) || names.length === 0) return names
  return names.filter(name => !name.startsWith('registry-lease.') && !name.startsWith('registry-reclaim.'))
}
syncBuiltinESMExports()
const { withCapacityRegistryLock, capacityRegistryPaths } = await import('../../src/capacity-registry-store.mjs')
const paths = capacityRegistryPaths(stateRoot)
await withCapacityRegistryLock(stateRoot, async () => {
  await fsp.writeFile(join(paths.directory, 'hidden-candidate.ready'), 'ready\n', 'utf8')
  while (true) {
    try {
      await fsp.readFile(join(paths.directory, 'hidden-candidate.go'), 'utf8')
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
})
