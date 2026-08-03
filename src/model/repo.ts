/**
 * cwd -> repo label.
 *
 * The basename of cwd is often useless: an agent sitting in
 * /Users/jason.koon/dev/zephyr_cloudflow/src would render as "src". Walking up
 * to the nearest .git gives "zephyr_cloudflow", which is what you actually
 * recognise on a key.
 *
 * Results are cached because this runs on every poll and the answer for a given
 * cwd effectively never changes.
 */

import { existsSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'

const cache = new Map<string, string>()
const MAX_ENTRIES = 512

/** Nearest ancestor containing .git, or null. Synchronous: hits cache almost always. */
function findGitRoot(startDir: string): string | null {
  let dir = startDir
  // Bounded walk; also stops at the filesystem root when dirname stops changing.
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(`${dir}${sep}.git`)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Label for a working directory: the git repo root's basename, falling back to
 * the directory's own basename outside a repo.
 */
export function repoLabel(cwd: string | null): string {
  if (!cwd) return '?'

  const cached = cache.get(cwd)
  if (cached !== undefined) return cached

  const root = findGitRoot(cwd)
  const label = basename(root ?? cwd) || cwd

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(cwd, label)
  return label
}

/** Test seam: drop memoized labels. */
export function clearRepoCache(): void {
  cache.clear()
}
