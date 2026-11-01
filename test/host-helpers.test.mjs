/**
 * The pure helpers the host half is built from: address rules, key mapping, PNG
 * sizing, browser discovery, and the page-side expressions.
 *
 * The expressions are compiled here, not run: a syntax error inside one of them
 * would otherwise only appear the first time a model called that tool against a
 * live page. Running them for real is `npm run test:e2e`'s job.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {
  browserCandidates,
  buildClickExpression,
  buildFocusExpression,
  buildSnapshotExpression,
  buildValueExpression,
  findBrowser,
  keyDescriptor,
  normalizeConfig,
  pngSize,
  resolveUrl,
} from '../host.js'

test('resolveUrl upgrades bare hosts and keeps real addresses', () => {
  assert.equal(resolveUrl('example.com'), 'https://example.com/')
  assert.equal(resolveUrl('  example.com  '), 'https://example.com/')
  assert.equal(resolveUrl('example.com/a/b?c=d#e'), 'https://example.com/a/b?c=d#e')
  assert.equal(resolveUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x')
  assert.equal(resolveUrl('https://例え.test/'), 'https://xn--r8jz45g.test/')
})

test('resolveUrl refuses what it cannot safely open', () => {
  assert.throws(() => resolveUrl(''), /url is required/)
  assert.throws(() => resolveUrl('   '), /url is required/)
  assert.throws(() => resolveUrl('file:///C:/secret.txt'), /only http and https/)
  assert.throws(() => resolveUrl('javascript:alert(1)'), /only http and https/)
  assert.throws(() => resolveUrl('data:text/html,<h1>x</h1>'), /only http and https/)
  assert.throws(() => resolveUrl('https://user:pass@example.com/'), /embedded credentials/)
})

test('resolveUrl enforces allowOrigins by host suffix', () => {
  assert.equal(resolveUrl('https://example.com/x', 'example.com'), 'https://example.com/x')
  assert.equal(resolveUrl('https://a.example.com/x', 'example.com'), 'https://a.example.com/x')
  assert.equal(resolveUrl('https://other.test/', ' example.com , other.test '), 'https://other.test/')
  assert.throws(() => resolveUrl('https://evil.test/', 'example.com'), /outside the configured allowOrigins/)
  // A suffix must be a label boundary, not a substring.
  assert.throws(() => resolveUrl('https://notexample.com/', 'example.com'), /outside the configured allowOrigins/)
  // An empty list allows any http(s) host.
  assert.equal(resolveUrl('https://anything.test/', ''), 'https://anything.test/')
})

test('keyDescriptor names the keys the tool documents', () => {
  // Enter carries `\r`, which is what makes Chromium run the default action.
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  assert.deepEqual(keyDescriptor('PageDown'), { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, text: '' })
  assert.deepEqual(keyDescriptor('Space'), { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 0, text: 'a' })
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', windowsVirtualKeyCode: 0, text: '7' })
  assert.deepEqual(keyDescriptor('/'), { key: '/', code: '', windowsVirtualKeyCode: 0, text: '/' })
  // Anything that is neither a known name nor a single character is refused.
  assert.equal(keyDescriptor('F5'), null)
  assert.equal(keyDescriptor(''), null)
  assert.equal(keyDescriptor('EnterEnter'), null)
})

test('pngSize reads the real pixel size out of the header', () => {
  const header = Buffer.from('89504e470d0a1a0a0000000d49484452000003e8000002bc0806000000', 'hex')
  assert.deepEqual(pngSize(header), { width: 1000, height: 700 })
  assert.deepEqual(pngSize(Buffer.alloc(4)), { width: 0, height: 0 })
  assert.deepEqual(pngSize(Buffer.from('not a png at all, but long enough to look like one')), { width: 0, height: 0 })
})

test('browserCandidates prefers Edge on Windows and Chrome on macOS', () => {
  const windows = browserCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PFX', LOCALAPPDATA: 'C:\\LA' })
  assert.match(windows[0], /PFX\\Microsoft\\Edge\\Application\\msedge\.exe$/)
  assert.ok(windows.some((candidate) => candidate.includes('Google\\Chrome')))
  assert.ok(windows.some((candidate) => candidate.includes('BraveSoftware')))

  const mac = browserCandidates('darwin', {})
  assert.match(mac[0], /Google Chrome\.app/)
  assert.ok(mac.some((candidate) => candidate.includes('Microsoft Edge.app')))

  const linux = browserCandidates('linux', {})
  assert.ok(linux.includes('/usr/bin/google-chrome'))
  assert.ok(linux.includes('/usr/bin/chromium'))

  // No LOCALAPPDATA must not produce an empty path that could match anything.
  const bare = browserCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PFX' })
  assert.ok(bare.every((candidate) => !candidate.startsWith('Microsoft')))
})

test('findBrowser honours the config, the environment, and then the platform list', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-browser-panel-probe-'))
  const layout = path.join(root, 'Microsoft', 'Edge', 'Application')
  mkdirSync(layout, { recursive: true })
  const executable = path.join(layout, 'msedge.exe')
  writeFileSync(executable, 'not really a browser')

  const env = { ProgramFiles: root, 'ProgramFiles(x86)': root, LOCALAPPDATA: '' }
  assert.equal(findBrowser(normalizeConfig({}), env, 'win32'), executable)

  // An explicit row value wins over the environment override.
  const pinned = path.join(root, 'pinned.exe')
  writeFileSync(pinned, 'not really a browser')
  assert.equal(findBrowser(normalizeConfig({ browserPath: pinned }), { ...env, DSH_BROWSER_PANEL_BROWSER: executable }, 'win32'), pinned)
  assert.equal(findBrowser(normalizeConfig({}), { ...env, DSH_BROWSER_PANEL_BROWSER: executable }, 'win32'), executable)

  // A directory is not an executable, and the failure names every path tried.
  assert.throws(() => findBrowser(normalizeConfig({ browserPath: root }), env, 'win32'), /not an executable file/)
  assert.throws(
    () => findBrowser(normalizeConfig({}), { ProgramFiles: 'C:\\nowhere', 'ProgramFiles(x86)': 'C:\\nowhere', LOCALAPPDATA: '' }, 'win32'),
    /no Chromium-family browser was found/,
  )
})

test('every page-side expression compiles', () => {
  const expressions = {
    snapshot: buildSnapshotExpression(5000),
    clickBySelector: buildClickExpression('#go', '', 0),
    clickByText: buildClickExpression('', 'Sign in', 2),
    focusTyping: buildFocusExpression('#field', true),
    focusAny: buildFocusExpression('#field', false),
    value: buildValueExpression('#field'),
  }
  for (const [name, expression] of Object.entries(expressions)) {
    assert.doesNotThrow(() => new vm.Script(expression), `${name} is not valid JavaScript`)
  }
  assert.match(expressions.snapshot, /5000/)
  assert.match(expressions.snapshot, /length >= 120/)
  assert.match(expressions.value, /#field/)
})

test('page-side expressions carry their inputs as JSON, not pasted text', () => {
  // A quote or a newline in a label must not be able to break out of the literal.
  const hostile = "it's \"quoted\"\n</script>"
  const expression = buildClickExpression('', hostile, 1)
  assert.doesNotThrow(() => new vm.Script(expression))
  assert.ok(expression.includes(JSON.stringify(hostile)), 'the label should be embedded as a JSON string')
  assert.doesNotThrow(() => new vm.Script(buildFocusExpression('a[href="x"]', true)))
})

test('the snapshot expression is bounded and the outline cap is spelled out', () => {
  const expression = buildSnapshotExpression(1234)
  assert.match(expression, /slice\(0, limit\)/)
  assert.match(expression, /truncated: full\.length > text\.length/)
  assert.ok(!expression.includes('${'), 'no interpolation should have been left unresolved')
})
