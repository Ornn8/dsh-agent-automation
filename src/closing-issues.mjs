/**
 * Return unique same-repository Issue numbers from GitHub closing references.
 * @param {unknown} references GitHub closing Issue references.
 * @param {string} repository Target owner/repository name.
 * @returns {number[]} Canonical same-repository Issue numbers.
 */
export function sameRepositoryClosingIssues(references, repository) {
  if (!Array.isArray(references) || typeof repository !== 'string') return []
  const prefix = `https://github.com/${repository}/issues/`
  const numbers = references.flatMap(reference => {
    const number = reference?.number
    if (!Number.isSafeInteger(number) || number < 1
      || reference?.url !== `${prefix}${number}`) return []
    return [number]
  })
  return [...new Set(numbers)]
}
