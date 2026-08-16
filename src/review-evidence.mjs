import { run } from './common.mjs'
import { assertChangedLineExcerpt } from './line-evidence.mjs'

/** Bind every blocking review finding to an added line in the exact reviewed pair. */
export async function validateReviewFindings(review, {
  gitExecutable,
  reviewCheckout,
  base,
  head,
  runCommand = run,
}) {
  for (const finding of review.findings) {
    const reference = `${finding.path}:${finding.line}`
    const content = (await runCommand(gitExecutable, [
      '-C', reviewCheckout, 'cat-file', 'blob', `${head}:${finding.path}`,
    ])).stdout
    const patch = (await runCommand(gitExecutable, [
      '-C', reviewCheckout, 'diff', '--find-renames', '--unified=0', '--no-ext-diff',
      `${base}...${head}`, '--', finding.path,
    ])).stdout
    assertChangedLineExcerpt({
      content,
      patch,
      line: finding.line,
      excerpt: finding.excerpt,
      reference,
    })
  }
}
