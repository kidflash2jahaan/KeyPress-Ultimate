/**
 * The smallest semver comparison the updater needs, with no dependency.
 *
 * Handles `x.y.z` and `vx.y.z`, compares numerically (so 1.10.0 > 1.9.0, which
 * a string compare gets backwards), and treats a release as newer than any
 * prerelease of the same version (1.0.0 > 1.0.0-beta.1), per semver 2.0.0.
 * Missing components read as 0, so `1.2` and `1.2.0` are equal. Build metadata
 * after `+` is ignored, again per spec.
 */

export type Ordering = -1 | 0 | 1

interface Parsed {
  readonly release: readonly number[]
  readonly prerelease: readonly string[]
}

function parse(input: string): Parsed {
  const trimmed = input.trim()
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed
  const withoutBuild = withoutPrefix.split('+', 1)[0] ?? ''

  const dashAt = withoutBuild.indexOf('-')
  const corePart = dashAt === -1 ? withoutBuild : withoutBuild.slice(0, dashAt)
  const prePart = dashAt === -1 ? '' : withoutBuild.slice(dashAt + 1)

  const release = corePart.split('.').map((piece) => {
    const n = Number.parseInt(piece, 10)
    return Number.isNaN(n) ? 0 : n
  })

  return {
    release,
    prerelease: prePart.length > 0 ? prePart.split('.') : [],
  }
}

function cmpNumber(a: number, b: number): Ordering {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function comparePrerelease(a: readonly string[], b: readonly string[]): Ordering {
  // No prerelease outranks any prerelease: 1.0.0 > 1.0.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const aNum = /^\d+$/.test(ai)
    const bNum = /^\d+$/.test(bi)
    if (aNum && bNum) {
      const c = cmpNumber(Number.parseInt(ai, 10), Number.parseInt(bi, 10))
      if (c !== 0) return c
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return aNum ? -1 : 1
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1
    }
  }
  return 0
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compare(a: string, b: string): Ordering {
  const pa = parse(a)
  const pb = parse(b)

  const len = Math.max(pa.release.length, pb.release.length)
  for (let i = 0; i < len; i++) {
    const c = cmpNumber(pa.release[i] ?? 0, pb.release[i] ?? 0)
    if (c !== 0) return c
  }

  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compare(candidate, current) === 1
}
