/**
 * Config parsing tests, focused on the rule that a bad value is warned about
 * and ignored rather than fatal — a typo must never stop the deck working.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_PORT, DEFAULT_WEB_CONFIG, isValidPort, parseConfig } from './config.ts'

describe('isValidPort', () => {
  test('accepts the unprivileged range', () => {
    for (const port of [1024, 8787, 65535]) assert.equal(isValidPort(port), true, `${port}`)
  })

  test('rejects privileged, out-of-range and non-integer values', () => {
    // Privileged ports are unusable: this never runs as root.
    for (const port of [0, 80, 1023, 65536, 99999, -1, 8787.5, NaN, Infinity]) {
      assert.equal(isValidPort(port), false, `${port} should be rejected`)
    }
  })

  test('rejects non-numbers, including numeric strings', () => {
    for (const port of ['8787', null, undefined, {}, []]) {
      assert.equal(isValidPort(port), false, `${JSON.stringify(port)} should be rejected`)
    }
  })

  test('the default port is itself valid', () => {
    // Guards against someone editing DEFAULT_PORT to something unusable.
    assert.equal(isValidPort(DEFAULT_PORT), true)
    assert.equal(DEFAULT_WEB_CONFIG.port, DEFAULT_PORT)
  })
})

describe('parseConfig: [web]', () => {
  test('defaults to an enabled viewer on 8787', () => {
    const { config, warnings } = parseConfig('')
    assert.deepEqual(config.web, DEFAULT_WEB_CONFIG)
    assert.deepEqual(warnings, [])
  })

  test('reads enabled and port', () => {
    const { config, warnings } = parseConfig('[web]\nenabled = false\nport = 9000\n')
    assert.deepEqual(config.web, { enabled: false, port: 9000 })
    assert.deepEqual(warnings, [])
  })

  test('a bad port is warned about and the default kept', () => {
    for (const port of ['80', '70000', '"8787"', '8787.5']) {
      const { config, warnings } = parseConfig(`[web]\nport = ${port}\n`)
      assert.equal(config.web.port, DEFAULT_WEB_CONFIG.port, `port = ${port} should be ignored`)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] as string, /web\.port/)
    }
  })

  test('privileged ports are rejected, since this never runs as root', () => {
    const { config } = parseConfig('[web]\nport = 443\n')
    assert.equal(config.web.port, DEFAULT_WEB_CONFIG.port)
  })

  test('a non-boolean enabled is warned about and the default kept', () => {
    const { config, warnings } = parseConfig('[web]\nenabled = "yes"\n')
    assert.equal(config.web.enabled, true)
    assert.match(warnings[0] as string, /web\.enabled/)
  })

  test('[web] as a non-table is warned about', () => {
    const { config, warnings } = parseConfig('web = 5\n')
    assert.deepEqual(config.web, DEFAULT_WEB_CONFIG)
    assert.match(warnings[0] as string, /\[web\] must be a table/)
  })

  test('a bad [web] does not discard the rest of the config', () => {
    const { config } = parseConfig('brightness = 42\n[web]\nport = 1\n')
    assert.equal(config.brightness, 42)
    assert.equal(config.web.port, DEFAULT_WEB_CONFIG.port)
  })

  test('parsed web config is not shared between calls', () => {
    // The defaults are a module-level object; mutating them once would leak
    // into every later load in the same process.
    const first = parseConfig('[web]\nport = 9001\n').config
    const second = parseConfig('').config
    assert.equal(first.web.port, 9001)
    assert.equal(second.web.port, DEFAULT_WEB_CONFIG.port)
  })
})
