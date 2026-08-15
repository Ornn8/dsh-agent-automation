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

/** Read optional GitHub context without converting one inaccessible detail into a write. */
export async function optionalGithubJson(options) {
  try {
    return await githubJson(options)
  } catch (error) {
    process.stderr.write(`Repository supervision could not read ${options.description}: ${error.message}\n`)
    return undefined
  }
}
