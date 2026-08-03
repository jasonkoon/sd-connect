/**
 * Minimal `expect` over node:assert.
 *
 * The suite was written against bun:test's expect. Rather than rewrite ~110
 * assertions when moving to node:test, this implements the handful of matchers
 * actually used. Deliberately small: if a matcher is not here, it was not used.
 */

import assert from 'node:assert/strict'

export interface Matchers<T> {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toHaveLength(length: number): void
  toBeLessThan(value: number): void
  toBeLessThanOrEqual(value: number): void
  toBeGreaterThan(value: number): void
  toBeGreaterThanOrEqual(value: number): void
  toBeNull(): void
  toMatch(pattern: RegExp | string): void
  toContain(item: unknown): void
  toEndWith(suffix: string): void
  toThrow(pattern?: RegExp | string | (new (...args: never[]) => Error)): void
  readonly rejects: {
    toThrow(pattern?: RegExp | string | (new (...args: never[]) => Error)): Promise<void>
  }
  readonly not: Omit<Matchers<T>, 'not' | 'rejects'>
}

function assertThrown(error: unknown, pattern?: RegExp | string | (new (...args: never[]) => Error)): void {
  if (pattern === undefined) return
  if (typeof pattern === 'function') {
    assert.ok(
      error instanceof pattern,
      `expected error to be instance of ${pattern.name}, got ${String(error)}`,
    )
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  if (pattern instanceof RegExp) {
    assert.match(message, pattern)
  } else {
    assert.ok(message.includes(pattern), `expected "${message}" to include "${pattern}"`)
  }
}

function build<T>(actual: T, negated: boolean): Matchers<T> {
  const check = (ok: boolean, message: string): void => {
    assert.ok(negated ? !ok : ok, negated ? `NOT: ${message}` : message)
  }

  const deepEquals = (expected: unknown): boolean => {
    try {
      assert.deepStrictEqual(actual, expected)
      return true
    } catch {
      return false
    }
  }

  const matchers: Matchers<T> = {
    toBe(expected) {
      check(Object.is(actual, expected), `expected ${String(actual)} to be ${String(expected)}`)
    },
    toEqual(expected) {
      check(deepEquals(expected), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`)
    },
    toHaveLength(length) {
      const actualLength = (actual as { length?: number })?.length
      check(actualLength === length, `expected length ${actualLength} to be ${length}`)
    },
    toBeLessThan(value) {
      check((actual as number) < value, `expected ${String(actual)} < ${value}`)
    },
    toBeLessThanOrEqual(value) {
      check((actual as number) <= value, `expected ${String(actual)} <= ${value}`)
    },
    toBeGreaterThan(value) {
      check((actual as number) > value, `expected ${String(actual)} > ${value}`)
    },
    toBeGreaterThanOrEqual(value) {
      check((actual as number) >= value, `expected ${String(actual)} >= ${value}`)
    },
    toBeNull() {
      check(actual === null, `expected ${String(actual)} to be null`)
    },
    toMatch(pattern) {
      const text = String(actual)
      const ok = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)
      check(ok, `expected "${text}" to match ${String(pattern)}`)
    },
    toContain(item) {
      const ok = Array.isArray(actual)
        ? actual.includes(item)
        : String(actual).includes(String(item))
      check(ok, `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`)
    },
    toEndWith(suffix) {
      check(String(actual).endsWith(suffix), `expected "${String(actual)}" to end with "${suffix}"`)
    },
    toThrow(pattern) {
      let thrown: unknown
      let didThrow = false
      try {
        ;(actual as () => unknown)()
      } catch (error) {
        didThrow = true
        thrown = error
      }
      check(didThrow, 'expected function to throw')
      if (didThrow && !negated) assertThrown(thrown, pattern)
    },
    get rejects() {
      return {
        async toThrow(pattern?: RegExp | string | (new (...args: never[]) => Error)) {
          let thrown: unknown
          let didThrow = false
          try {
            await (actual as Promise<unknown> | (() => Promise<unknown>) instanceof Function
              ? (actual as () => Promise<unknown>)()
              : (actual as Promise<unknown>))
          } catch (error) {
            didThrow = true
            thrown = error
          }
          check(didThrow, 'expected promise to reject')
          if (didThrow && !negated) assertThrown(thrown, pattern)
        },
      }
    },
    get not() {
      return build(actual, !negated)
    },
  }

  return matchers
}

export function expect<T>(actual: T): Matchers<T> {
  return build(actual, false)
}
