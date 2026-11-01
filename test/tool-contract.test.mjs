/**
 * The host half's tool contract.
 *
 * Two things are being defended here:
 *
 * 1. `ToolRegistry.register` rejects a schema outside the enforced subset, and
 *    that rejection happens at activation — a bad schema here is a plugin that
 *    fails to load after the next restart, not a tool that misbehaves. The
 *    subset rules are therefore re-stated and asserted over every schema.
 * 2. PTC mode hands `execute`'s return value to the sandbox as "the tool's typed
 *    canonical JSON value", while native mode renders it. A tool whose value
 *    drifts from its declared schema, or whose render no longer produces the
 *    text it used to, breaks one consumer or the other silently.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, buildToolDefinitions, normalizeConfig, VERSION } from '../host.js'

const SHOT = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-browser-panel-')), 'shot.png')
const PAGE_URL = 'https://example.test/'
const AGENT = { agent: { id: 'agent-1' } }

/** The keyword subset `dsh-tools` documents as enforced. */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title'])
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])

/**
 * Collect every way a schema leaves the enforced subset.
 *
 * @param schema - the schema node.
 * @param at - its path, for the message.
 * @param found - accumulator.
 */
function subsetViolations(schema, at, found) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    found.push(`${at} is not a schema object`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) found.push(`${at}.${key} is outside the enforced subset`)
  }
  if (schema.type !== undefined) {
    if (Array.isArray(schema.type)) found.push(`${at}.type must be one scalar type, not a union`)
    else if (!SCHEMA_TYPES.has(schema.type)) found.push(`${at}.type "${schema.type}" is not a supported type`)
  }
  if (schema.properties !== undefined) {
    if (schema.type !== 'object') found.push(`${at}.properties requires type "object"`)
    for (const [key, child] of Object.entries(schema.properties)) subsetViolations(child, `${at}.properties.${key}`, found)
  }
  if (schema.items !== undefined) subsetViolations(schema.items, `${at}.items`, found)
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf)) found.push(`${at}.oneOf must be an array`)
    else schema.oneOf.forEach((child, index) => subsetViolations(child, `${at}.oneOf[${index}]`, found))
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) found.push(`${at}.required must be an array`)
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    found.push(`${at}.additionalProperties must be a boolean`)
  }
}

/**
 * Collect every way a value disagrees with a schema from the same subset.
 *
 * @param schema - the schema node.
 * @param value - the canonical value a tool returned.
 * @param at - its path, for the message.
 * @param found - accumulator.
 */
function valueViolations(schema, value, at, found) {
  // An annotation-only node means unconstrained JSON; nothing to check.
  if (schema.type === undefined && schema.properties === undefined && schema.oneOf === undefined) return
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((branch) => {
      const branchFound = []
      valueViolations(branch, value, at, branchFound)
      return branchFound.length === 0
    })
    if (passing.length !== 1) found.push(`${at} must match exactly one oneOf branch, matched ${passing.length}`)
    return
  }
  const properties = schema.properties ?? {}
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      found.push(`${at} must be an object`)
      return
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) found.push(`${at}.${key} is required but missing`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) found.push(`${at}.${key} is not declared, but additionalProperties is false`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) valueViolations(child, value[key], `${at}.${key}`, found)
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      found.push(`${at} must be an array`)
      return
    }
    if (schema.items !== undefined) value.forEach((item, index) => valueViolations(schema.items, item, `${at}[${index}]`, found))
    return
  }
  if (schema.type === 'string' && typeof value !== 'string') found.push(`${at} must be a string`)
  if (schema.type === 'number' && typeof value !== 'number') found.push(`${at} must be a number`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') found.push(`${at} must be a boolean`)
  if (schema.type === 'integer' && !Number.isInteger(value)) found.push(`${at} must be an integer`)
}

/** The status value a running browser would produce. */
function statusValue() {
  return {
    plugin: '@local/dsh-sidebar-browser',
    version: VERSION,
    running: true,
    browser: 'Edg/154.0.4258.37',
    browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    pid: 4242,
    debugPort: 54321,
    profileDir: 'C:\\Users\\test\\.dsh\\browser-panel\\browser-profile',
    headless: false,
    headlessReason: '',
    noSandbox: false,
    visible: true,
    browserAvailable: true,
    browserSource: 'known-path',
    browserFound: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe  (known-path)',
      '/usr/bin/google-chrome  (path)',
    ],
    browserRemedy: '',
    provision: 'ok',
    provisionDetail: 'using C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe (known-path)',
    window: { left: 120, top: 120, width: 1000, height: 700 },
    pages: [
      { targetId: 'T0', url: 'about:blank#dsh-ai-browser', title: '🤖 AI 浏览器 · dsh-browser-panel', selected: false, marker: true, agentBound: false, owner: '', ownerLabel: '', ownerActive: false },
      { targetId: 'T1', url: PAGE_URL, title: 'Example', selected: true, marker: false, agentBound: true, owner: 'agent-1', ownerLabel: 'lead', ownerActive: true },
      { targetId: 'T2', url: 'https://other.test/', title: '', selected: false, marker: false, agentBound: false, owner: '', ownerLabel: '', ownerActive: false },
    ],
    selected: 'T1',
    marker: 'T0',
    reused: false,
    windowName: 'AI 浏览器',
    ownership: 'always',
    limits: { actionTimeoutMs: 1234, maxSnapshotChars: 4321 },
    lastError: '',
  }
}

/** A controller just real enough to build and run the definitions. */
function fakeService() {
  return {
    config: normalizeConfig({ actionTimeoutMs: 1234, maxSnapshotChars: 4321 }),
    noteAgent(agent) {
      return typeof agent?.id === 'string' ? agent.id : ''
    },
    async status() {
      return statusValue()
    },
    async open(_agentId, options) {
      return {
        requested: options.url,
        reuse: false,
        url: PAGE_URL,
        title: 'Example',
        browser: 'Edg/154.0.4258.37',
        visible: true,
        owner: 'lead',
        adoptedFrom: '',
        released: '',
        note: 'opened a new tab in the browser window',
      }
    },
    async snapshot() {
      return {
        url: PAGE_URL,
        title: 'Example',
        text: 'Hello',
        truncated: false,
        outline: [{ ref: '#go', tag: 'button', type: '', href: '', disabled: false, text: 'Go' }],
      }
    },
    async click() {
      return { matched: true, ref: '#go', label: 'Go', reason: '', url: PAGE_URL }
    },
    async typeText() {
      return { typed: true, inserted: 'insertText', editable: true, submitted: false, value: 'hi', reason: '' }
    },
    async press() {
      return { key: 'Tab', sent: true, focused: true, selectorChecked: true, note: '' }
    },
    async navigate() {
      return { direction: 'reload', url: PAGE_URL, title: 'Example', note: '' }
    },
    async runEval() {
      return { value: { ok: 1 } }
    },
    async screenshot() {
      // A real 1x1 PNG header, so the tool writes bytes a reader can open.
      return { bytes: Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'), width: 1, height: 1 }
    },
  }
}

/** Arguments that satisfy each tool's required parameters. */
const CALL_ARGS = {
  browser_panel_status: {},
  browser_panel_open: { url: PAGE_URL },
  browser_panel_snapshot: {},
  browser_panel_click: { selector: '#go' },
  browser_panel_type: { selector: '#go', text: 'hi' },
  browser_panel_press: { key: 'Tab' },
  browser_panel_navigate: { direction: 'reload' },
  browser_panel_eval: { script: 'return 1' },
  browser_panel_screenshot: { path: SHOT },
}

/** @returns the definitions built over the fake controller. */
function buildHarness() {
  const ctx = { get: () => undefined }
  return { definitions: buildToolDefinitions(ctx, fakeService()) }
}

test('every tool schema stays inside the enforced JSON Schema subset', () => {
  const found = []
  for (const definition of buildHarness().definitions) {
    subsetViolations(definition.parameters, `${definition.name}.parameters`, found)
    subsetViolations(definition.output.schema, `${definition.name}.output.schema`, found)
  }
  assert.deepEqual(found, [])
})

test('every tool declares an object output whose required list is exact', () => {
  const { definitions } = buildHarness()
  // The nine browser-operation tools, and no panel-chrome tools.
  assert.equal(definitions.length, 9)
  const names = definitions.map((definition) => definition.name).sort()
  assert.deepEqual(names, [
    'browser_panel_click', 'browser_panel_eval', 'browser_panel_navigate', 'browser_panel_open',
    'browser_panel_press', 'browser_panel_screenshot', 'browser_panel_snapshot', 'browser_panel_status',
    'browser_panel_type',
  ])
  for (const definition of definitions) {
    assert.equal(typeof definition.output.render, 'function', `${definition.name} has no render`)
    assert.equal(definition.output.schema.type, 'object', `${definition.name} output is not object-rooted`)
    const declared = Object.keys(definition.output.schema.properties).sort()
    assert.deepEqual(
      [...definition.output.schema.required].sort(),
      declared,
      `${definition.name} must declare every property required, so a consumer never tests for undefined`,
    )
  }
})

test('each tool returns exactly the value its output schema declares', async () => {
  const found = []
  for (const definition of buildHarness().definitions) {
    const args = CALL_ARGS[definition.name]
    const value = await definition.execute(args, AGENT)
    valueViolations(definition.output.schema, value, definition.name, found)

    // The native rendering must also survive the value it is handed.
    const blocks = definition.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length === 1, `${definition.name} render did not return one block`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
  assert.deepEqual(found, [])
})

test('render still produces the model-facing text these tools have always shown', async () => {
  const expected = {
    browser_panel_open: [
      'Browser window (opened):',
      'requested: https://example.test/',
      'url: https://example.test/',
      'title: Example',
      'browser: Edg/154.0.4258.37',
      'visible: true',
      'owner: lead',
      'note: opened a new tab in the browser window',
    ].join('\n'),
    browser_panel_snapshot: [
      'Page:',
      'url: https://example.test/',
      'title: Example',
      'text truncated: false',
      '',
      'Interactive elements (pass ref to browser_panel_click / browser_panel_type):',
      '1. #go  [button]  Go',
      '',
      'Visible text:',
      'Hello',
    ].join('\n'),
    browser_panel_click: [
      'Click:',
      'matched: true',
      'ref: #go',
      'label: Go',
      'url now: https://example.test/',
    ].join('\n'),
    browser_panel_type: [
      'Type:',
      'typed: true',
      'inserted via: insertText',
      'value now: hi',
      'submitted: false',
    ].join('\n'),
    browser_panel_press: [
      'Press:',
      'key: Tab',
      'focused: true',
      'sent: true',
    ].join('\n'),
    browser_panel_navigate: [
      'Navigate reload:',
      'url now: https://example.test/',
      'title now: Example',
    ].join('\n'),
    browser_panel_eval: ['Page returned:', '{', '  "ok": 1', '}'].join('\n'),
  }

  for (const definition of buildHarness().definitions) {
    if (definition.name === 'browser_panel_status' || definition.name === 'browser_panel_screenshot') continue
    const args = CALL_ARGS[definition.name]
    const value = await definition.execute(args, AGENT)
    const body = definition.output.render(args, value)[0].text
    assert.equal(body, expected[definition.name], `${definition.name} text changed`)
  }
})

test('screenshot reports the bytes it wrote, never a data URL', async () => {
  const { definitions } = buildHarness()
  const definition = definitions.find((item) => item.name === 'browser_panel_screenshot')
  const value = await definition.execute(CALL_ARGS.browser_panel_screenshot, AGENT)
  assert.equal(value.path, SHOT)
  assert.equal(value.bytes, 29)
  assert.equal(value.width, 1)
  assert.equal(value.height, 1)
  const body = definition.output.render(CALL_ARGS.browser_panel_screenshot, value)[0].text
  assert.match(body, /^Screenshot:\n/)
  assert.match(body, /Read it back with read_image/)
})

test('status describes the window rather than a bridge', async () => {
  const { definitions } = buildHarness()
  const definition = definitions.find((item) => item.name === 'browser_panel_status')
  const value = await definition.execute({}, AGENT)
  const body = definition.output.render({}, value)[0].text

  assert.match(body, /^Browser window:\n/)
  assert.match(body, /running: true/)
  assert.match(body, /mode: visible window/)
  assert.match(body, /window: 1000x700 at 120,120/)
  assert.match(body, /window name: AI 浏览器/)
  assert.match(body, /ownership badge: always \(in-page marker on every tab\)/)
  assert.match(body, /marker tab: T0/)
  assert.match(body, /1\. \[AI marker\] 🤖 AI 浏览器 · dsh-browser-panel — about:blank#dsh-ai-browser/)
  assert.match(body, /2\. \[selected\] \[owner: lead\] Example — https:\/\/example\.test\//)
  assert.match(body, /3\. \(untitled\) — https:\/\/other\.test\//)
  assert.match(body, /This session's tab: T1/)
  // The old bridge vocabulary must not come back.
  assert.doesNotMatch(body, /poll|lock|carrier/)
  assert.equal(value.selected, 'T1')
  assert.equal(value.marker, 'T0')
  assert.equal(value.pages.length, 3)
  assert.equal(value.pages.filter((page) => page.marker).length, 1)
  const owned = value.pages.find((page) => page.targetId === 'T1')
  assert.equal(owned.owner, 'agent-1')
  assert.equal(owned.ownerLabel, 'lead')
  assert.equal(owned.ownerActive, true)
  assert.equal(value.pages.find((page) => page.targetId === 'T2').owner, '')
  // Every page prints its id, because `adopt` takes one and the model only
  // ever sees this rendered text in native mode.
  assert.match(body, /2\. \[selected\] \[owner: lead\] Example — https:\/\/example\.test\/  \(id: T1\)/)
  assert.match(body, /3\. \(untitled\) — https:\/\/other\.test\/  \(id: T2\)/)
})

test('status flags a finished owner and points at that page\'s id for adopt', async () => {
  const service = fakeService()
  const finished = statusValue()
  finished.pages[2] = {
    ...finished.pages[2],
    agentBound: true,
    owner: 'agent-2',
    ownerLabel: '子 agent L1 #b26f74',
    ownerActive: false,
  }
  service.status = async () => finished
  const definition = buildToolDefinitions({ get: () => undefined }, service)
    .find((item) => item.name === 'browser_panel_status')
  const value = await definition.execute({}, AGENT)
  const body = definition.output.render({}, value)[0].text

  assert.match(body, /\[owner: 子 agent L1 #b26f74, finished\]/)
  assert.match(body, /\(id: T2\)/)
  assert.match(body, /call browser_panel_open with adopt set to that page's \(id: …\)/)
})

test('open declares the one-page rule and the adopt escape hatch', async () => {
  const seen = []
  const service = fakeService()
  service.open = async (agentId, options) => {
    seen.push({ agentId, ...options })
    return {
      requested: options.url, reuse: options.adopt !== '', url: PAGE_URL, title: 'Example',
      browser: 'Edg/154.0.4258.37', visible: true, owner: 'lead', adoptedFrom: '', released: '',
      note: 'ok',
    }
  }
  const definition = buildToolDefinitions({ get: () => undefined }, service)
    .find((item) => item.name === 'browser_panel_open')

  // No `reuse` switch: reuse is the only behaviour. Adoption is explicit.
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['adopt', 'url'])
  assert.equal(definition.parameters.required, undefined)
  assert.match(definition.description, /at most one page/)
  assert.match(definition.description, /adopt=<targetId/)

  await assert.rejects(definition.execute({}, AGENT), /pass url, adopt, or both/)
  await definition.execute({ adopt: 'T2' }, AGENT)
  assert.deepEqual(seen[0], { agentId: 'agent-1', url: '', adopt: 'T2' })
  await definition.execute({ url: PAGE_URL }, AGENT)
  assert.deepEqual(seen[1], { agentId: 'agent-1', url: PAGE_URL, adopt: '' })
})

test('the tool definitions are JSON-serializable, as the wire requires', () => {
  for (const definition of buildHarness().definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.isConcurrencySafe(), false)
    assert.ok(Number.isFinite(definition.timeoutMs))
    assert.doesNotThrow(() => JSON.stringify({ parameters: definition.parameters, output: definition.output.schema }))
  }
})

test('every tool keeps a budget that ends inside a turn', () => {
  for (const definition of buildHarness().definitions) {
    assert.ok(definition.timeoutMs >= 5000, `${definition.name} has an unusably small timeout`)
    assert.ok(definition.timeoutMs <= 180000, `${definition.name} would outlive the turn`)
  }
})

test('apply registers every tool and wires disposal', () => {
  const registered = []
  const disposers = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition.name) },
    on: (event, handler) => disposers.push([event, handler]),
    get: () => undefined,
  }
  apply(ctx, {})
  assert.equal(registered.length, 9)
  assert.deepEqual(disposers.map(([event]) => event), ['agent/created', 'agent/disposed', 'dispose'])
  // Disposal must be safe when no browser was ever started.
  const dispose = disposers.find(([event]) => event === 'dispose')[1]
  assert.doesNotThrow(() => dispose())
  // Lifecycle bookkeeping must tolerate a payload without an agent.
  assert.doesNotThrow(() => disposers[0][1]({}))
  assert.doesNotThrow(() => disposers[1][1]({}))
})

test('normalizeConfig clamps every knob and ignores the retired ones', () => {
  const defaults = normalizeConfig({})
  assert.deepEqual(defaults, {
    actionTimeoutMs: 20000,
    maxSnapshotChars: 12000,
    browserPath: '',
    profileDir: '',
    headless: false,
    windowWidth: 1280,
    windowHeight: 800,
    windowX: -1,
    windowY: -1,
    debugPort: 0,
    startUrl: 'about:blank',
    allowOrigins: '',
    windowName: 'AI 浏览器',
    ownership: 'always',
    markerTab: true,
    provision: 'ask',
  })

  // Only an explicit `true` runs windowless.
  assert.equal(normalizeConfig({ headless: 'yes' }).headless, false)
  assert.equal(normalizeConfig({ headless: true }).headless, true)

  // The ownership layer defaults to visible, and a typo cannot hide it.
  assert.equal(normalizeConfig({ ownership: 'sometimes' }).ownership, 'always')
  assert.equal(normalizeConfig({ ownership: 'off' }).ownership, 'off')
  assert.equal(normalizeConfig({ ownership: 'operating' }).ownership, 'operating')
  assert.equal(normalizeConfig({ ownership: false }).ownership, 'always')
  assert.equal(normalizeConfig({ markerTab: 'no' }).markerTab, true)
  assert.equal(normalizeConfig({ markerTab: false }).markerTab, false)
  assert.equal(normalizeConfig({ windowName: '  ' }).windowName, 'AI 浏览器')
  assert.equal(normalizeConfig({ windowName: '  AI 的浏览器  ' }).windowName, 'AI 的浏览器')

  assert.equal(normalizeConfig({ actionTimeoutMs: 10 }).actionTimeoutMs, 1000)
  assert.equal(normalizeConfig({ actionTimeoutMs: 999999 }).actionTimeoutMs, 120000)
  assert.equal(normalizeConfig({ maxSnapshotChars: 1 }).maxSnapshotChars, 500)
  assert.equal(normalizeConfig({ windowWidth: 10 }).windowWidth, 320)
  assert.equal(normalizeConfig({ windowHeight: 1 }).windowHeight, 240)
  assert.equal(normalizeConfig({ windowX: -5 }).windowX, -1)
  assert.equal(normalizeConfig({ debugPort: 70000 }).debugPort, 65535)
  assert.equal(normalizeConfig({ startUrl: '   ' }).startUrl, 'about:blank')
  assert.equal(normalizeConfig({ browserPath: '  C:\\edge.exe ' }).browserPath, 'C:\\edge.exe')
  assert.equal(normalizeConfig({ allowOrigins: ' example.com , a.test ' }).allowOrigins, 'example.com , a.test')

  // The retired bridge knobs must not reappear through a stale row.
  const stale = normalizeConfig({ pollWaitMs: 500, lockWhileOperating: true, idleReleaseMs: 3000 })
  assert.deepEqual(Object.keys(stale).sort(), Object.keys(defaults).sort())
  assert.equal(stale.pollWaitMs, undefined)
  assert.equal(stale.lockWhileOperating, undefined)
})
