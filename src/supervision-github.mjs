import { parseJson, run } from './common.mjs'

/** Call one GitHub REST endpoint through the controller-owned GitHub CLI process. */
export async function githubJson({
  config,
  environment,
  path,
  description,
  method,
  input,
  headers = [],
}) {
  const args = ['api']
  if (method) args.push('--method', method)
  for (const header of headers) args.push('-H', header)
  args.push(path)
  if (input !== undefined) args.push('--input', '-')
  const result = await run(config.ghExecutable, args, {
    env: environment,
    input: input === undefined ? undefined : JSON.stringify(input),
  })
  if (!result.stdout.trim()) return undefined
  return parseJson(result.stdout, description)
}

function paginatedPath(path, page) {
  const endpoint = new URL(path, 'https://api.github.invalid/')
  endpoint.searchParams.set('per_page', '100')
  endpoint.searchParams.set('page', String(page))
  return `${endpoint.pathname.replace(/^\//, '')}?${endpoint.searchParams}`
}

/** Read a complete GitHub collection within a fixed page budget or fail closed. */
export async function githubPages({
  collection,
  maxPages = 3,
  request = githubJson,
  ...options
}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new Error('GitHub page limit must be an integer from 1 to 5')
  }
  const items = []
  let envelope
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request({ ...options, path: paginatedPath(options.path, page) })
    const pageItems = collection ? response?.[collection] : response
    if (!Array.isArray(pageItems)) {
      throw new Error(`${options.description} page ${page} did not return a ${collection || 'root'} array`)
    }
    if (collection && !envelope) envelope = response
    items.push(...pageItems)
    const totalCount = collection && Number.isSafeInteger(envelope?.total_count)
      ? envelope.total_count
      : undefined
    if (pageItems.length < 100 || (totalCount !== undefined && items.length >= totalCount)) {
      return collection ? { ...envelope, [collection]: items } : items
    }
  }
  throw new Error(`${options.description} exceeded the ${maxPages}-page audit limit`)
}

/** Read optional GitHub context without converting one inaccessible detail into a write. */
export async function optionalGithubJson(options) {
  try {
    return await githubJson(options)
  } catch (error) {
    process.stderr.write(`Repository supervision could not read ${options.description}: ${error.message}\n`)
    return undefined
  }
}
