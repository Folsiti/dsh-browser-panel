/**
 * The ownership layer: the four signals that tell a human whose browser window
 * this is, and the rules that keep them out of the way of the automation.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {
  BrowserWindowController,
  MARKER_HASH,
  MARKER_TITLE,
  OPERATION_LABELS,
  OWNERSHIP_FRAME_ID,
  OWNERSHIP_PILL_ID,
  PAGE_OWNERSHIP_PROMPT,
  agentLabel,
  apply,
  buildOwnershipScript,
  buildSnapshotExpression,
  normalizeConfig,
  ownershipExpression,
  seedProfileName,
  sessionTag,
} from '../host.js'

/** A temp directory that stands in for a browser profile. */
function profileFixture() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-ownership-'))
}

/** @param directory - profile fixture. @returns its parsed Local State, or null. */
function readLocalState(directory) {
  try {
    return JSON.parse(readFileSync(path.join(directory, 'Local State'), 'utf8'))
  } catch {
    return null
  }
}

test('the ownership script compiles and carries every identity it needs', () => {
  for (const mode of ['always', 'operating']) {
    const source = buildOwnershipScript({ mode, brand: 'AI 浏览器' })
    assert.doesNotThrow(() => new vm.Script(source), `${mode} script is not valid JavaScript`)
    assert.ok(source.includes(JSON.stringify(mode)))
    assert.ok(source.includes(JSON.stringify('AI 浏览器')))
    assert.ok(source.includes(JSON.stringify(MARKER_HASH)))
    assert.ok(source.includes(JSON.stringify(MARKER_TITLE)))
    assert.ok(source.includes(`window.__DSH_AI_OWNERSHIP__`))
  }
})

test('the ownership script is idempotent and stays out of the page\'s way', () => {
  const source = buildOwnershipScript({ mode: 'always', brand: 'AI 浏览器' })
  // Re-injecting must not stack a second badge.
  assert.match(source, /if \(window\.__DSH_AI_OWNERSHIP__\) return;/)
  // Every node it makes is tagged, so the snapshot can skip it and tests can find it.
  assert.match(source, /setAttribute\('data-dsh-ai', '1'\)/)
  // Nothing may intercept the user's or the page's clicks.
  assert.ok(source.includes('pointer-events:none'))
  // CSP safety: styles go through CSSOM, never a <style> element or a style attribute.
  assert.ok(!source.includes('<style'))
  assert.ok(!source.includes('style="'))
  assert.ok(!source.includes('innerHTML'))
  assert.ok(source.includes(OWNERSHIP_PILL_ID))
  assert.ok(source.includes(OWNERSHIP_FRAME_ID))
})

test('the ownership script covers both the badge and the marker card', () => {
  const source = buildOwnershipScript({ mode: 'always', brand: 'AI 浏览器' })
  assert.match(source, /function paintPill\(\)/)
  assert.match(source, /function paintCard\(\)/)
  assert.match(source, /function isMarker\(\)/)
  // The card explains the window; the badge names it.
  assert.ok(source.includes('这个窗口由 DSH 插件'))
  assert.ok(source.includes('你是主人'))
  assert.match(source, /var shown = !hidden && \(MODE === 'always' \|\| busy\);/)
})

test('every tab-using action has a label to show while it runs', () => {
  assert.deepEqual(Object.keys(OPERATION_LABELS).sort(), [
    'click', 'eval', 'navigate', 'open', 'press', 'screenshot', 'snapshot', 'type',
  ])
  for (const [action, label] of Object.entries(OPERATION_LABELS)) {
    assert.equal(typeof label, 'string', `${action} has no label`)
    assert.ok(label.length > 0, `${action} has an empty label`)
  }
})

test('ownershipExpression hands the state over as JSON, not as pasted text', () => {
  const hostile = '正在"点击"\n</script>'
  const expression = ownershipExpression('busy', hostile, sessionTag('agent-1'))
  assert.doesNotThrow(() => new vm.Script(expression))
  assert.ok(expression.includes(JSON.stringify(hostile)))
  assert.match(expression, /api\.set\("busy"/)
  assert.match(expression, /if \(!api\) return false;/)
})

test('sessionTag keeps the distinguishing tail of an id', () => {
  assert.equal(sessionTag('2f4e77aa-9c31-4d5e-8f0a-1b2c3d4e5f60'), '4e5f60')
  assert.equal(sessionTag('agent-1'), 'agent1')
  assert.equal(sessionTag(''), '')
  assert.equal(sessionTag(undefined), '')
  assert.equal(sessionTag('!!!'), '')
})

test('agentLabel names the owner, with a role and tag when no name exists', () => {
  // A team member name is the only human-readable identity, so it wins.
  assert.equal(agentLabel({ id: 'session-1', name: 'lead' }), 'lead')
  assert.equal(agentLabel({ id: 'session-1', name: '  researcher-a  ' }), 'researcher-a')
  // A main session without a name still carries something unique.
  assert.equal(agentLabel({ id: '2f4e77aa-9c31-4d5e-8f0a-1b2c3d4e5f60' }), '主会话 #4e5f60')
  // A subagent says so, and its depth when the session header knows it.
  assert.equal(agentLabel({ id: 'session-abcdef', subagent: true }), '子 agent L1 #abcdef')
  assert.equal(agentLabel({ id: 'session-abcdef', delegationDepth: 2 }), '子 agent L2 #abcdef')
  assert.equal(agentLabel({}), '主会话')
  assert.equal(agentLabel(), '主会话')
})

test('the page badge says who owns the page', () => {
  const source = buildOwnershipScript({ mode: 'always', brand: 'AI 浏览器' })
  assert.ok(source.includes('负责人'))
  // The owner is painted in both the busy and idle state, not only while busy.
  assert.match(source, /BRAND \+ \(busy && label \? .*\) \+ \(owner \? ' · 负责人 ' \+ owner : ''\)/)
})

test('the ownership rule is contributed to the system prompt', () => {
  assert.match(PAGE_OWNERSHIP_PROMPT, /one agent, one page/i)
  assert.match(PAGE_OWNERSHIP_PROMPT, /at most one page/)
  assert.match(PAGE_OWNERSHIP_PROMPT, /adopt=<targetId>/)
  assert.match(PAGE_OWNERSHIP_PROMPT, /subagent/)
})

test('the controller remembers owner labels and outlives an agent', async () => {
  const controller = new BrowserWindowController({}, {
    labelOf: (agent) => (agent?.id === 'session-1' ? 'researcher-a' : ''),
  })
  assert.equal(controller.noteAgent({ id: 'session-1' }), 'session-1')
  assert.equal(controller.labelOfAgent('session-1'), 'researcher-a')
  // An agent with no name still reads as an identifiable role plus tag.
  assert.equal(controller.labelOfAgent('agent-9'), '主会话 #agent9')
  assert.equal(controller.isAgentLive('session-1'), true)

  // A finished agent keeps its page, but the page's badge says it is finished
  // and another agent may adopt it.
  const expressions = []
  controller.tabs.set('session-1', {
    targetId: 'T9',
    client: {
      closed: false,
      async send(_method, params) {
        expressions.push(params.expression)
        return {}
      },
    },
  })
  controller.markAgentDisposed('session-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(controller.isAgentLive('session-1'), false)
  assert.equal(controller.ownerOfTarget('T9'), 'session-1')
  assert.ok(expressions.some((expression) => expression.includes('researcher-a（已结束）')))
})

test('apply contributes the ownership rule to the system prompt', () => {
  const sections = []
  const disposes = []
  const prompt = {
    section: (section) => {
      sections.push(section)
      return () => {}
    },
    getSectionOrder: () => 3000,
  }
  const ctx = {
    tools: { register: () => {} },
    on: (event, handler) => {
      if (event === 'dispose') disposes.push(handler)
    },
    // The service is fetched by name: `ctx.systemPrompt` is absent unless the
    // plugin injects it, which is exactly how the first release missed the rule.
    get: (name) => (name === 'systemPrompt' ? prompt : undefined),
    effect: (install) => {
      disposes.push(install())
    },
  }
  apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'browser-panel:page-ownership')
  assert.equal(sections[0].text, PAGE_OWNERSHIP_PROMPT)
  assert.equal(sections[0].order, 3000)
  for (const dispose of disposes) assert.doesNotThrow(() => dispose())
})

test('the snapshot suspends the badge and skips its nodes', () => {
  const expression = buildSnapshotExpression(4000)
  assert.doesNotThrow(() => new vm.Script(expression))
  assert.match(expression, /ownership\.suspend\(\)/)
  assert.match(expression, /ownership\.resume\(\)/)
  assert.match(expression, /closest\('\[data-dsh-ai\]'\) !== null/)
  assert.match(expression, /finally/)
})

test('seedProfileName names a fresh profile before the first launch', async () => {
  const directory = profileFixture()
  await seedProfileName(directory, 'AI 浏览器')
  const state = readLocalState(directory)
  assert.equal(state.profile.info_cache.Default.name, 'AI 浏览器')
  assert.equal(state.profile.info_cache.Default.shortcut_name, 'AI 浏览器')
  assert.deepEqual(state.profile.profiles_order, ['Default'])
})

test('seedProfileName replaces a name Chromium generated for itself', async () => {
  const directory = profileFixture()
  writeFileSync(path.join(directory, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: '用户配置 1' } }, profiles_order: ['Default'] },
    unrelated: { keep: true },
  }))
  await seedProfileName(directory, 'AI 浏览器')
  const state = readLocalState(directory)
  assert.equal(state.profile.info_cache.Default.name, 'AI 浏览器')
  // Everything else in the file must survive the edit.
  assert.deepEqual(state.unrelated, { keep: true })
})

test('seedProfileName never overwrites a name the user chose', async () => {
  const directory = profileFixture()
  writeFileSync(path.join(directory, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: '我的浏览器' } } } }))
  await seedProfileName(directory, 'AI 浏览器')
  assert.equal(readLocalState(directory).profile.info_cache.Default.name, '我的浏览器')
})

test('seedProfileName leaves a Local State it cannot parse alone', async () => {
  const directory = profileFixture()
  writeFileSync(path.join(directory, 'Local State'), '{ this is not json')
  await assert.doesNotReject(seedProfileName(directory, 'AI 浏览器'))
  assert.equal(readFileSync(path.join(directory, 'Local State'), 'utf8'), '{ this is not json')
})

test('seedProfileName is a no-op once the name is already right', async () => {
  const directory = profileFixture()
  await seedProfileName(directory, 'AI 浏览器')
  const first = readLocalState(directory)
  await seedProfileName(directory, 'AI 浏览器')
  assert.deepEqual(readLocalState(directory), first)
})

test('an unconfigured ownership layer injects nothing', async () => {
  const sent = []
  const controller = new BrowserWindowController({ ownership: 'off' })
  const client = {
    closed: false,
    async send(method) {
      sent.push(method)
      return {}
    },
  }
  await controller.installOwnership(client)
  await controller.paint(client, 'busy', '正在点击', 'abc123')
  assert.deepEqual(sent, [], 'ownership "off" must not touch the page at all')
})

test('a configured ownership layer registers the script and paints the state', async () => {
  const sent = []
  const controller = new BrowserWindowController({ ownership: 'always', windowName: '我的 AI 浏览器' })
  const client = {
    closed: false,
    async send(method, params) {
      sent.push({ method, params })
      return {}
    },
  }
  await controller.installOwnership(client)
  await controller.paint(client, 'busy', '正在点击', 'abc123')

  assert.deepEqual(sent.map((entry) => entry.method), [
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'Runtime.evaluate',
  ])
  // `addScriptToEvaluateOnNewDocument` only covers documents that have not
  // loaded yet, so the same source has to be run once in the current one.
  assert.equal(sent[1].params.expression, sent[0].params.source)
  assert.ok(sent[0].params.source.includes('我的 AI 浏览器'))
  assert.match(sent[2].params.expression, /api\.set\("idle"/)
  assert.match(sent[3].params.expression, /api\.set\("busy", "正在点击", "abc123"\)/)
})

test('a badge that cannot be painted never breaks the action', async () => {
  const controller = new BrowserWindowController({ ownership: 'always' })
  const client = {
    closed: false,
    async send() {
      throw new Error('the page is showing a dialog')
    },
  }
  await assert.doesNotReject(controller.installOwnership(client))
  await assert.doesNotReject(controller.paint(client, 'busy', '正在点击', 'abc'))
  // A closed connection is not worth even trying.
  await assert.doesNotReject(controller.paint({ closed: true }, 'busy', 'x', 'y'))
})

test('the ownership knobs survive normalizeConfig unchanged where they should', () => {
  assert.equal(normalizeConfig({ ownership: 'operating', markerTab: false, windowName: 'AI' }).markerTab, false)
  assert.equal(normalizeConfig({ ownership: 'operating' }).ownership, 'operating')
})
