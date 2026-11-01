/**
 * Life on a machine that is not this one.
 *
 * Three questions, all of which used to have the same answer ("it throws
 * something unhelpful"):
 *
 *   1. Can the plugin find a browser at all? Five discovery layers, and a
 *      failure that says which of them looked where.
 *   2. Will that browser actually run here? Which is mostly about Linux:
 *      no display, root, snap and flatpak confinement.
 *   3. What happens when there is no browser? Ask, download, or switch off —
 *      and never ask twice.
 *
 * The provisioning flow is driven through injected seams, because the thing
 * being tested is the decision, not the 196 MB download.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BrowserUnavailableError,
  BrowserWindowController,
  DOWNLOAD_ANSWER,
  DECLINE_ANSWER,
  browserCacheRoots,
  browserQuestion,
  browserSearchNames,
  crc32,
  discoverBrowsers,
  extractZip,
  launchPlan,
  normalizeConfig,
  stateDirectory,
  zipEntries,
} from '../host.js'

/** A throwaway directory standing in for a home or an install root. */
function fixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-provision-'))
}

/** Create an executable-looking file. @returns its path. */
function fakeExecutable(directory, ...parts) {
  const file = path.join(directory, ...parts)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'not really a browser')
  return file
}

/** An environment with nothing installed anywhere. */
function emptyEnv(extra = {}) {
  return { ProgramFiles: 'C:\\nowhere', 'ProgramFiles(x86)': 'C:\\nowhere', LOCALAPPDATA: '', PATH: '', HOME: 'C:\\nowhere', ...extra }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('the five discovery layers answer in order, and say which one spoke', () => {
  const root = fixtureRoot()
  const known = fakeExecutable(root, 'ProgramFiles', 'Google', 'Chrome', 'Application', 'chrome.exe')
  const onPath = fakeExecutable(root, 'bin', 'chrome.exe')
  const cached = fakeExecutable(root, 'cache', 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe')
  const env = {
    ProgramFiles: path.join(root, 'ProgramFiles'),
    'ProgramFiles(x86)': 'C:\\nowhere',
    LOCALAPPDATA: path.join(root, 'cache'),
    USERPROFILE: root,
    HOME: root,
    PATH: path.join(root, 'bin'),
  }

  const discovery = discoverBrowsers(normalizeConfig({}), env, 'win32')
  const sources = new Set(discovery.found.map((entry) => entry.source))
  assert.ok(sources.has('known-path'), 'the well-known install path should be found')
  assert.ok(sources.has('path'), 'the PATH layer should be found')
  assert.equal(discovery.found[0].path, known, 'a known install path outranks the rest')

  // The same directory via the plugin's own cache root.
  const withCache = discoverBrowsers(normalizeConfig({ profileDir: path.join(root, 'cache', 'profile') }), { ...env, LOCALAPPDATA: path.join(root, 'cache') }, 'win32')
  assert.ok(withCache.found.some((entry) => entry.source === 'browser-cache'), 'a Playwright-style cache should be found')
  assert.ok(cached !== '' && existsSync(cached))
})

test('a configured browser wins, and a bare command name is looked up on PATH', () => {
  const root = fixtureRoot()
  const onPath = fakeExecutable(root, 'bin', 'chrome.exe')
  const env = emptyEnv({ PATH: path.join(root, 'bin') })

  // The bug this replaced: `browserPath: chrome.exe` used to resolve against the
  // process cwd and report "not an executable file" about a path nobody meant.
  const bare = discoverBrowsers(normalizeConfig({ browserPath: 'chrome.exe' }), env, 'win32')
  assert.equal(bare.found[0].path, onPath)
  assert.equal(bare.found[0].source, 'config')

  const environment = discoverBrowsers(normalizeConfig({}), { ...env, DSH_BROWSER_PANEL_BROWSER: 'chrome.exe' }, 'win32')
  assert.equal(environment.found[0].source, 'environment')
})

test('a configured browser that does not exist is reported, not skipped', () => {
  const discovery = discoverBrowsers(normalizeConfig({ browserPath: 'C:\\nowhere\\chrome.exe' }), emptyEnv(), 'win32')
  assert.equal(discovery.missingConfigured, true)
  assert.equal(discovery.found.length, 0)
  assert.match(discovery.configured, /chrome\.exe$/)
})

test('a native install outranks a confined one', () => {
  // Ranking matters when both exist: a snap build runs inside an AppArmor
  // profile that rejects the plugin's profile directory, so it needs more help
  // to work at all. Here the snap one comes first from PATH and still loses.
  const root = fixtureRoot()
  const confined = fakeExecutable(root, 'snap', 'bin', 'google-chrome')
  const native = fakeExecutable(root, 'usr', 'bin', 'chromium')
  const discovery = discoverBrowsers(normalizeConfig({}), {
    HOME: root,
    USERPROFILE: root,
    PATH: [path.dirname(confined), path.dirname(native)].join(path.delimiter),
  }, 'linux')
  assert.deepEqual(discovery.found.map((entry) => entry.path), [native, confined])
  assert.deepEqual(discovery.found.map((entry) => entry.penalty), [0, 2])
})

test('the PATH scan looks for specific names only', () => {
  // `launcher.exe` was in this list for one revision and found JetBrains
  // toolchains; a generic name turns discovery into a source of false positives.
  assert.ok(!browserSearchNames('win32').includes('launcher.exe'))
  assert.deepEqual(browserSearchNames('win32'), ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe', 'opera.exe'])
  assert.ok(browserSearchNames('linux').includes('google-chrome'))
  assert.ok(browserSearchNames('darwin').includes('chrome-headless-shell'))
})

test('the cache roots include the plugin\'s own download directory', () => {
  const roots = browserCacheRoots('linux', { HOME: '/home/u', XDG_CACHE_HOME: '/home/u/.cache' }, '/home/u/.dsh/browser-panel')
  assert.equal(roots[0], path.join('/home/u/.dsh/browser-panel', 'browsers'))
  assert.ok(roots.some((root) => root.includes('ms-playwright')))
})

// ---------------------------------------------------------------------------
// Running where you are
// ---------------------------------------------------------------------------

/** Launch a plan for one scenario. */
function planFor(options) {
  return launchPlan({
    browserPath: '/usr/bin/google-chrome',
    config: normalizeConfig(options.config ?? {}),
    port: 9222,
    profileDir: '/home/u/.dsh/browser-panel/browser-profile',
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    uid: options.uid,
  })
}

test('a Linux host with no display becomes headless, and says why', () => {
  const plan = planFor({ env: {} })
  assert.equal(plan.headless, true)
  assert.match(plan.headlessReason, /no DISPLAY or WAYLAND_DISPLAY/)
  assert.ok(plan.args.includes('--headless=new'))
  assert.ok(plan.notes.some((note) => note.includes('DISPLAY')))
})

test('a display, or an explicit headless setting, is respected', () => {
  const withDisplay = planFor({ env: { DISPLAY: ':0' } })
  assert.equal(withDisplay.headless, false)
  assert.equal(withDisplay.headlessReason, '')
  assert.ok(!withDisplay.args.some((argument) => argument.startsWith('--headless')))

  const byWayland = planFor({ env: { WAYLAND_DISPLAY: 'wayland-0' } })
  assert.equal(byWayland.headless, false)

  const asked = planFor({ config: { headless: true }, env: { DISPLAY: ':0' } })
  assert.equal(asked.headless, true)
  assert.match(asked.headlessReason, /configured headless/)
})

test('running as root adds --no-sandbox and admits it', () => {
  const plan = planFor({ env: { DISPLAY: ':0' }, uid: 0 })
  assert.equal(plan.noSandbox, true)
  assert.ok(plan.args.includes('--no-sandbox'))
  assert.ok(plan.notes.some((note) => note.includes('renderer sandbox is off')))
  assert.equal(planFor({ env: { DISPLAY: ':0' }, uid: 1000 }).noSandbox, false)
})

test('snap and flatpak confine the profile, so the profile moves', () => {
  const snap = launchPlan({
    browserPath: '/snap/bin/chromium',
    config: normalizeConfig({}),
    port: 9222,
    profileDir: '/home/u/.dsh/browser-panel/browser-profile',
    env: { HOME: '/home/u', DISPLAY: ':0' },
    platform: 'linux',
  })
  assert.equal(snap.profileDir, path.join('/home/u', 'snap', 'chromium', 'common', 'dsh-browser-panel', 'browser-profile'))
  assert.ok(snap.notes.some((note) => note.includes('snap confinement')))

  const flatpak = launchPlan({
    browserPath: '/var/lib/flatpak/exports/bin/com.google.Chrome',
    config: normalizeConfig({}),
    port: 9222,
    profileDir: '/home/u/.dsh/browser-panel/browser-profile',
    env: { HOME: '/home/u', DISPLAY: ':0' },
    platform: 'linux',
  })
  assert.equal(flatpak.profileDir, path.join('/home/u', '.var', 'app', 'com.google.Chrome', 'config', 'dsh-browser-panel', 'browser-profile'))
  assert.ok(flatpak.notes.some((note) => note.includes('flatpak confinement')))
})

test('WSL and the legacy headless flag are both accounted for', () => {
  const wsl = planFor({ env: { DISPLAY: ':0', WSL_DISTRO_NAME: 'Ubuntu' } })
  assert.ok(wsl.notes.some((note) => note.includes('WSL')))

  const legacy = launchPlan({
    browserPath: '/usr/bin/chromium',
    config: normalizeConfig({}),
    port: 9222,
    profileDir: '/tmp/p',
    env: {},
    platform: 'linux',
    headlessFlag: 'legacy',
  })
  assert.ok(legacy.args.includes('--headless'))
  assert.ok(!legacy.args.includes('--headless=new'))
})

test('every launch keeps the devtools port on loopback and the start page last', () => {
  const plan = planFor({ env: { DISPLAY: ':0' } })
  assert.ok(plan.args.includes('--remote-debugging-address=127.0.0.1'))
  assert.equal(plan.args[plan.args.length - 1], 'about:blank')
  assert.ok(plan.args.includes('--user-data-dir=/home/u/.dsh/browser-panel/browser-profile'))
})

// ---------------------------------------------------------------------------
// Provisioning: ask, download, or switch off
// ---------------------------------------------------------------------------

const NOTHING = { ProgramFiles: 'C:\\nowhere', 'ProgramFiles(x86)': 'C:\\nowhere', LOCALAPPDATA: '', PATH: '' }

/**
 * A controller on a machine with no browser, with every edge faked.
 *
 * @param overrides - `{ config, answer, install, env }`.
 * @returns the controller plus what the fakes recorded.
 */
function bareController(overrides = {}) {
  const root = fixtureRoot()
  const asked = []
  const installed = []
  const logs = []
  const env = { ...NOTHING, HOME: root, USERPROFILE: root, XDG_CACHE_HOME: path.join(root, 'cache'), ...(overrides.env ?? {}) }
  const controller = new BrowserWindowController(
    { profileDir: path.join(root, 'profile'), ...(overrides.config ?? {}) },
    {
      env,
      platform: 'win32',
      log: (message) => logs.push(message),
      ask: async (request) => {
        asked.push(request)
        if (overrides.answer === 'throw') throw new Error('no user-questions answerer accepted the request')
        return { answers: [{ id: request.questions[0].id, selected: overrides.answer ?? [] }] }
      },
      install: async (options) => {
        installed.push(options)
        if (overrides.install === 'fail') throw new Error('the download answered 503')
        if (overrides.install === 'noop') return { version: '0.0.0' }
        // A real install leaves a browser where discovery will look.
        const produced = fakeExecutable(options.stateDir, 'browsers', 'chrome-for-testing-154', 'chrome-win64', 'chrome.exe')
        return { version: '154.0.0.0', destination: produced, bytes: 1 }
      },
    },
  )
  return { controller, asked, installed, logs, root, env }
}

test('activation detects, and does so without asking anything', async () => {
  const { controller, asked, logs } = bareController()
  await controller.start()
  assert.equal(controller.provision, 'missing')
  assert.equal(controller.probe().found.length, 0)
  assert.equal(asked.length, 0, 'activation has no agent, so it cannot ask')
  assert.ok(logs.some((line) => line.includes('no Chromium-family browser')))
})

test('activation reports a browser it can use', async () => {
  const root = fixtureRoot()
  const executable = fakeExecutable(root, 'Edge', 'Application', 'msedge.exe')
  const withBrowser = new BrowserWindowController({ browserPath: executable }, { env: emptyEnv({ HOME: root }), platform: 'win32' })
  await withBrowser.start()
  assert.equal(withBrowser.provision, 'ok')
  assert.match(withBrowser.provisionDetail, /\(config\)$/)
})

test('the DSH question offers a download and a way to switch the plugin off', () => {
  const question = browserQuestion()
  assert.equal(question.id, 'browser-download')
  assert.equal(question.header, '需要浏览器')
  assert.deepEqual(question.options.map((option) => option.label), [DOWNLOAD_ANSWER, DECLINE_ANSWER])
  assert.match(question.question, /找不到可以自动化的浏览器/)
  assert.match(question.detail, /Firefox 和 Safari 不行/)
  assert.match(question.detail, /196 MB/)
  assert.match(question.detail, /不动你系统里的任何浏览器/)
  assert.match(question.detail, /winget install/)
})

test('answering "download" installs, and the browser is found afterwards', async () => {
  const { controller, asked, installed, env } = bareController({ answer: [DOWNLOAD_ANSWER] })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' }, signal: undefined }), true)
  assert.equal(asked.length, 1)
  assert.equal(installed.length, 1)
  assert.equal(controller.provision, 'ok')
  assert.match(controller.provisionDetail, /installed Chrome for Testing/)
  assert.equal(controller.probe().found.length, 1)
  // It went into the plugin's own state directory, not a package manager's cache.
  assert.equal(installed[0].stateDir, stateDirectory(env))
  assert.ok(installed[0].stateDir.startsWith(env.HOME))
})

test('answering "no" switches the plugin off, and it stays off', async () => {
  const { controller, asked } = bareController({ answer: [DECLINE_ANSWER] })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.equal(controller.provision, 'declined')
  assert.equal(asked.length, 1)

  // The refusal is remembered on disk...
  const stateFile = controller.provisionStateFile()
  assert.equal(existsSync(stateFile), true)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).provision.declined, true)

  // ...so the next call throws without asking again.
  const error = await controller.ensureBrowser({ agent: { id: 'a' } }).then(() => null, (thrown) => thrown)
  assert.ok(error instanceof BrowserUnavailableError)
  assert.equal(error.kind, 'declined')
  assert.match(error.message, /switched off/)
  assert.match(error.remedy, /picked up automatically/)
  assert.equal(asked.length, 1, 'a declined user is not asked twice')
})

test('a fresh controller reads the recorded refusal instead of asking', async () => {
  const first = bareController({ answer: [DECLINE_ANSWER] })
  await first.controller.offerBrowser({ agent: { id: 'a' } })
  const stateFile = first.controller.provisionStateFile()

  const root = path.dirname(path.dirname(stateFile))
  const second = new BrowserWindowController({ profileDir: path.join(root, 'profile') }, {
    env: first.env,
    platform: 'win32',
    ask: async () => {
      throw new Error('must not be asked')
    },
  })
  await second.start()
  assert.equal(second.provision, 'declined')
  assert.equal(second.provisionStateFile(), stateFile)
})

test('installing a browser by hand lifts an earlier refusal', async () => {
  const { controller, env } = bareController({ answer: [DECLINE_ANSWER] })
  await controller.offerBrowser({ agent: { id: 'a' } })
  assert.equal(controller.provision, 'declined')

  // The user installs one themselves; discovery finds it on the next look. The
  // launch that follows fails here — the file is not a browser — but the refusal
  // is already lifted, which is what this test is about.
  const executable = fakeExecutable(path.join(env.HOME, 'ProgramFiles'), 'Edge', 'Application', 'msedge.exe')
  controller.config.browserPath = executable
  await assert.rejects(controller.ensureBrowser({ agent: { id: 'a' } }))
  assert.equal(controller.provision, 'ok')
  assert.equal(JSON.parse(readFileSync(controller.provisionStateFile(), 'utf8')).provision.declined, false)
})

test('a dismissed question is not remembered as a refusal', async () => {
  const { controller, asked } = bareController({ answer: [] })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.equal(controller.provisionDetail, 'the download question was dismissed')
  assert.equal(controller.provisionStateFile() && existsSync(controller.provisionStateFile()), false)
  assert.equal(asked.length, 1)
})

test('with no answerer — a headless deployment — nothing is asked and nothing hangs', async () => {
  const { controller } = bareController({ answer: 'throw' })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.match(controller.provisionDetail, /no user-questions answerer/)
  const error = await controller.ensureBrowser({ agent: { id: 'a' } }).then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'missing')
  assert.match(error.remedy, /winget install Google\.Chrome/)
})

test('provision: never never asks, provision: auto never asks either', async () => {
  const never = bareController({ config: { provision: 'never' }, answer: [DOWNLOAD_ANSWER] })
  assert.equal(await never.controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.equal(never.asked.length, 0)
  assert.equal(never.installed.length, 0)

  const auto = bareController({ config: { provision: 'auto' }, answer: [] })
  assert.equal(await auto.controller.offerBrowser({ agent: { id: 'a' } }), true)
  assert.equal(auto.asked.length, 0, 'auto must not ask')
  assert.equal(auto.installed.length, 1)
})

test('a failed download is reported as such, with the reason', async () => {
  const { controller } = bareController({ answer: [DOWNLOAD_ANSWER], install: 'fail' })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.equal(controller.provision, 'install-failed')
  assert.match(controller.provisionDetail, /503/)
  const error = await controller.ensureBrowser({ agent: { id: 'a' } }).then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'install-failed')
  assert.match(error.message, /downloading a browser did not work out/)
  assert.match(error.message, /503/)
})

test('an install that produces nothing usable is still a failure', async () => {
  const { controller } = bareController({ answer: [DOWNLOAD_ANSWER], install: 'noop' })
  assert.equal(await controller.offerBrowser({ agent: { id: 'a' } }), false)
  assert.equal(controller.provision, 'install-failed')
  assert.match(controller.provisionDetail, /discovery still cannot find it/)
})

test('the missing-browser report names every layer and rules Firefox out', async () => {
  const { controller } = bareController()
  await controller.start()
  const error = await controller.ensureBrowser({ agent: { id: 'a' } }).then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'missing')
  assert.match(error.message, /no Chromium-family browser was found on this machine/)
  assert.match(error.message, /Firefox and Safari speak a\ndifferent protocol/)
  assert.match(error.message, /Looked in \(in this order\)/)
  assert.match(error.message, /PATH — chrome\.exe/)
  assert.match(error.remedy, /Install one:/)
  assert.match(error.remedy, /DSH_BROWSER_PANEL_BROWSER/)
})

// ---------------------------------------------------------------------------
// Unpacking the download
// ---------------------------------------------------------------------------

/**
 * Build a zip archive in memory.
 *
 * Deliberately independent of the reader under test: entries are laid out by
 * hand so a bug in `zipEntries` cannot make the fixture agree with it.
 *
 * @param entries - `[{ name, data, method?, mode?, directory? }]`.
 * @returns the archive bytes.
 */
function makeZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 8
    const body = method === 8 ? deflateRawSync(raw) : raw
    const mode = entry.mode ?? (entry.directory === true ? 0o40755 : 0o100644)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(crc32(raw), 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, body)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc32(raw), 16)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE((mode << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuffer, end])
}

test('a zip is read, checksummed and unpacked with its directory shape', async () => {
  const destination = path.join(fixtureRoot(), 'out')
  const archive = makeZip([
    { name: 'chrome-win64/', directory: true },
    { name: 'chrome-win64/chrome.exe', data: Buffer.from('binary') },
    { name: 'chrome-win64/locales/en.pak', data: Buffer.from('locale'), method: 0 },
  ])
  const written = await extractZip(archive, destination)
  assert.equal(written, 2)
  assert.equal(readFileSync(path.join(destination, 'chrome-win64', 'chrome.exe'), 'utf8'), 'binary')
  assert.equal(readFileSync(path.join(destination, 'chrome-win64', 'locales', 'en.pak'), 'utf8'), 'locale')
  assert.equal(zipEntries(archive).length, 3)
})

test('a corrupt entry is refused instead of unpacked', async () => {
  // Stored, not deflated: flipping a byte then has to be caught by the checksum
  // rather than by zlib noticing, which is the check being tested.
  const archive = makeZip([{ name: 'chrome.exe', data: Buffer.from('binary'), method: 0 }])
  const at = archive.indexOf(Buffer.from('binary'))
  assert.ok(at > 0)
  archive[at] = archive[at] ^ 0xff
  await assert.rejects(extractZip(archive, path.join(fixtureRoot(), 'out')), /checksum mismatch/)
})

test('an archive that tries to escape its destination is refused', async () => {
  const destination = path.join(fixtureRoot(), 'out')
  await assert.rejects(extractZip(makeZip([{ name: '../evil.exe', data: Buffer.from('x') }]), destination), /escapes the destination/)
  await assert.rejects(extractZip(makeZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), destination), /absolute path/)
  await assert.rejects(extractZip(makeZip([{ name: 'C:\\Windows\\evil.exe', data: Buffer.from('x') }]), destination), /absolute path/)
  assert.equal(existsSync(path.join(path.dirname(destination), 'evil.exe')), false)
})

test('a file that is not a zip says so', async () => {
  await assert.rejects(extractZip(Buffer.from('this is not an archive at all, but it is long enough'), path.join(fixtureRoot(), 'out')), /not a zip archive/)
})

test('zip64 is refused rather than half-read', () => {
  const archive = makeZip([{ name: 'a.txt', data: Buffer.from('a') }])
  archive.writeUInt16LE(0xffff, archive.length - 12)
  assert.throws(() => zipEntries(archive), /zip64/)
})

test('crc32 matches the reference value for a known string', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status explains a machine with no browser instead of just saying "not running"', async () => {
  const { controller } = bareController()
  await controller.start()
  const value = await controller.status('agent-1')
  assert.equal(value.running, false)
  assert.equal(value.browserAvailable, false)
  assert.equal(value.browserSource, '')
  assert.deepEqual(value.browserFound, [])
  assert.match(value.browserRemedy, /Install one:/)
  assert.equal(value.provision, 'missing')
  assert.match(value.provisionDetail, /no Chromium-family browser/)
})

test('status reports the effective environment before anything runs', async () => {
  const root = fixtureRoot()
  const executable = fakeExecutable(root, 'chromium')
  const controller = new BrowserWindowController({ browserPath: executable, headless: false }, {
    env: { HOME: root, PATH: '', DISPLAY: '' },
    platform: 'linux',
  })
  const value = await controller.status('agent-1')
  assert.equal(value.browserAvailable, true)
  assert.equal(value.browserSource, 'config')
  assert.equal(value.headless, true, 'no DISPLAY means no window, and status should say so before launch')
  assert.match(value.headlessReason, /no DISPLAY/)
  assert.equal(value.noSandbox, false)
})

test('stateDirectory is the plugin\'s own directory, not the browser profile', () => {
  const directory = stateDirectory({ HOME: '/home/u' })
  assert.equal(directory, path.join('/home/u', '.dsh', 'browser-panel'))
  assert.equal(stateDirectory({ USERPROFILE: 'C:\\Users\\x' }), path.join('C:\\Users\\x', '.dsh', 'browser-panel'))
})

// ---------------------------------------------------------------------------
// Finding a browser that is already running
//
// Edge 155's launcher starts the real browser and exits 0, so "the process I
// spawned has gone" stopped meaning "the browser never started". These cover the
// endpoint-keyed replacement, and the adoption that makes a leftover browser from
// an earlier session reusable instead of a hard failure.
// ---------------------------------------------------------------------------

/**
 * A fake devtools endpoint that answers the two routes the plugin reads.
 *
 * @returns `{ port, close }`.
 */
async function fakeDevTools() {
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ Browser: 'Fake/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }))
      return
    }
    response.writeHead(404)
    response.end('no')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * A profile directory that claims a devtools port.
 *
 * @param port - the port to record.
 * @returns the directory.
 */
function profileWithActivePort(port) {
  const directory = fixtureRoot()
  writeFileSync(path.join(directory, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake`)
  return directory
}

/** @returns a controller that will not start anything on its own. */
function idleController(overrides = {}) {
  return new BrowserWindowController({ profileDir: fixtureRoot() }, { env: emptyEnv(), platform: 'win32', ...overrides })
}

test('a recorded devtools port is only believed while something answers on it', async () => {
  const controller = idleController()
  assert.equal(await controller.readActivePort(fixtureRoot()), 0, 'no file, no port')

  const fake = await fakeDevTools()
  try {
    assert.equal(await controller.readActivePort(profileWithActivePort(fake.port)), fake.port)
  } finally {
    await fake.close()
  }
  assert.equal(await controller.readActivePort(profileWithActivePort(fake.port)), 0, 'a stale port is not believed')

  // The port may have been reused by something that is not a browser at all.
  const impostor = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>some other service</title>')
  })
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve))
  try {
    assert.equal(await controller.readActivePort(profileWithActivePort(impostor.address().port)), 0, 'a 200 from a non-devtools server is not a browser')
  } finally {
    await new Promise((resolve) => impostor.close(resolve))
  }

  const nonsense = fixtureRoot()
  writeFileSync(path.join(nonsense, 'DevToolsActivePort'), 'not-a-port\nwhatever')
  assert.equal(await controller.readActivePort(nonsense), 0)
})

test('a launcher that exits 0 no longer counts as a failed launch', async () => {
  // The exact Edge 155 shape: our child process is gone, exit code 0, and the
  // browser it handed the run to is serving its devtools port.
  const fake = await fakeDevTools()
  try {
    const profile = profileWithActivePort(fake.port)
    const controller = idleController()
    controller.child = null
    controller.exitCodeSeen = 0
    await controller.waitForDevTools(profile, 0, 3000)
    assert.equal(controller.port, fake.port)
    assert.equal(controller.version, 'Fake/1.0')
  } finally {
    await fake.close()
  }
})

test('a launcher that exits non-zero still fails at once', async () => {
  const controller = idleController()
  controller.child = null
  controller.exitCodeSeen = 3
  controller.lastError = 'the browser window closed (exit code 3)'
  const error = await controller.waitForDevTools(fixtureRoot(), 0, 3000).then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'exited')
  assert.match(error.message, /exit code 3/)
})

test('a hand-off with nothing listening is reported as a hand-off', async () => {
  const controller = idleController()
  controller.child = null
  controller.exitCodeSeen = 0
  const error = await controller.waitForDevTools(fixtureRoot(), 0, 250).then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'handoff')
  assert.match(error.message, /handed the run to another process/)
  assert.match(error.message, /without a debugging port/)
})

test('adopting a running browser reports it as running and reused', async () => {
  const fake = await fakeDevTools()
  try {
    const controller = idleController()
    await controller.adopt(fake.port, 'C:\\fake\\chrome.exe')
    assert.equal(controller.running, true)
    assert.equal(controller.adopted, true)
    assert.equal(controller.port, fake.port)
    assert.equal(controller.version, 'Fake/1.0')
    const status = await controller.status('agent-1')
    assert.equal(status.running, true)
    assert.equal(status.reused, true)
    assert.equal(status.browser, 'Fake/1.0')
  } finally {
    await fake.close()
  }
})

test('an adopted browser is let go, not killed, and disposing twice is safe', async () => {
  const fake = await fakeDevTools()
  const controller = idleController()
  await controller.adopt(fake.port, 'C:\\fake\\chrome.exe')
  // Browser.close fails against this fake; disposal must swallow that rather
  // than throw out of a path that runs while the plugin is being unloaded.
  assert.doesNotThrow(() => controller.dispose())
  assert.equal(controller.running, false)
  assert.doesNotThrow(() => controller.dispose())
  await fake.close()
})

