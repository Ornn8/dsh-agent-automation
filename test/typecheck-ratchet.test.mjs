import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceDirectory = new URL('../src/', import.meta.url)
const configUrl = new URL('../jsconfig.json', import.meta.url)
const baselineCount = 2

test('the checked JavaScript surface can grow but cannot silently shrink', async () => {
  const names = (await readdir(sourceDirectory)).filter(name => name.endsWith('.mjs'))
  const optedIn = []
  for (const name of names) {
    const source = await readFile(new URL(name, sourceDirectory), 'utf8')
    if (/^\/\/ @ts-check\r?\n/.test(source)) optedIn.push(`src/${name}`)
  }
  const config = JSON.parse(await readFile(configUrl, 'utf8'))
  assert.ok(optedIn.length >= baselineCount, `@ts-check coverage fell below ${baselineCount} source files`)
  assert.deepEqual([...config.files].sort(), optedIn.sort())
})
