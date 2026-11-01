/**
 * End-to-end: drive a real browser window through the real tool definitions.
 *
 * A local fixture site is served, the controller starts a browser, and every one
 * of the nine tools is called exactly the way the model calls it. Nothing here
 * is mocked: the browser is a real Chromium, the clicks are real synthesized
 * input, and the screenshot is a real PNG.
 *
 *   node e2e/browser.mjs                         headless (no window on screen)
 *   node e2e/browser.mjs --visible               with a real window
 *   node e2e/browser.mjs --visible --hold 8000   keep that window up for 8 s
 *   node e2e/browser.mjs --visible --hold 8000 --marker-front   ... on the marker tab
 *
 * Skipped, not failed, when no Chromium-family browser is installed.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import {
  BrowserWindowController,
  buildToolDefinitions,
  DECLINE_ANSWER,
  DOWNLOAD_ANSWER,
  findBrowser,
  normalizeConfig,
  pngSize,
  VERSION,
} from '../host.js'

const PAGES = {
  '/': { body: `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture One</title></head>
<body>
  <h1>Fixture One</h1>
  <p id="note">Local fixture text.</p>
  <p id="long">${'Lorem ipsum dolor sit amet. '.repeat(60)}</p>
  <a id="next" href="/second">Go to second</a>
  <input id="field" type="text" placeholder="type here">
  <form id="search" action="/second" method="get">
    <input id="q" name="q" type="text" placeholder="search">
  </form>
  <button id="shout" type="button" onclick="document.getElementById('out').textContent = 'clicked'">Shout</button>
  <div id="divbtn" onclick="document.getElementById('out').textContent = 'div clicked'">Deep button</div>
  <div id="out"></div>
</body></html>` },
  '/second': { body: `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture Two</title></head>
<body>
  <h1>Fixture Two</h1>
  <a id="back" href="/">Back to first</a>
</body></html>` },
  // A page that forbids every kind of inline content: the ownership badge must
  // still appear, because the browser injects it rather than the document.
  '/csp': {
    body: `<!doctype html>
<html><head><meta charset="utf-8"><title>CSP page</title></head>
<body><p id="csp-note">strict csp body</p></body></html>`,
    csp: "default-src 'none'; script-src 'none'; style-src 'none'",
  },
  // A page that is white edge to edge: any pixel that is not white in a capture
  // of it came from the ownership layer rather than from the page.
  '/clean': {
    body: `<!doctype html>
<html><head><meta charset="utf-8"><title>Clean capture</title>
<style>html,body{margin:0;height:100%;background:#ffffff}</style></head>
<body><p id="clean-note" style="margin:0">plain page for capture checks</p></body></html>`,
  },
}

const argv = process.argv.slice(2)
const visible = argv.includes('--visible')
const holdIndex = argv.indexOf('--hold')
const holdMs = holdIndex < 0 ? 0 : Number(argv[holdIndex + 1] ?? 0)

/** Run one named check, printing its outcome. */
async function step(name, body) {
  const started = Date.now()
  const value = await body()
  console.log(`  ok  ${name}  (${Date.now() - started} ms)`)
  return value
}

/** @returns a listening fixture server and its origin. */
async function startFixture() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const page = PAGES[pathname]
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<title>Missing</title><p>no such fixture page</p>')
      return
    }
    const headers = { 'content-type': 'text/html; charset=utf-8' }
    if (page.csp !== undefined) headers['content-security-policy'] = page.csp
    response.writeHead(200, headers)
    response.end(page.body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

/** @param ms - how long to wait. @returns a promise. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** PNG row filter type 4 (Paeth), spelled out because Node has no decoder. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode an 8-bit non-interlaced PNG (colour types 2 and 6) enough to read pixels.
 *
 * The screenshot checks are about what the compositor actually painted, and the
 * only witness for that is the PNG itself: reading the DOM back would say
 * "hidden" even if the overlay were already baked into the image.
 *
 * @param bytes - the PNG file.
 * @returns `{ width, height, at(x, y), darkestIn(x0, y0, x1, y1) }`.
 */
function decodePng(bytes) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1')
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      assert.equal(chunk[8], 8, 'expected an 8-bit PNG')
      colorType = chunk[9]
      assert.ok(colorType === 2 || colorType === 6, `unexpected PNG colour type ${colorType}`)
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    offset += 8 + length + 4
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prior = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prior[x]
      const c = x >= channels ? prior[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += Math.floor((a + b) / 2)
      else if (filter === 4) value += paeth(a, b, c)
      out[x] = value & 0xff
    }
  }
  const at = (x, y) => {
    const index = y * stride + x * channels
    return { r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] }
  }
  const darkestIn = (x0, y0, x1, y1) => {
    let darkest = { x: x0, y: y0, r: 255, g: 255, b: 255, luma: 255 }
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const pixel = at(x, y)
        const luma = 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b
        if (luma < darkest.luma) darkest = { x, y, ...pixel, luma }
      }
    }
    return darkest
  }
  return { width, height, at, darkestIn }
}

let fixture
let controller
const profileDir = mkdtempSync(path.join(tmpdir(), 'dsh-browser-panel-e2e-'))
const shotDir = mkdtempSync(path.join(tmpdir(), 'dsh-browser-panel-shots-'))

try {
  console.log(`browser: ${findBrowser(normalizeConfig({}))}`)
  console.log(`mode:    ${visible ? 'visible window' : 'headless'}\n`)

  fixture = await startFixture()
  controller = new BrowserWindowController({
    headless: !visible,
    profileDir,
    actionTimeoutMs: 20000,
    maxSnapshotChars: 4000,
    windowWidth: 1100,
    windowHeight: 720,
  })
  const tools = new Map(buildToolDefinitions({ get: () => undefined }, controller).map((definition) => [definition.name, definition]))
  const call = (name, args = {}, agentId = 'agent-1') => tools.get(name).execute(args, { agent: { id: agentId } })

  await step('status is read-only before anything is opened', async () => {
    const value = await call('browser_panel_status')
    assert.equal(value.running, false)
    assert.equal(value.pages.length, 0)
    assert.equal(value.selected, '')
    assert.equal(value.version, VERSION)
    assert.equal(value.profileDir, profileDir)
    // Nothing above may have started a browser.
    assert.equal(controller.running, false)
    return value
  })

  const opened = await step('open starts the browser and loads the page', async () => {
    const value = await call('browser_panel_open', { url: fixture.origin })
    assert.equal(value.requested, fixture.origin)
    assert.equal(value.reuse, false)
    assert.equal(value.url, `${fixture.origin}/`)
    assert.equal(value.title, 'Fixture One')
    assert.equal(value.visible, visible)
    assert.match(value.browser, /(Edg|Chrome|Chromium|Brave)\//)
    assert.match(value.note, /opened a new tab/)
    return value
  })
  console.log(`      browser reported: ${opened.browser}`)

  await step('the window says it is the AI\'s, in the way the OS shows it', async () => {
    const status = await call('browser_panel_status')
    assert.equal(status.windowName, 'AI 浏览器')
    assert.equal(status.ownership, 'always')
    assert.notEqual(status.marker, '')
    const marker = status.pages.find((page) => page.marker)
    assert.ok(marker !== undefined, 'the marker tab should be listed')
    assert.ok(marker.url.endsWith('#dsh-ai-browser'), `unexpected marker url ${marker.url}`)
    assert.match(marker.title, /AI 浏览器/)
    assert.equal(marker.agentBound, false, 'no session may own the marker tab')
    assert.notEqual(status.selected, status.marker, 'the marker tab must not be the session tab')
    // The profile name is what the OS window title, taskbar tooltip and
    // alt-tab read, and it has to be written before the browser first runs.
    const localState = JSON.parse(readFileSync(path.join(profileDir, 'Local State'), 'utf8'))
    assert.equal(localState.profile.info_cache.Default.name, 'AI 浏览器')
    return status
  })

  await step('every page carries the AI badge, and a fresh document gets it too', async () => {
    const probe = 'return { installed: window.__DSH_AI_OWNERSHIP__ !== undefined, pill: document.getElementById("dsh-ai-ownership") !== null, text: (document.getElementById("dsh-ai-ownership") || {}).textContent || "", paints: (window.__DSH_AI_OWNERSHIP__ || {}).paints || 0 }'
    // Read from inside a tool call, which is also the moment the badge is lit.
    const busy = await call('browser_panel_eval', { script: probe })
    assert.equal(busy.value.installed, true)
    assert.equal(busy.value.pill, true)
    assert.ok(busy.value.text.includes('AI 浏览器'), `badge reads "${busy.value.text}"`)
    assert.match(busy.value.text, /正在执行脚本/, 'the badge should name the action while it runs')
    assert.ok(busy.value.paints >= 2, `expected the badge to have been painted, got ${busy.value.paints}`)

    // Read the same badge with nothing in flight, straight from the tab.
    const idle = await controller.tabs.get('agent-1').client.send('Runtime.evaluate', {
      expression: 'document.getElementById("dsh-ai-ownership").textContent',
      returnByValue: true,
    })
    assert.match(idle.result.value, /空闲/, `idle badge reads "${idle.result.value}"`)
    assert.match(idle.result.value, /#agent1/, 'the badge should name the session that owns the tab')

    await call('browser_panel_navigate', { direction: 'reload' })
    const reloaded = await call('browser_panel_eval', { script: probe })
    assert.equal(reloaded.value.pill, true, 'the badge must come back after a navigation')
  })

  await step('a page with a strict CSP still gets the badge', async () => {
    await call('browser_panel_open', { url: `${fixture.origin}/csp` })
    const probe = await call('browser_panel_eval', {
      script: 'return { href: location.href, pill: document.getElementById("dsh-ai-ownership") !== null }',
    })
    assert.ok(probe.value.href.endsWith('/csp'), `expected the CSP page, got ${probe.value.href}`)
    assert.equal(probe.value.pill, true, 'CSP must not be able to hide the badge')
  })

  await step('the marker tab explains the window and tracks the AI state', async () => {
    const probe = await controller.marker.client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, hash: location.hash, card: document.getElementById("dsh-ai-marker") !== null, status: (document.getElementById("dsh-ai-marker-status") || {}).textContent || "", body: document.body.innerText })',
      returnByValue: true,
    })
    const view = JSON.parse(probe.result.value)
    assert.equal(view.hash, '#dsh-ai-browser')
    assert.equal(view.card, true)
    assert.match(view.title, /AI 浏览器/)
    assert.match(view.status, /AI 空闲|AI 正在操作/)
    assert.match(view.body, /这个窗口由 DSH 插件/)
    assert.match(view.body, /你是主人/)
  })

  await step('the badge never leaks into what the model reads', async () => {
    const page = await call('browser_panel_snapshot')
    assert.match(page.text, /strict csp body/)
    assert.doesNotMatch(page.text, /AI 浏览器|dsh-sidebar-browser|空闲/)
    assert.ok(page.outline.every((item) => !item.ref.includes('dsh-ai')), 'the badge must not appear in the outline')
  })

  await step('open goes back to the fixture for the rest of the run', async () => {
    const value = await call('browser_panel_open', { url: `${fixture.origin}/` })
    assert.equal(value.title, 'Fixture One')
  })

  await step('snapshot finds the link, its href and the page text', async () => {
    const value = await call('browser_panel_snapshot')
    assert.equal(value.url, `${fixture.origin}/`)
    assert.equal(value.title, 'Fixture One')
    assert.equal(value.truncated, false)
    assert.match(value.text, /Local fixture text\./)
    const link = value.outline.find((item) => item.href.endsWith('/second'))
    assert.ok(link !== undefined, 'the link should appear in the outline')
    assert.equal(link.tag, 'a')
    assert.equal(link.text, 'Go to second')
    assert.ok(link.ref !== '', 'the outline entry needs a ref to click with')
    const field = value.outline.find((item) => item.tag === 'input')
    assert.equal(field.ref, '#field')
    return value
  })

  await step('snapshot honours maxChars, and floors it at 500', async () => {
    const value = await call('browser_panel_snapshot', { maxChars: 500 })
    assert.equal(value.truncated, true)
    // The host trims the page text, so a capped window can come back one
    // character short of the cap.
    assert.ok(value.text.length <= 500 && value.text.length >= 480, `expected ~500 characters, got ${value.text.length}`)
    const floored = await call('browser_panel_snapshot', { maxChars: 12 })
    assert.ok(floored.text.length <= 500 && floored.text.length >= 480, 'the tool contract floors maxChars at 500')
    assert.ok(floored.text.length > 12, 'a maxChars below the floor must not be honoured literally')
  })

  await step('eval runs an async function body in the page', async () => {
    assert.equal((await call('browser_panel_eval', { script: 'return document.title' })).value, 'Fixture One')
    assert.equal((await call('browser_panel_eval', { script: 'return await Promise.resolve(41 + 1)' })).value, 42)
    assert.deepEqual((await call('browser_panel_eval', { script: 'return { tags: document.querySelectorAll("a").length }' })).value, { tags: 1 })
  })

  await step('type enters real keyboard text and reads it back', async () => {
    const value = await call('browser_panel_type', { selector: '#field', text: 'hello from the agent' })
    assert.equal(value.typed, true)
    assert.equal(value.inserted, 'insertText')
    assert.equal(value.editable, true)
    assert.equal(value.value, 'hello from the agent')
    return value
  })

  await step('type with clear replaces the field contents', async () => {
    const value = await call('browser_panel_type', { selector: '#field', text: 'X', clear: true })
    assert.equal(value.value, 'X')
  })

  await step('type refuses a field that cannot take text', async () => {
    const value = await call('browser_panel_type', { selector: '#shout', text: 'nope' })
    assert.equal(value.typed, false)
    assert.match(value.reason, /not an input, textarea, or contenteditable/)
  })

  await step('press sends a named key and refuses an unknown one', async () => {
    const sent = await call('browser_panel_press', { key: 'Tab', selector: '#field' })
    assert.equal(sent.sent, true)
    assert.equal(sent.focused, true)
    assert.equal(sent.selectorChecked, true)
    // A key is only useful if its default action runs: Tab has to move focus.
    const moved = await call('browser_panel_eval', { script: 'return document.activeElement ? document.activeElement.id : ""' })
    assert.equal(moved.value, 'q', `Tab should focus the next control, focus is on "${moved.value}"`)
    const refused = await call('browser_panel_press', { key: 'F5' })
    assert.equal(refused.sent, false)
    assert.match(refused.note, /is not a key this tool expresses/)
    const char = await call('browser_panel_press', { key: 'z' })
    assert.equal(char.sent, true)
  })

  await step('click by label navigates, and the new URL is read back', async () => {
    const value = await call('browser_panel_click', { text: 'Go to second' })
    assert.equal(value.matched, true)
    assert.equal(value.label, 'Go to second')
    assert.ok(value.url.endsWith('/second'), `expected /second, read ${value.url}`)
    const page = await call('browser_panel_snapshot')
    assert.equal(page.title, 'Fixture Two')
    return value
  })

  await step('click reports a miss instead of pretending', async () => {
    const value = await call('browser_panel_click', { selector: '#nowhere' })
    assert.equal(value.matched, false)
    assert.equal(value.reason, 'selector matched no element')
    assert.match(value.url, /\/second$/)
  })

  await step('navigate goes back through the tab history', async () => {
    const value = await call('browser_panel_navigate', { direction: 'back' })
    assert.equal(value.url, `${fixture.origin}/`)
    assert.equal(value.title, 'Fixture One')
    assert.equal((await call('browser_panel_navigate', { direction: 'reload' })).title, 'Fixture One')
  })

  await step('click by text reaches a control that is only a div with an onclick', async () => {
    // Found on a real site: a model dropdown built from <div onclick> with no
    // role at all. The curated clickable set missed it, which made text-clicking
    // impossible on a whole class of interfaces.
    const value = await call('browser_panel_click', { text: 'Deep button' })
    assert.equal(value.matched, true, `expected the div to be clickable, got ${value.reason}`)
    assert.equal(value.ref, '#divbtn')
    const fired = await call('browser_panel_eval', { script: 'return document.getElementById("out").textContent' })
    assert.equal(fired.value, 'div clicked', 'the div\'s own handler must have run')
  })

  await step('a text click that misses says what the page does have', async () => {
    const value = await call('browser_panel_click', { text: 'Deep butto' })
    assert.equal(value.matched, false)
    assert.match(value.reason, /nothing matched that text exactly; labels containing it read:.*Deep button/)
  })

  let shotPath
  await step('screenshot writes a real PNG next to the session workspace', async () => {
    shotPath = path.join(shotDir, 'shot.png')
    const value = await call('browser_panel_screenshot', { path: shotPath })
    assert.equal(value.path, shotPath)
    const bytes = readFileSync(shotPath)
    assert.equal(bytes.length, value.bytes)
    assert.ok(bytes.length > 2000, `expected a real image, got ${bytes.length} bytes`)
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
    assert.deepEqual({ width: value.width, height: value.height }, pngSize(bytes))
    assert.ok(value.width > 500 && value.height > 300, `unexpected capture size ${value.width}x${value.height}`)
    return value
  })
  console.log(`      wrote ${shotPath}`)

  await step('a clean capture leaves the AI badge and amber frame out of the PNG', async () => {
    await call('browser_panel_open', { url: `${fixture.origin}/clean` })
    const cleanPath = path.join(shotDir, 'clean.png')
    const value = await call('browser_panel_screenshot', { path: cleanPath })
    const image = decodePng(readFileSync(cleanPath))
    // The fixture is white edge to edge and the frame is 3px inset, so the four
    // inside corners say whether it was captured.
    const corners = [[1, 1], [image.width - 2, 1], [1, image.height - 2], [image.width - 2, image.height - 2]]
    for (const [x, y] of corners) {
      const pixel = image.at(x, y)
      assert.ok(pixel.r > 240 && pixel.g > 240 && pixel.b > 240, `clean PNG has AI chrome at ${x},${y}: ${JSON.stringify(pixel)}`)
    }
    // The badge lives bottom-right; nothing that dark belongs to this page.
    const darkest = image.darkestIn(image.width - 460, image.height - 90, image.width - 1, image.height - 1)
    assert.ok(darkest.luma > 200, `clean PNG still contains the badge: ${JSON.stringify(darkest)}`)
    // The layer is hidden only for the instant of the capture: it is back on
    // screen by the time the tool returns.
    const onScreen = await call('browser_panel_eval', {
      script: 'const el = document.getElementById("dsh-ai-ownership"); return el === null ? "" : el.style.display',
    })
    assert.notEqual(onScreen.value, 'none', 'the badge must be back on screen after the capture')
    console.log(`      wrote ${cleanPath}`)
    return value
  })

  await step('screenshot: marked keeps the badge and frame in the PNG', async () => {
    const markedProfile = mkdtempSync(path.join(tmpdir(), 'dsh-browser-panel-marked-'))
    const marked = new BrowserWindowController({ profileDir: markedProfile, headless: true, screenshot: 'marked' })
    try {
      const markedTools = new Map(buildToolDefinitions({ get: () => undefined }, marked).map((definition) => [definition.name, definition]))
      const agent = { agent: { id: 'agent-marked' } }
      await markedTools.get('browser_panel_open').execute({ url: `${fixture.origin}/clean` }, agent)
      const markedPath = path.join(shotDir, 'marked.png')
      const value = await markedTools.get('browser_panel_screenshot').execute({ path: markedPath }, agent)
      const image = decodePng(readFileSync(markedPath))
      const corner = image.at(1, 1)
      assert.ok(corner.r > 200 && corner.g > 140 && corner.b < 160, `marked PNG lost the amber frame: ${JSON.stringify(corner)}`)
      const darkest = image.darkestIn(image.width - 460, image.height - 90, image.width - 1, image.height - 1)
      assert.ok(darkest.luma < 120, `marked PNG is missing the badge: ${JSON.stringify(darkest)}`)
      console.log(`      wrote ${markedPath}`)
      return value
    } finally {
      marked.dispose()
      await sleep(400)
      rmSync(markedProfile, { recursive: true, force: true })
    }
  })

  await step('status now describes a running window with a bound tab', async () => {
    const value = await call('browser_panel_status')
    assert.equal(value.running, true)
    assert.ok(value.pid > 0)
    assert.ok(value.debugPort > 0)
    assert.equal(value.visible, visible)
    assert.equal(value.headless, !visible)
    assert.ok(value.pages.length >= 1)
    assert.notEqual(value.selected, '')
    assert.equal(value.pages.filter((page) => page.selected).length, 1)
    assert.equal(value.pages.find((page) => page.selected).targetId, value.selected)
    if (visible) {
      assert.ok(value.window.width > 0 && value.window.height > 0, 'a visible window must report its rectangle')
      console.log(`      window rectangle: ${value.window.width}x${value.window.height} at ${value.window.left},${value.window.top}`)
    }
    assert.equal(value.lastError, '')
    return value
  })

  await step('a second session gets its own tab, and neither steals the other', async () => {
    const first = await call('browser_panel_status', {}, 'agent-1')
    const second = await call('browser_panel_open', { url: `${fixture.origin}/second` }, 'agent-2')
    assert.ok(second.url.endsWith('/second'))
    const firstAfter = await call('browser_panel_status', {}, 'agent-1')
    const secondAfter = await call('browser_panel_status', {}, 'agent-2')
    assert.equal(firstAfter.selected, first.selected, 'the first session must keep its own tab')
    assert.notEqual(secondAfter.selected, first.selected, 'the second session must get its own tab')
    assert.ok(firstAfter.pages.length >= 2, 'both tabs should be listed')
    assert.ok(firstAfter.pages.filter((page) => page.agentBound).length >= 2)
    // Ownership is part of the status contract, not just decoration.
    assert.equal(firstAfter.pages.find((page) => page.selected).owner, 'agent-1')
    assert.equal(secondAfter.pages.find((page) => page.selected).owner, 'agent-2')
    assert.equal(secondAfter.pages.find((page) => page.selected).ownerActive, true)
  })

  await step('the same agent cannot grow a second page, by design', async () => {
    const before = await call('browser_panel_status', {}, 'agent-1')
    const again = await call('browser_panel_open', { url: `${fixture.origin}/second` }, 'agent-1')
    assert.equal(again.reuse, true, 'a second open navigates the page the agent already owns')
    assert.match(again.note, /one page per agent/)
    assert.equal(again.owner, '主会话 #agent1')
    const after = await call('browser_panel_status', {}, 'agent-1')
    assert.equal(after.selected, before.selected, 'the same agent keeps the same page')
    assert.equal(after.pages.length, before.pages.length, 'a second open must not add a tab')
    assert.equal(after.pages.filter((page) => page.owner === 'agent-1').length, 1)
  })

  await step('a page owned by a running agent cannot be adopted', async () => {
    const second = await call('browser_panel_status', {}, 'agent-2')
    const target = second.pages.find((page) => page.owner === 'agent-2').targetId
    await assert.rejects(
      call('browser_panel_open', { adopt: target }, 'agent-1'),
      /still owned by an active agent/,
    )
  })

  await step('a finished agent\'s page can be adopted without adding a tab', async () => {
    const second = await call('browser_panel_status', {}, 'agent-2')
    const target = second.pages.find((page) => page.owner === 'agent-2').targetId
    const before = await call('browser_panel_status', {}, 'agent-1')

    // The lifecycle event is what production receives when a subagent ends.
    controller.markAgentDisposed('agent-2')

    const adopted = await call('browser_panel_open', { adopt: target }, 'agent-1')
    assert.equal(adopted.reuse, true)
    assert.match(adopted.adoptedFrom, /agent2/)
    assert.equal(adopted.released, before.selected, 'the adopter\'s previous page is released, not closed')

    const after = await call('browser_panel_status', {}, 'agent-1')
    assert.equal(after.selected, target)
    assert.equal(after.pages.length, before.pages.length, 'adoption must not add a tab')
    const released = after.pages.find((page) => page.targetId === adopted.released)
    assert.equal(released.agentBound, false, 'the released page stays open but no longer belongs to anyone')
    assert.equal(after.pages.find((page) => page.selected).owner, 'agent-1')

    // The adopted page's badge now names its new owner.
    const pill = await controller.tabs.get('agent-1').client.send('Runtime.evaluate', {
      expression: 'document.getElementById("dsh-ai-ownership").textContent',
      returnByValue: true,
    })
    assert.match(pill.result.value, /负责人 主会话 #agent1/, `adopted badge reads "${pill.result.value}"`)

    // The agent that lost its page is told what to do next, not left guessing.
    await assert.rejects(call('browser_panel_snapshot', {}, 'agent-2'), /no browser tab is bound to this session/)
  })

  await step('a session without a tab is told to open one', async () => {
    await assert.rejects(call('browser_panel_snapshot', {}, 'agent-3'), /no browser tab is bound to this session/)
  })

  await step('typing then Enter submits a real form, two ways', async () => {
    await call('browser_panel_open', { url: `${fixture.origin}/` })
    const typed = await call('browser_panel_type', { selector: '#q', text: 'fixture query', clear: true, submit: true })
    assert.equal(typed.submitted, true)
    assert.equal(typed.value, 'fixture query')
    const afterSubmit = await call('browser_panel_snapshot')
    assert.ok(/\/second\?q=fixture[+%20]query/.test(afterSubmit.url), `submit=true should have sent the form, got ${afterSubmit.url}`)
    assert.equal(afterSubmit.title, 'Fixture Two')

    await call('browser_panel_navigate', { direction: 'back' })
    await call('browser_panel_type', { selector: '#q', text: 'second try', clear: true })
    const pressed = await call('browser_panel_press', { key: 'Enter', selector: '#q' })
    assert.equal(pressed.sent, true)
    assert.equal(pressed.focused, true)
    const afterPress = await call('browser_panel_snapshot')
    assert.ok(/\/second\?q=second[+%20]try/.test(afterPress.url), `Enter should have submitted the form, got ${afterPress.url}`)
  })

  await step('a browser that is not a browser is explained, with its own output', async () => {
    // `where.exe` starts fine and never opens a devtools port — the same shape as
    // a snap build AppArmor turned away, or a binary missing a shared library.
    // Before this change the whole report was "the browser window closed (exit code 2)".
    const brokenProfile = mkdtempSync(path.join(tmpdir(), 'dsh-broken-browser-'))
    const broken = new BrowserWindowController({
      browserPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/bin/false',
      profileDir: brokenProfile,
    })
    const error = await broken.open('agent-1', { url: `${fixture.origin}/` }, { agent: { id: 'agent-1' } })
      .then(() => null, (thrown) => thrown)
    const message = error instanceof Error ? error.message : String(error)
    broken.dispose()
    rmSync(brokenProfile, { recursive: true, force: true })

    assert.ok(error !== null, 'a non-browser must not be accepted')
    assert.equal(error.kind, 'exited')
    assert.match(message, /where\.exe|\/bin\/false/, 'the report must name the binary it tried')
    assert.match(message, /exited with code/)
    assert.match(message, /Its output was:/, 'the browser\'s own stderr must survive')
    if (process.platform === 'win32') assert.match(message, /Invalid pattern/)
    assert.match(error.remedy, /confined or incomplete install/)
    assert.match(error.remedy, /browserPath/)
  })

  await step('with no browser at all, status explains it and open asks before downloading', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'dsh-no-browser-'))
    const asked = []
    const offline = new BrowserWindowController(
      { profileDir: path.join(bare, 'profile') },
      {
        env: { HOME: bare, USERPROFILE: bare, ProgramFiles: 'C:\\nowhere', 'ProgramFiles(x86)': 'C:\\nowhere', LOCALAPPDATA: '', PATH: '' },
        platform: 'win32',
        ask: async (request) => {
          asked.push(request)
          return { answers: [{ id: request.questions[0].id, selected: [DECLINE_ANSWER] }] }
        },
      },
    )
    await offline.start()
    const reported = await offline.status('agent-1')
    assert.equal(reported.running, false)
    assert.equal(reported.browserAvailable, false)
    assert.deepEqual(reported.browserFound, [])
    assert.match(reported.browserRemedy, /Install one:/)
    assert.equal(reported.provision, 'missing')

    const declined = await offline.open('agent-1', { url: `${fixture.origin}/` }, { agent: { id: 'agent-1' } })
      .then(() => null, (thrown) => thrown)
    assert.equal(declined.kind, 'declined')
    assert.equal(asked.length, 1, 'the question is asked once')
    assert.equal(asked[0].questions[0].id, 'browser-download')
    assert.deepEqual(asked[0].questions[0].options.map((option) => option.label), [DOWNLOAD_ANSWER, DECLINE_ANSWER])
    assert.ok(existsSync(offline.provisionStateFile()), 'the refusal is remembered on disk')

    // And the refusal holds: the second call fails without asking again.
    const again = await offline.open('agent-1', { url: `${fixture.origin}/` }, { agent: { id: 'agent-1' } })
      .then(() => null, (thrown) => thrown)
    assert.equal(again.kind, 'declined')
    assert.equal(asked.length, 1, 'a declined user is never asked twice')
    assert.equal((await offline.status('agent-1')).provision, 'declined')

    offline.dispose()
    rmSync(bare, { recursive: true, force: true })
  })

  if (visible && holdMs > 0) {
    if (argv.includes('--marker-front')) {
      // For the screenshot that documents the marker tab itself.
      await controller.marker.client.send('Page.bringToFront', {}, 5000)
    }
    console.log(`\nholding the window on screen for ${holdMs} ms ...`)
    await sleep(holdMs)
  }

  await step('a second controller reuses the browser that is already running', async () => {
    // Exactly the situation an Edge 155 launcher creates: the profile is held by
    // a browser this controller did not start. It has to attach to it, not spawn
    // a second one that would hand off and exit.
    const second = new BrowserWindowController({ profileDir, headless: !visible })
    const value = await second.open('agent-2', { url: `${fixture.origin}/` }, { agent: { id: 'agent-2' } })
    assert.equal(value.url, `${fixture.origin}/`)
    const status = await second.status('agent-2')
    assert.equal(status.reused, true, 'the second controller should have adopted the running browser')
    assert.equal(status.running, true)
    assert.ok(status.pages.some((page) => page.url === `${fixture.origin}/`), 'the adopted browser serves the same profile')
    // It must reuse the marker tab from the session that started the browser,
    // not add a second one on every adoption.
    assert.equal(status.pages.filter((page) => page.url.endsWith('#dsh-ai-browser')).length, 1, 'the marker tab is reused, not duplicated')
    // Release its sockets without closing the shared browser: the first
    // controller still owns that one and disposes it at the end.
    second.forgetBrowser()
  })
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  controller?.dispose()
  await sleep(400)
  if (controller !== undefined) {
    await step('dispose leaves no browser process behind', async () => {
      assert.equal(controller.running, false)
      const value = await controller.status('agent-1')
      assert.equal(value.running, false)
    })
  }
  fixture?.server.close()
  rmSync(shotDir, { recursive: true, force: true })
  rmSync(profileDir, { recursive: true, force: true })
  if (process.exitCode !== 1) console.log('\nall checks passed')
}
