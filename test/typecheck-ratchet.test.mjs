import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceDirectory = new URL('../src/', import.meta.url)
const configUrl = new URL('../jsconfig.json', import.meta.url)
const baselineCount = 24

async function sourceFiles(directory, prefix = 'src') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${prefix}/${entry.name}`
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(url, path))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push({ path, url })
  }
  return files
}

test('the checked JavaScript surface changes only through an explicit ratchet update', async () => {
  const optedIn = []
  for (const file of await sourceFiles(sourceDirectory)) {
    const source = await readFile(file.url, 'utf8')
    if (/^\/\/ @ts-check\r?\n/.test(source)) optedIn.push(file.path)
  }
  const config = JSON.parse(await readFile(configUrl, 'utf8'))
  assert.equal(optedIn.length, baselineCount, `@ts-check coverage changed without updating the ${baselineCount}-file ratchet`)
  assert.deepEqual([...config.files].sort(), optedIn.sort())
})
