/**
 * @local/dsh-sidebar-browser - Host half.
 *
 * This plugin gives the model one real Chromium browser **window** and drives it
 * over the Chrome DevTools Protocol. It no longer touches DSH's right-Sidebar
 * Browser tab, and there is no longer a browser half in the renderer.
 *
 * Why the rewrite: the Sidebar Browser tab is an Electron `<webview>` owned by
 * the desktop shell's main process, and that process denies every attempt to
 * give it a window of its own —
 *
 *   - `window.open` in the app renderer is answered with `{ action: 'deny' }`,
 *     and http(s) goes to `shell.openExternal` instead;
 *   - the guest's own popups are denied too and re-routed into new Sidebar tabs;
 *   - the webview is lease-gated: `browserAcquire` is approved in the main
 *     process, `will-attach-webview` hardens `webPreferences`, and only the
 *     primary window is built with `webviewTag: true`.
 *
 * So "pop the Sidebar browser out into its own window" is a DSH core change, not
 * a plugin change. What a plugin *can* do is own the browser: this half runs in
 * the DSH Node runtime (not in Electron), so it can spawn a browser and talk CDP
 * to it. Node 24 ships `fetch` and `WebSocket`, so that costs no dependencies.
 *
 * The shape of one tool call:
 *
 *   tool  --ensureBrowser()-->  spawn msedge/chrome with --remote-debugging-port
 *   tool  --attach()-------->  one CDP socket per tab, bound per agent id
 *   tool  --send(method)---->  Page.navigate / Runtime.evaluate / Input.*
 *
 * Everything the old bridge needed is gone with it: the Remote namespace, the
 * long poll, the `agentId -> frame` table, revealing the Sidebar tab, putting
 * the address back after that reveal, and the `UnknownVizError` workarounds. CDP
 * reads and captures a page whether or not the window is on screen.
 *
 * @module @local/dsh-sidebar-browser
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { inflateRawSync } from 'node:zlib'

/** Reported by `browser_panel_status` and by the README's version line. */
const VERSION = '0.20.1'
/** Package name, echoed in tool output so a stale install is recognizable. */
const PLUGIN = '@local/dsh-sidebar-browser'
/** Screenshot directory used when the caller does not name a path. */
const SHOT_DIR = '.dsh-browser-panel'
/** Upper bound on outline entries, so one huge page cannot flood the context. */
const OUTLINE_LIMIT = 120
/** How long the browser gets to publish its devtools endpoint after spawn. */
const DEVTOOLS_BOOT_MS = 25000
/** Poll interval while waiting for that endpoint, and for fresh tab listings. */
const POLL_MS = 150
/** How long an action waits for a click-triggered load before reading the page. */
const CLICK_SETTLE_MS = 600
/** Upper bound on a load-event wait, so a fragment navigation cannot stall it. */
const LOAD_WAIT_CAP_MS = 15000
/** The elements a snapshot treats as interactive, in document order. */
const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"]'

/**
 * The ownership layer: how a human tells this window apart from their own.
 *
 * Four signals, weakest to strongest, so that whichever one a person looks at
 * answers "whose browser is this?":
 *
 *   1. the OS window title, via the browser profile's own name (see
 *      {@link seedProfileName}) — shows up in the title bar, the taskbar tooltip
 *      and alt-tab;
 *   2. a marker tab, first in the strip, whose page explains the window
 *      ({@link MARKER_HASH} is the fragment that identifies it across reloads);
 *   3. a corner badge on every page, injected by {@link buildOwnershipScript}
 *      through `Page.addScriptToEvaluateOnNewDocument`, so it survives
 *      navigation and CSP (the browser runs it, not the document);
 *   4. an amber viewport frame plus a live "what is the AI doing right now" line
 *      while a tool call is in flight.
 *
 * All of it is cosmetic and non-interactive: every node carries `data-dsh-ai`,
 * `pointer-events` is `none`, and the snapshot hides the layer before reading
 * page text so the model never sees its own badge in the page.
 */
const MARKER_HASH = '#dsh-ai-browser'
/** The marker tab's title, and the name its strip entry shows. */
const MARKER_TITLE = '🤖 AI 浏览器 · dsh-browser-panel'
/** Element ids the injected script owns. */
const OWNERSHIP_PILL_ID = 'dsh-ai-ownership'
const OWNERSHIP_FRAME_ID = 'dsh-ai-operating-frame'
const OWNERSHIP_STATUS_ID = 'dsh-ai-marker-status'
/**
 * The page-ownership rule, contributed to the system prompt on activation.
 *
 * A tool description can be read and then forgotten between steps; this section
 * sits with the rest of the operating rules, so the model sees why a second
 * `browser_panel_open` navigates instead of opening another tab, and how to take
 * over a page an agent left behind.
 */
const PAGE_OWNERSHIP_PROMPT = `## Browser pages: one agent, one page

The browser_panel tools drive one shared Chromium window. Every page (tab) is owned by exactly one agent at a time, and the page's corner badge and browser_panel_status both name that owner.

- You own at most one page. browser_panel_open navigates the page you already own; it never gives you a second one. If a task genuinely needs a second page, spawn a subagent — the page it opens belongs to it, and you must not operate it.
- Never operate a page another agent owns. Call browser_panel_status to see every page with its owner.
- Pages stay open after their agent finishes so the user can inspect the result. To continue on such a page, call browser_panel_open with adopt=<targetId> (and, only if you also want to navigate it, url). That page becomes yours, and any page you owned before is released — left open, but no longer yours.
- Every other browser_panel tool acts on your own page, so there is no reason to call browser_panel_open again while you still own one.`

/** What each tool call says on the badge while it runs. */
const OPERATION_LABELS = Object.freeze({
  open: '正在打开网页',
  snapshot: '正在读取页面',
  click: '正在点击',
  type: '正在输入',
  press: '正在按键',
  navigate: '正在导航',
  eval: '正在执行脚本',
  screenshot: '正在截图',
})


/** Fail-safe row defaults; a profile patch may override every one of them. */
const DEFAULTS = Object.freeze({
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

/** The ownership modes this plugin understands. */
const OWNERSHIP_MODES = Object.freeze(['always', 'operating', 'off'])

/** What to do when the machine has no browser at all. */
const PROVISION_MODES = Object.freeze(['ask', 'never', 'auto'])

/**
 * The official index of Chrome for Testing builds.
 *
 * Google publishes these for automation, which is exactly what this plugin is,
 * and the download needs nothing but `fetch` and `zlib` — so a machine with no
 * browser, no package manager and no npm still has a way to get one.
 */
const CHROME_FOR_TESTING_INDEX = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
/** How long the download-and-extract step gets before it is abandoned. */
const INSTALL_TIMEOUT_MS = 900000
/** Bytes read from a browser's log when explaining why it died. */
const LOG_TAIL_BYTES = 2000

/** Browser processes this module started, killed when the host process exits. */
const LIVE_BROWSERS = new Set()
let exitHookInstalled = false

/** Install the process-exit sweep once, however many times the row is loaded. */
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of LIVE_BROWSERS) {
      try {
        child.kill()
      } catch {
        /* the process is already gone */
      }
    }
  })
}

/**
 * Where each platform keeps a Chromium-family browser, in preference order.
 *
 * Edge leads on Windows because it is present on every supported Windows
 * install, so the plugin works with nothing to download. Chrome and Brave
 * follow, then the usual Linux package paths. `DSH_BROWSER_PANEL_BROWSER` in the
 * environment and `browserPath` in the row config override the whole list.
 *
 * This is only the third of five discovery layers; see {@link discoverBrowsers}
 * for the ones that catch what a fixed list cannot (PATH, package-manager
 * layouts, an already-downloaded Playwright or Puppeteer browser).
 *
 * @param platform - `process.platform`.
 * @param env - `process.env`.
 * @returns candidate executable paths, most preferred first.
 */
function browserCandidates(platform, env) {
  const join = (...parts) => path.join(...parts)
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env['LOCALAPPDATA'] ?? ''
    const home = env['USERPROFILE'] ?? env['HOME'] ?? ''
    const local = (rest) => (localAppData === '' ? [] : [join(localAppData, ...rest)])
    const under = (root, rest) => (root === '' ? [] : [join(root, ...rest)])
    const edge = (root, flavour = 'Edge') => join(root, 'Microsoft', flavour, 'Application', 'msedge.exe')
    const chrome = (root, flavour = 'Chrome') => join(root, 'Google', flavour, 'Application', 'chrome.exe')
    return [
      edge(programFilesX86),
      edge(programFiles),
      ...local(['Microsoft', 'Edge', 'Application', 'msedge.exe']),
      chrome(programFiles),
      chrome(programFilesX86),
      ...local(['Google', 'Chrome', 'Application', 'chrome.exe']),
      join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ...local(['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']),
      join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'),
      ...local(['Vivaldi', 'Application', 'vivaldi.exe']),
      join(programFiles, 'Opera', 'opera.exe'),
      ...local(['Programs', 'Opera', 'opera.exe']),
      ...local(['Programs', 'Opera', 'launcher.exe']),
      // Pre-release channels and less common install roots.
      edge(programFiles, 'Edge Beta'),
      edge(programFiles, 'Edge Dev'),
      edge(programFiles, 'Edge SXS'),
      ...local(['Microsoft', 'Edge Beta', 'Application', 'msedge.exe']),
      chrome(programFiles, 'Chrome Beta'),
      chrome(programFiles, 'Chrome SxS'),
      ...local(['Google', 'Chrome SxS', 'Application', 'chrome.exe']),
      ...local(['Chromium', 'Application', 'chrome.exe']),
      // Scoop and winget put shims on PATH, but their real paths are stable too.
      ...under(home, ['scoop', 'shims', 'chrome.exe']),
      ...under(home, ['scoop', 'apps', 'chromium', 'current', 'chrome.exe']),
      ...local(['Microsoft', 'WinGet', 'Links', 'chrome.exe']),
    ]
  }
  if (platform === 'darwin') {
    const app = (name) => `/Applications/${name}.app/Contents/MacOS/${name}`
    const brew = (name) => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
    return [
      app('Google Chrome'),
      app('Microsoft Edge'),
      app('Brave Browser'),
      app('Chromium'),
      app('Vivaldi'),
      app('Arc'),
      '/Applications/Opera.app/Contents/MacOS/Opera',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
      '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
      '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
      ...brew('chromium'),
      ...brew('chrome-headless-shell'),
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium/chromium',
    '/usr/bin/brave-browser',
    '/opt/brave.com/brave/brave',
    '/usr/bin/vivaldi',
    '/usr/bin/vivaldi-stable',
    '/usr/bin/opera',
    // Package-manager layouts: snap, flatpak (system and per-user), nix.
    '/snap/bin/chromium',
    '/snap/bin/brave',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/com.brave.Browser',
    '/var/lib/flatpak/exports/bin/com.microsoft.Edge',
    '/run/current-system/sw/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium',
  ]
}

/**
 * Executable names to look for on `PATH` and inside browser caches.
 *
 * @param platform - `process.platform`.
 * @returns names in preference order.
 */
function browserSearchNames(platform) {
  // Deliberately specific names only. A generic one — `launcher.exe`, which is
  // both Opera's stub and half the JetBrains toolchain — turns a PATH scan into
  // a way to find something that is not a browser at all.
  if (platform === 'win32') return ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe', 'opera.exe']
  if (platform === 'darwin') return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'chrome', 'chromium', 'chrome-headless-shell']
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'vivaldi-stable', 'opera', 'chrome', 'chrome-headless-shell']
}

/**
 * How likely a path is to need extra accommodation before it will run.
 *
 * A snap or flatpak build is still a real browser, but it runs inside a
 * confinement that rejects the profile directory the plugin would otherwise
 * choose, so a native install is preferred whenever both exist.
 *
 * @param candidate - absolute executable path.
 * @returns 0 for a native install, 2 for a confined one, 1 in between.
 */
function confinementPenalty(candidate) {
  const normalized = candidate.replace(/\\/g, '/')
  if (normalized.startsWith('/snap/') || normalized.includes('/snap/')) return 2
  if (normalized.includes('/flatpak/') || normalized.includes('/.var/app/')) return 2
  if (normalized.endsWith('.AppImage')) return 1
  return 0
}

/**
 * Turn a configured browser value into a path.
 *
 * A bare command name is looked up on `PATH`, because `browserPath: chrome` is
 * what a person writes — resolving it against the process cwd, as this plugin
 * used to, produces "not an executable file" pointing at a path nobody meant.
 *
 * @param value - `browserPath` or the environment override.
 * @param env - environment carrying `PATH`.
 * @returns an absolute path, or the value untouched when it cannot be found.
 */
function resolveConfiguredBrowser(value, env) {
  const trimmed = asText(value, 400)
  if (trimmed === '') return ''
  if (trimmed.includes('/') || trimmed.includes('\\') || path.isAbsolute(trimmed)) return path.resolve(trimmed)
  return lookupOnPath(trimmed, env) ?? path.resolve(trimmed)
}

/**
 * Find one executable name on `PATH`.
 *
 * @param name - executable file name.
 * @param env - environment carrying `PATH` (or `Path`).
 * @returns the absolute path, or null.
 */
function lookupOnPath(name, env) {
  const raw = env.PATH ?? env.Path ?? ''
  const separator = path.delimiter
  for (const entry of String(raw).split(separator)) {
    if (entry === '') continue
    const candidate = path.join(entry, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/**
 * Every Playwright browser cache worth looking in.
 *
 * Playwright is the cheapest way for a user to get an automation-ready Chromium,
 * and its browsers are already on disk for anyone who has used it — so a machine
 * with no system browser at all often has one of these.
 *
 * @param platform - `process.platform`.
 * @param env - environment carrying `HOME`, `LOCALAPPDATA`, `XDG_CACHE_HOME`.
 * @param stateDir - the plugin's own state directory.
 * @returns cache roots, most specific first.
 */
function browserCacheRoots(platform, env, stateDir) {
  const home = asText(env.HOME, 400) || asText(env.USERPROFILE, 400) || homedir()
  // An unset cache variable must fall back to a real directory: an empty one
  // would make `path.join` produce a relative path, and a relative cache root is
  // a directory scan that follows whatever the process cwd happens to be.
  const xdg = asText(env.XDG_CACHE_HOME, 400) || path.join(home, '.cache')
  const localAppData = asText(env.LOCALAPPDATA, 400) || path.join(home, 'AppData', 'Local')
  const roots = [path.join(stateDir, 'browsers')]
  if (platform === 'win32') {
    roots.push(path.join(localAppData, 'ms-playwright'), path.join(localAppData, 'puppeteer'))
  } else if (platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'puppeteer'))
  } else {
    roots.push(path.join(xdg, 'ms-playwright'), path.join(home, '.cache', 'puppeteer'), path.join(home, '.cache', 'puppeteer', 'chrome'))
  }
  return roots
}

/**
 * List the browser executables inside one cache root.
 *
 * The layouts differ between Playwright revisions (`chrome-linux` vs
 * `chrome-linux64`), so this walks two levels and matches by executable name
 * rather than by a fixed relative path.
 *
 * @param root - a cache directory.
 * @param platform - `process.platform`.
 * @returns absolute executable paths.
 */
function browsersInCache(root, platform) {
  const found = []
  let revisions
  try {
    revisions = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  const wanted = new Set(browserSearchNames(platform))
  const walk = (directory, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && wanted.has(entry.name) && isExecutableFile(full)) found.push(full)
    }
  }
  for (const revision of revisions) {
    if (revision.isDirectory()) walk(path.join(root, revision.name), 0)
  }
  return found
}

/**
 * Discover every Chromium-family browser this machine has, best first.
 *
 * Five layers, each recording where it found the answer:
 *
 *   1. `browserPath` — the row config, authoritative when set;
 *   2. `DSH_BROWSER_PANEL_BROWSER` — the environment override;
 *   3. well-known install paths for the platform;
 *   4. `PATH`;
 *   5. browser caches an automation tool already filled (Playwright, Puppeteer).
 *
 * A configured value that does not exist is reported as a misconfiguration
 * rather than being silently skipped: the user asked for that binary.
 *
 * @param config - normalized row config.
 * @param env - environment.
 * @param platform - `process.platform`.
 * @returns `{ found, configured, missingConfigured }`.
 */
function discoverBrowsers(config, env = process.env, platform = process.platform) {
  const configuredValue = config.browserPath !== '' ? config.browserPath : asText(env.DSH_BROWSER_PANEL_BROWSER, 400)
  const configuredSource = config.browserPath !== '' ? 'config' : 'environment'
  const found = []
  const seen = new Set()
  const record = (candidate, source) => {
    if (candidate === '' || seen.has(candidate)) return
    seen.add(candidate)
    found.push({ path: candidate, source, penalty: confinementPenalty(candidate) })
  }

  if (configuredValue !== '') {
    const resolved = resolveConfiguredBrowser(configuredValue, env)
    if (isExecutableFile(resolved)) record(resolved, configuredSource)
    else return { found: [], configured: resolved, missingConfigured: true }
  }

  for (const candidate of browserCandidates(platform, env)) {
    if (isExecutableFile(candidate)) record(candidate, 'known-path')
  }
  for (const name of browserSearchNames(platform)) {
    const resolved = lookupOnPath(name, env)
    if (resolved !== null) record(resolved, 'path')
  }
  for (const root of browserCacheRoots(platform, env, stateDirectory(env))) {
    for (const candidate of browsersInCache(root, platform)) record(candidate, 'browser-cache')
  }

  // Native installs first, then confined ones; discovery order breaks ties so
  // the ranking stays predictable instead of depending on sort stability luck.
  const ranked = found
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => (left.penalty - right.penalty) || (left.index - right.index))
    .map(({ path: candidate, source, penalty }) => ({ path: candidate, source, penalty }))
  return { found: ranked, configured: configuredValue === '' ? '' : resolveConfiguredBrowser(configuredValue, env), missingConfigured: false }
}

/**
 * Tell a real executable apart from a directory that merely exists.
 *
 * On a POSIX host this also insists on the execute bit, because a browser that
 * lost `+x` is the one failure a plain existence check reports as success and
 * then blames on something else entirely.
 *
 * @param candidate - absolute path to probe.
 * @returns whether it is an executable regular file.
 */
function isExecutableFile(candidate) {
  try {
    const stats = statSync(candidate)
    if (!stats.isFile()) return false
    if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) return false
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the browser binary this activation will drive.
 *
 * @param config - normalized row config.
 * @param env - environment, for the override.
 * @param platform - platform, for the candidate list.
 * @returns an absolute path to an existing executable.
 * @throws {BrowserUnavailableError} when nothing usable is configured or installed.
 */
function findBrowser(config, env = process.env, platform = process.platform) {
  const discovery = discoverBrowsers(config, env, platform)
  if (discovery.found.length > 0) return discovery.found[0].path
  if (discovery.missingConfigured) {
    throw new BrowserUnavailableError(`the browser this profile names is not an executable file: ${discovery.configured}`, {
      kind: 'not-executable',
      remedy: `Check browserPath (or DSH_BROWSER_PANEL_BROWSER). On Linux a browser that lost its execute bit reads as missing; try: chmod +x ${discovery.configured}`,
    })
  }
  throw new BrowserUnavailableError(missingBrowserMessage(config, env, platform), {
    kind: 'missing',
    remedy: missingBrowserRemedy(env, platform),
  })
}

/**
 * Explain, in one paragraph, that no Chromium-family browser exists here.
 *
 * The list of paths is worth printing — it is how a user recognises that their
 * browser lives somewhere this plugin did not think to look — but it is not the
 * interesting part. The interesting parts are that Firefox and Safari cannot
 * ever work here, and what to do about it.
 *
 * @param config - normalized row config.
 * @param env - environment.
 * @param platform - platform.
 * @returns the message.
 */
function missingBrowserMessage(config, env, platform) {
  const discovered = discoverBrowsers(config, env, platform)
  const lines = [
    'no Chromium-family browser was found on this machine.',
    '',
    'This plugin drives a browser over the Chrome DevTools Protocol, so it needs',
    'Chrome, Chromium, Edge, Brave, Vivaldi or Opera. Firefox and Safari speak a',
    'different protocol and cannot be driven this way.',
    '',
    'Looked in (in this order):',
    '  browserPath / DSH_BROWSER_PANEL_BROWSER — not set',
    ...browserCandidates(platform, env).map((candidate) => `  ${candidate}`),
    '  PATH — ' + browserSearchNames(platform).join(', '),
    ...browserCacheRoots(platform, env, stateDirectory(env)).map((root) => `  browser cache — ${root}`),
  ]
  return lines.join('\n')
}

/**
 * The next step to print after a failed search, per platform.
 *
 * @param env - environment.
 * @param platform - platform.
 * @returns a short, copy-pasteable remedy.
 */
function missingBrowserRemedy(env, platform) {
  const install = {
    win32: 'winget install Google.Chrome   (or: winget install Microsoft.Edge)',
    darwin: 'brew install --cask google-chrome   (or: brew install --cask chromium)',
    linux: 'sudo apt install chromium-browser   |   sudo dnf install chromium   |   sudo snap install chromium',
  }[platform] ?? 'install Chrome or Chromium with your package manager'
  return [
    `Install one: ${install}`,
    'Or let this plugin download one (set provision: auto, or call browser_panel_open and answer the prompt).',
    `Or point at one you already have: set browserPath in the sidebar-browser row, or DSH_BROWSER_PANEL_BROWSER=${env.HOME ?? env.USERPROFILE ?? '~'}${path.sep}path${path.sep}to${path.sep}chrome`,
  ].join('\n')
}

/**
 * The plugin's own state directory, next to the default browser profile.
 *
 * Holds what the plugin must remember between sessions — currently only whether
 * the user declined the download prompt — kept out of the browser profile so
 * deleting the profile does not resurrect a question the user already answered.
 *
 * @param env - environment carrying `HOME` / `USERPROFILE`.
 * @returns an absolute directory path.
 */
function stateDirectory(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  return path.join(home, '.dsh', 'browser-panel')
}

/**
 * Clamp an untrusted number into an integer range.
 *
 * @param value - candidate from row config or tool arguments.
 * @param fallback - value used when the candidate is not finite.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns a rounded, in-range integer.
 */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Keep a bounded, trimmed string from an untrusted source.
 *
 * @param value - candidate value.
 * @param limit - maximum length.
 * @returns the trimmed string, or '' when the candidate is not a string.
 */
function asText(value, limit = 400) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/**
 * Validate the row config once per activation.
 *
 * @param raw - the Loader row's `config` mapping.
 * @returns the resolved settings this service and its tools use.
 */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    actionTimeoutMs: clampInt(config.actionTimeoutMs, DEFAULTS.actionTimeoutMs, 1000, 120000),
    maxSnapshotChars: clampInt(config.maxSnapshotChars, DEFAULTS.maxSnapshotChars, 500, 200000),
    browserPath: asText(config.browserPath, 400),
    profileDir: asText(config.profileDir, 400),
    // Only an explicit `true` runs windowless: the visible window is the point,
    // so a typo must not silently turn the AI into a background process.
    headless: config.headless === true,
    windowWidth: clampInt(config.windowWidth, DEFAULTS.windowWidth, 320, 10000),
    windowHeight: clampInt(config.windowHeight, DEFAULTS.windowHeight, 240, 10000),
    // -1 means "let the OS place the window"; anything lower is nonsense.
    windowX: clampInt(config.windowX, DEFAULTS.windowX, -1, 20000),
    windowY: clampInt(config.windowY, DEFAULTS.windowY, -1, 20000),
    // 0 means "pick a free port"; a fixed one is for attaching a second CDP
    // client by hand.
    debugPort: clampInt(config.debugPort, DEFAULTS.debugPort, 0, 65535),
    startUrl: asText(config.startUrl, 2000) || DEFAULTS.startUrl,
    allowOrigins: asText(config.allowOrigins, 2000),
    // The name the browser profile itself carries, which is what the OS window
    // title, the taskbar tooltip and alt-tab show.
    windowName: asText(config.windowName, 60) || DEFAULTS.windowName,
    // An unknown mode falls back to the safest visible one rather than to `off`,
    // so a typo cannot silently hide the fact that this window is the AI's.
    ownership: OWNERSHIP_MODES.includes(config.ownership) ? config.ownership : DEFAULTS.ownership,
    markerTab: config.markerTab !== false,
    // An unknown value falls back to asking, never to downloading silently.
    provision: PROVISION_MODES.includes(config.provision) ? config.provision : DEFAULTS.provision,
  }
}

/**
 * Resolve one address the way the model is allowed to write it.
 *
 * A bare host is upgraded to HTTPS, exactly as the Sidebar address bar did.
 * `allowOrigins` is a guard on the agent's entry point, not a firewall: it
 * constrains what `browser_panel_open` will load, and says nothing about where a
 * page then navigates itself.
 *
 * @param input - the address the model asked for.
 * @param allowOrigins - comma-separated host suffixes; '' allows any http(s) host.
 * @returns the absolute URL to load.
 * @throws when the address cannot be opened under these rules.
 */
function resolveUrl(input, allowOrigins = '') {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('url is required')
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`"${raw}" is not a usable address`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http and https addresses can be opened; "${parsed.protocol}" cannot`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('addresses carrying embedded credentials are not opened')
  }
  const allowed = String(allowOrigins).split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
  if (allowed.length > 0) {
    const host = parsed.hostname.toLowerCase()
    const permitted = allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    if (!permitted) throw new Error(`${parsed.hostname} is outside the configured allowOrigins list (${allowed.join(', ')})`)
  }
  return parsed.href
}

/** Named keys `browser_panel_press` accepts, with their Chromium descriptors. */
const NAMED_KEYS = Object.freeze({
  // Enter carries `\r`: without a character, Chromium dispatches the keydown but
  // does not run the default action, so a form never submits.
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, text: '' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, text: '' },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, text: '' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, text: '' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, text: '' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, text: '' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, text: '' },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33, text: '' },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, text: '' },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, text: '' },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, text: '' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
})

/**
 * Translate a `usKeyboardLayout` code for a printable character.
 *
 * @param char - one character.
 * @returns a DOM `code`, or '' when the character has no simple code.
 */
function codeForChar(char) {
  if (/^[a-zA-Z]$/.test(char)) return `Key${char.toUpperCase()}`
  if (/^[0-9]$/.test(char)) return `Digit${char}`
  return ''
}

/**
 * Describe one key press in CDP terms.
 *
 * @param key - a named key, or a single character.
 * @returns the descriptor, or null when the tool cannot express that key.
 */
function keyDescriptor(key) {
  const named = NAMED_KEYS[key]
  if (named !== undefined) return named
  if ([...key].length === 1) return { key, code: codeForChar(key), windowsVirtualKeyCode: 0, text: key }
  return null
}

/**
 * Read a PNG's pixel size out of its own header.
 *
 * Cheaper and more trustworthy than asking the page how big it thinks it is:
 * the number describes the bytes actually written.
 *
 * @param bytes - the encoded PNG.
 * @returns width and height, or zeros when this is not a PNG.
 */
function pngSize(bytes) {
  if (bytes.length < 24) return { width: 0, height: 0 }
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return { width: 0, height: 0 }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** @param ms - milliseconds to pause. @returns a promise that resolves then. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param error - anything thrown. @returns its message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The file Chromium writes when it is told to pick its own debugging port.
 *
 * `--remote-debugging-port=0` makes the browser choose a port and publish it
 * here (port on line 1, browser websocket path on line 2). That is strictly
 * better than picking a port ourselves: there is no window between probing and
 * binding, and — the reason this exists — the file is the only way to find a
 * browser that is *already* running for this profile.
 *
 * @param profileDirectory - the browser's user data directory.
 * @returns the absolute path.
 */
function activePortFile(profileDirectory) {
  return path.join(profileDirectory, 'DevToolsActivePort')
}

/**
 * Turn a CDP `exceptionDetails` into a one-line reason.
 *
 * @param details - the protocol's exception report.
 * @returns the most specific message available.
 */
function describeException(details) {
  const exception = details !== null && typeof details === 'object' ? details.exception : undefined
  if (exception !== null && typeof exception === 'object' && typeof exception.description === 'string') {
    return exception.description.split('\n')[0]
  }
  if (details !== null && typeof details === 'object' && typeof details.text === 'string' && details.text !== '') return details.text
  return 'the page raised an error'
}

/** Page-side `cssPath`: a selector that re-finds the element it was read from. */
const CSS_PATH_SOURCE = `(el) => {
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    let step = node.localName;
    const parent = node.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, (child) => child.localName === node.localName);
      if (same.length > 1) step += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(step);
    node = parent;
  }
  if (parts.length === 0) return 'body';
  return (node === document.body ? 'body > ' : '') + parts.join(' > ');
}`

/** Page-side `isVisible`: laid out, not hidden, not transparent. */
const IS_VISIBLE_SOURCE = `(el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}`

/** Page-side `labelOf`: the text a human would call the element's label. */
const LABEL_SOURCE = `(el) => String(
  el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || ''
).replace(/\\s+/g, ' ').trim().slice(0, 200)`

/**
 * Build the page-side read for `browser_panel_snapshot`.
 *
 * Refs are plain CSS paths, so the outline never mutates the page to make
 * `browser_panel_click` work later.
 *
 * The ownership layer is suspended around the read: its badge lives in the DOM,
 * and `innerText` would otherwise hand the model the model's own label as page
 * copy. Suspending hides it, so the text is exactly the page's.
 *
 * @param maxChars - cap on the returned visible text.
 * @returns an expression `Runtime.evaluate` can run for a by-value answer.
 */
function buildSnapshotExpression(maxChars) {
  return `(() => {
  const cssPath = ${CSS_PATH_SOURCE};
  const isVisible = ${IS_VISIBLE_SOURCE};
  const labelOf = ${LABEL_SOURCE};
  const limit = ${JSON.stringify(maxChars)};
  const ownership = window.__DSH_AI_OWNERSHIP__;
  if (ownership !== undefined) ownership.suspend();
  try {
    const outline = [];
    for (const node of document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})) {
      if (outline.length >= ${OUTLINE_LIMIT}) break;
      if (!isVisible(node)) continue;
      if (node.closest('[data-dsh-ai]') !== null) continue;
      outline.push({
        ref: cssPath(node),
        tag: node.localName,
        type: node.getAttribute('type') || '',
        href: typeof node.href === 'string' ? node.href : '',
        disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
        text: labelOf(node)
      });
    }
    const full = (document.body ? document.body.innerText : '') || '';
    const text = full.replace(/\\n{3,}/g, '\\n\\n').slice(0, limit);
    return { url: location.href, title: document.title, text, truncated: full.length > text.length, outline };
  } finally {
    if (ownership !== undefined) ownership.resume();
  }
})()`
}

/**
 * Build the page-side probe for `browser_panel_click`.
 *
 * @param selector - CSS selector, or '' to match by label.
 * @param label - visible label text, or '' when a selector was given.
 * @param index - which match to take.
 * @returns an expression returning the target's viewport centre and identity.
 */
function buildClickExpression(selector, label, index) {
  return `(() => {
  const cssPath = ${CSS_PATH_SOURCE};
  const isVisible = ${IS_VISIBLE_SOURCE};
  const labelOf = ${LABEL_SOURCE};
  const selector = ${JSON.stringify(selector)};
  const wanted = ${JSON.stringify(label)};
  const index = ${JSON.stringify(index)};
  let node = null;
  let reason = '';
  if (selector !== '') {
    node = document.querySelector(selector);
    if (node === null) reason = 'selector matched no element';
  } else {
    const wantedLower = wanted.toLowerCase();
    const clickable = Array.prototype.filter.call(
      document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)}),
      (candidate) => isVisible(candidate) && candidate.closest('[data-dsh-ai]') === null
    );
    const exact = clickable.filter((candidate) => labelOf(candidate).toLowerCase() === wantedLower);
    let pool = exact.length > 0 ? exact : clickable.filter((candidate) => labelOf(candidate).toLowerCase().includes(wantedLower));
    if (pool.length === 0) {
      // A great many real interfaces are <div onclick> with no role, and the
      // curated clickable set above does not contain them at all. Fall back to
      // every visible element whose own label matches exactly, and keep only the
      // deepest such node so the click lands on the control rather than on a
      // wrapper that happens to contain it.
      const all = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 5000)
        .filter((candidate) => candidate.closest('[data-dsh-ai]') === null && isVisible(candidate));
      const matches = all.filter((candidate) => labelOf(candidate).toLowerCase() === wantedLower);
      pool = matches.filter((candidate) => !matches.some((other) => other !== candidate && candidate.contains(other)));
    }
    node = pool[index] === undefined ? null : pool[index];
    if (node === null) {
      // On a miss, say what the page does have: a model that guessed the wording
      // slightly wrong can correct itself from the nearest labels.
      const seen = [];
      for (const candidate of Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 5000)) {
        if (seen.length >= 3) break;
        if (candidate.closest('[data-dsh-ai]') !== null || !isVisible(candidate)) continue;
        const label = labelOf(candidate);
        if (label !== '' && label.toLowerCase().includes(wantedLower) && seen.indexOf(label) < 0) seen.push(label);
      }
      reason = pool.length === 0
        ? (seen.length === 0
          ? 'no visible element carried that text'
          : 'nothing matched that text exactly; labels containing it read: ' + seen.join(' / '))
        : 'index ' + index + ' is past the ' + pool.length + ' element(s) that matched';
    }
  }
  if (node === null) return { matched: false, reason, ref: '', label: '', x: 0, y: 0 };
  node.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = node.getBoundingClientRect();
  return {
    matched: true,
    reason: '',
    ref: cssPath(node),
    label: labelOf(node),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
})()`
}

/**
 * Build the page-side probe that focuses a field.
 *
 * @param selector - the field to focus.
 * @param requireEditable - whether a non-typable match is an error.
 * @returns an expression returning whether the element was found and focused.
 */
function buildFocusExpression(selector, requireEditable) {
  return `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (node === null) return { found: false, editable: false, reason: 'selector matched no element' };
  const tag = node.localName;
  const type = (node.getAttribute('type') || 'text').toLowerCase();
  const blocked = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'];
  const editable = node.isContentEditable === true || tag === 'textarea' || (tag === 'input' && blocked.indexOf(type) < 0);
  if (${requireEditable ? 'true' : 'false'} && !editable) {
    return { found: true, editable: false, reason: 'the matched ' + tag + ' is not an input, textarea, or contenteditable' };
  }
  node.focus();
  if (typeof node.setSelectionRange === 'function' && typeof node.value === 'string') {
    const end = node.value.length;
    try { node.setSelectionRange(end, end); } catch (error) { /* some input types refuse it; the caret is fine */ }
  }
  return { found: true, editable, reason: '' };
})()`
}

/**
 * Build the page-side read of a field's current value.
 *
 * @param selector - the field to read.
 * @returns an expression returning its value (or text for a contenteditable).
 */
function buildValueExpression(selector) {
  return `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (node === null) return '';
  if (typeof node.value === 'string') return node.value;
  return node.textContent || '';
})()`
}

/**
 * Names Chromium generates for a profile nobody named, in the locales this
 * plugin is likely to meet. Matching one means the name is not the user's.
 */
const GENERATED_PROFILE_NAME = /^(用户配置|个人|Person|Profile|Perfil|Profil|Профиль|Chrome)\s*\d*$/i

/**
 * Give the browser profile the plugin's own name before the browser first runs.
 *
 * Chromium publishes `profile.info_cache.<dir>.name` in the OS window title
 * ("Page - AI 浏览器 - Microsoft Edge"), the taskbar tooltip and alt-tab. That is
 * the only ownership signal that reaches someone looking at their desktop
 * rather than at the page, and it has to be written before the first launch —
 * a profile that already ran reports its own generated name forever after.
 *
 * A name the user chose themselves is never overwritten, and a `Local State` we
 * cannot parse is never rewritten.
 *
 * @param directory - the resolved profile directory.
 * @param name - the configured window name.
 */
async function seedProfileName(directory, name) {
  const file = path.join(directory, 'Local State')
  try {
    let state = {}
    if (existsSync(file)) {
      try {
        state = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return
      }
    }
    if (state === null || typeof state !== 'object') return
    const profile = state.profile !== null && typeof state.profile === 'object' ? state.profile : {}
    const cache = profile.info_cache !== null && typeof profile.info_cache === 'object' ? profile.info_cache : {}
    const entry = cache.Default !== null && typeof cache.Default === 'object' ? cache.Default : {}
    // A name someone chose is theirs; a name Chromium generated for itself is
    // not, and replacing it is the whole point of this function.
    if (typeof entry.name === 'string' && entry.name !== '' && entry.name !== name && !GENERATED_PROFILE_NAME.test(entry.name)) return
    if (entry.name === name) return
    entry.name = name
    entry.shortcut_name = name
    cache.Default = entry
    profile.info_cache = cache
    profile.profiles_order = Array.isArray(profile.profiles_order) && profile.profiles_order.length > 0
      ? profile.profiles_order
      : ['Default']
    state.profile = profile
    await writeFile(file, JSON.stringify(state))
  } catch {
    /* naming is cosmetic: a failure here must never stop the browser starting */
  }
}

/**
 * Build the page-side ownership layer.
 *
 * Injected with `Page.addScriptToEvaluateOnNewDocument`, so it has to survive
 * every document: ones whose CSP forbids inline script (the browser runs this,
 * not the document, so CSP does not apply) and ones that replace `document.body`
 * wholesale. Styles go through `cssText` rather than a `<style>` element or a
 * `style=` attribute, because CSSOM writes are exempt from `style-src`.
 *
 * The same script paints either the full marker card (on the marker tab, whose
 * URL carries {@link MARKER_HASH}) or the corner badge (everywhere else).
 *
 * @param options - `{ mode, brand }`.
 * @returns the source to inject.
 */
function buildOwnershipScript(options) {
  return `(function () {
  if (window.__DSH_AI_OWNERSHIP__) return;
  var MODE = ${JSON.stringify(options.mode)};
  var BRAND = ${JSON.stringify(options.brand)};
  var PLUGIN = ${JSON.stringify(PLUGIN)};
  var HASH = ${JSON.stringify(MARKER_HASH)};
  var TITLE = ${JSON.stringify(MARKER_TITLE)};
  var PILL = ${JSON.stringify(OWNERSHIP_PILL_ID)};
  var FRAME = ${JSON.stringify(OWNERSHIP_FRAME_ID)};
  var STATUS = ${JSON.stringify(OWNERSHIP_STATUS_ID)};
  var state = 'idle';
  var label = '';
  var owner = '';
  var hidden = false;
  var pulseTimer = 0;
  var pulseOn = false;
  var dot = null;
  var API = {
    paints: 0,
    state: 'idle',
    label: '',
    owner: '',
    set: set,
    suspend: suspend,
    resume: resume
  };

  function node(tag, css, text) {
    var el = document.createElement(tag);
    el.setAttribute('data-dsh-ai', '1');
    if (css) el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function add(parent, tag, css, text) {
    return parent.appendChild(node(tag, css, text));
  }
  function root() {
    return document.body || document.documentElement;
  }
  function box(id, css) {
    var el = document.getElementById(id);
    if (!el) {
      el = node('div', css);
      el.id = id;
      root().appendChild(el);
    }
    return el;
  }
  function isMarker() {
    return location.hash === HASH;
  }

  function paintPill() {
    var busy = state === 'busy';
    var shown = !hidden && (MODE === 'always' || busy);
    var pill = box(PILL, '');
    pill.textContent = '';
    pill.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;'
      + 'display:' + (shown ? 'flex' : 'none') + ';align-items:center;gap:8px;padding:7px 12px;border-radius:999px;'
      + 'font:500 12px/1.2 system-ui,"Segoe UI",sans-serif;letter-spacing:.2px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.35);'
      + 'border:1px solid ' + (busy ? 'rgba(251,191,36,.55)' : 'rgba(148,163,184,.35)') + ';'
      + 'background:' + (busy ? 'rgba(120,53,15,.94)' : 'rgba(15,23,42,.90)') + ';'
      + 'color:' + (busy ? '#fde68a' : '#cbd5e1') + ';';
    dot = add(pill, 'span', 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:'
      + (busy ? '#fbbf24' : '#38bdf8'));
    add(pill, 'span', '', BRAND + (busy && label ? ' · ' + label : ' · 空闲') + (owner ? ' · 负责人 ' + owner : ''));
    add(pill, 'span', 'opacity:.4;font-size:10px;letter-spacing:0', PLUGIN);
    var frame = box(FRAME, '');
    frame.style.cssText = busy && !hidden
      ? 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
        + 'border:3px solid rgba(251,191,36,.8);box-shadow:inset 0 0 70px rgba(251,191,36,.16);'
      : 'display:none;';
  }

  function paintStatus() {
    var line = document.getElementById(STATUS);
    if (!line) return;
    line.textContent = state === 'busy'
      ? 'AI 正在操作：' + (label || '处理中') + (owner ? '　（负责人：' + owner + '）' : '')
      : 'AI 空闲 — 窗口保持打开，下次操作直接用这里';
    var mark = document.getElementById(STATUS + '-dot');
    if (mark) mark.style.background = state === 'busy' ? '#fbbf24' : '#38bdf8';
  }

  function paintCard() {
    document.title = TITLE;
    // The marker tab may already be showing the badge: it starts life as the
    // browser's own about:blank tab, and adding a fragment to that is a
    // same-document navigation, so the badge from the previous paint is still
    // there. The card replaces it.
    var badge = document.getElementById(PILL);
    if (badge) badge.remove();
    var outline = document.getElementById(FRAME);
    if (outline) outline.remove();
    root().style.cssText = 'margin:0;background:#0b1020;color:#e2e8f0;';
    if (document.getElementById('dsh-ai-marker')) {
      paintStatus();
      return;
    }
    var card = node('div', 'max-width:780px;margin:0 auto;padding:46px 28px 72px;'
      + 'font:15px/1.75 system-ui,"Segoe UI",sans-serif;');
    card.id = 'dsh-ai-marker';
    root().appendChild(card);
    add(card, 'div', 'font-size:42px;line-height:1', '\\u{1F916}');
    add(card, 'div', 'margin:12px 0 6px;font-size:25px;font-weight:650;color:#f8fafc', BRAND);
    add(card, 'div', 'color:#94a3b8;margin-bottom:24px',
      '这个窗口由 DSH 插件 ' + PLUGIN + ' 打开并驱动，不是你自己启动的浏览器。');
    var bar = add(card, 'div', 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:12px;'
      + 'background:#111a2e;border:1px solid #1e293b;margin-bottom:26px;');
    add(bar, 'span', 'width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#38bdf8').id = STATUS + '-dot';
    add(bar, 'span', 'font-weight:600;color:#e2e8f0', '').id = STATUS;
    var notes = [
      '独立配置：这个窗口用自己的 profile，不共享你日常浏览器的登录状态。',
      '你是主人：随时可以直接在这个窗口里接手点击和输入。',
      '关掉这个窗口，AI 就没有浏览器了；下次调用工具会重新打开一个。',
      'AI 操作期间页面四边会亮起琥珀色边框，右下角同时显示当前动作。',
      '每个页面右下角的角标写着它的负责人；agent 结束后页面保留，后来者可以接手。'
    ];
    for (var i = 0; i < notes.length; i++) {
      var row = add(card, 'div', 'display:flex;gap:8px;padding:7px 0;border-top:1px solid #16203a');
      add(row, 'span', 'color:#fbbf24;width:12px;flex:0 0 auto', '·');
      add(row, 'span', 'color:#cbd5e1;flex:1 1 auto', notes[i]);
    }
    add(card, 'div', 'margin-top:26px;color:#7c8aa5;font-size:13px',
      '工具：status / open / snapshot / click / type / press / navigate / eval / screenshot');
    paintStatus();
  }

  function apply() {
    API.paints += 1;
    API.state = state;
    API.label = label;
    API.owner = owner;
    if (isMarker()) paintCard();
    else paintPill();
  }

  function set(next, nextLabel, nextOwner) {
    state = next === 'busy' ? 'busy' : 'idle';
    label = typeof nextLabel === 'string' ? nextLabel : '';
    owner = typeof nextOwner === 'string' ? nextOwner : '';
    pulse();
    apply();
  }
  function suspend() {
    hidden = true;
    if (!isMarker()) paintPill();
  }
  function resume() {
    hidden = false;
    apply();
  }
  function pulse() {
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = 0; }
    if (state !== 'busy') { pulseOn = false; return; }
    pulseTimer = setInterval(function () {
      if (state !== 'busy' || !dot) return;
      pulseOn = !pulseOn;
      dot.style.boxShadow = pulseOn ? '0 0 0 5px rgba(251,191,36,.22)' : '0 0 0 0 rgba(251,191,36,0)';
    }, 550);
  }

  window.__DSH_AI_OWNERSHIP__ = API;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})()`
}

/**
 * Build the expression that pushes ownership state into an attached page.
 *
 * @param state - `'busy'` or `'idle'`.
 * @param label - what the AI is doing, shown while busy.
 * @param owner - who owns the page, shown on the badge at all times.
 * @returns an expression for `Runtime.evaluate`.
 */
function ownershipExpression(state, label, owner) {
  return `(function () {
  var api = window.__DSH_AI_OWNERSHIP__;
  if (!api) return false;
  api.set(${JSON.stringify(state)}, ${JSON.stringify(label)}, ${JSON.stringify(owner)});
  return true;
})()`
}

/**
 * Shorten a session id to something that fits on a badge.
 *
 * The tail is kept rather than the head: agent ids usually share a prefix and
 * differ at the end.
 *
 * @param agentId - the session asking.
 * @returns up to six alphanumeric characters.
 */
function sessionTag(agentId) {
  return String(agentId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-6)
}

/**
 * Name the agent that owns a page, for humans rather than for the protocol.
 *
 * The DSH session id is a UUID, so a raw tail (`#87ef5e`) tells nobody who is
 * driving. Three inputs are tried in order:
 *
 *   1. a team member name (`lead`, `researcher-a`), resolved by the caller from
 *      the `agentTeams` service;
 *   2. the delegation depth from the session header, which distinguishes "the
 *      main session" from "a subagent" even when no name exists;
 *   3. the session tag, so two unnamed agents still read differently.
 *
 * @param details - `{ id, name?, subagent?, delegationDepth? }`.
 * @returns a short human-readable owner label.
 */
function agentLabel(details = {}) {
  const name = typeof details.name === 'string' ? details.name.trim() : ''
  if (name !== '') return name
  const id = typeof details.id === 'string' ? details.id : ''
  const depth = Number(details.delegationDepth)
  const subagent = details.subagent === true || (Number.isFinite(depth) && depth > 0)
  const role = subagent ? `子 agent L${Number.isFinite(depth) && depth > 0 ? depth : 1}` : '主会话'
  const tag = sessionTag(id)
  return tag === '' ? role : `${role} #${tag}`
}

/**
 * Nothing usable to drive: no browser, a broken one, or a refused download.
 *
 * Carries `kind` and `remedy` so the tool layer can print an actionable next
 * step instead of a symptom, and so tests can assert which failure was seen
 * rather than matching prose.
 */
class BrowserUnavailableError extends Error {
  /**
   * @param message - what happened, in full.
   * @param options - `{ kind, remedy }`.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BrowserUnavailableError'
    this.kind = options.kind ?? 'missing'
    this.remedy = options.remedy ?? ''
  }
}

/**
 * Decide how to launch: headless or not, which profile, which extra flags.
 *
 * Pure with respect to the world — every input that matters (platform, env,
 * uid, executable path) is a parameter — because this is where the Linux
 * realities live: no display, running as root, and the two confinements that
 * refuse to write anywhere but inside their own sandbox.
 *
 * @param options - `{ browserPath, config, port, profileDir, env, platform, uid, headlessFlag }`.
 * @returns `{ args, profileDir, headless, headlessReason, noSandbox, notes }`.
 */
function launchPlan(options) {
  const {
    browserPath,
    config,
    port,
    profileDir,
    env = process.env,
    platform = process.platform,
    uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
    headlessFlag = 'new',
  } = options
  const notes = []
  let headless = config.headless
  let headlessReason = headless ? 'this row is configured headless' : ''
  if (!headless && platform === 'linux' && asText(env.DISPLAY, 40) === '' && asText(env.WAYLAND_DISPLAY, 40) === '') {
    headless = true
    headlessReason = 'this Linux host has no DISPLAY or WAYLAND_DISPLAY, so no window could be shown'
    notes.push(headlessReason)
  }
  if (asText(env.WSL_DISTRO_NAME, 60) !== '' && !headless) {
    notes.push('running under WSL: a window would appear on the Windows side, not next to this shell')
  }

  const normalized = browserPath.replace(/\\/g, '/')
  let profile = profileDir
  const home = asText(env.HOME, 400) || asText(env.USERPROFILE, 400) || homedir()
  const snapName = /^\/snap\/bin\/([^/]+)$/.exec(normalized)?.[1] ?? /^\/snap\/([^/]+)\/current\//.exec(normalized)?.[1]
  if (snapName !== undefined) {
    const root = asText(env.SNAP_USER_COMMON, 400) || path.join(home, 'snap', snapName, 'common')
    profile = path.join(root, 'dsh-browser-panel', 'browser-profile')
    notes.push(`snap confinement: the profile has to live in ${root}, because snap's AppArmor profile rejects any other directory`)
  } else if (normalized.includes('/flatpak/') || normalized.includes('/.var/app/')) {
    const appId = path.basename(normalized)
    profile = path.join(home, '.var', 'app', appId, 'config', 'dsh-browser-panel', 'browser-profile')
    notes.push(`flatpak confinement: the profile has to live in ~/.var/app/${appId}`)
  }

  const noSandbox = platform === 'linux' && uid === 0
  if (noSandbox) notes.push('running as root, so Chromium requires --no-sandbox; the renderer sandbox is off for this window')

  const args = [
    `--remote-debugging-port=${port}`,
    // Loopback only: the devtools port is a remote-control channel for whatever
    // runs this browser, and it must never be reachable from the network.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // A fresh profile on a signed-in account makes Edge and Chrome volunteer
    // their "sign in to sync" dialog, which then covers the page the user is
    // supposed to be watching.
    '--disable-sync',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,msImplicitSignin,msEdgeSyncPromo,EdgeSyncPromo',
    `--window-size=${config.windowWidth},${config.windowHeight}`,
  ]
  if (config.windowX >= 0 && config.windowY >= 0) args.push(`--window-position=${config.windowX},${config.windowY}`)
  if (headless) args.push(headlessFlag === 'legacy' ? '--headless' : '--headless=new')
  if (noSandbox) args.push('--no-sandbox')
  // Always name the first page: without it the browser may open its own
  // new-tab page, and the first `open` would create a needless second tab.
  args.push(config.startUrl)
  return { args, profileDir: profile, headless, headlessReason, noSandbox, notes }
}

/** @returns a fresh log file path for one browser or installer process. */
function processLogFile() {
  return path.join(tmpdir(), `dsh-browser-panel-${process.pid}-${Date.now().toString(36)}.log`)
}

/**
 * Read the tail of a process log, for explaining why something died.
 *
 * Captured through a file rather than a pipe on purpose: a piped stdio is
 * refused outright under the harness's confined modes, and a browser whose
 * stderr we cannot read is a browser whose failures we cannot explain.
 *
 * @param file - log path.
 * @param limit - characters to keep from the end.
 * @returns the tail, or '' when there is nothing to say.
 */
function tailOfLog(file, limit = LOG_TAIL_BYTES) {
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text === '') return ''
    return text.length <= limit ? text : `…${text.slice(-limit)}`
  } catch {
    return ''
  }
}

/** Zip record signatures this reader understands. */
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC-32, as zip archives store it.
 *
 * Used to check every extracted entry: a download that was cut short produces an
 * archive that opens and unpacks into a browser that does not run, and the
 * difference between "broken download" and "broken browser" is worth knowing.
 *
 * @param buffer - bytes to checksum.
 * @returns the unsigned checksum.
 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Read a zip archive's central directory.
 *
 * Only what a Chrome for Testing build actually uses: the 32-bit format, stored
 * or deflated entries. Zip64 and other methods are reported rather than
 * mis-extracted, and every name is validated before anything is written.
 *
 * @param buffer - the whole archive.
 * @returns entry records.
 * @throws when the file is not a readable zip.
 */
function zipEntries(buffer) {
  let end = -1
  const earliest = Math.max(0, buffer.length - 66000)
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === ZIP_END_SIGNATURE) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('the downloaded file is not a zip archive')
  const count = buffer.readUInt16LE(end + 10)
  const offset = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error('this archive uses zip64, which this plugin cannot unpack')
  const entries = []
  let at = offset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('the zip central directory is malformed')
    }
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    entries.push({
      name,
      method: buffer.readUInt16LE(at + 10),
      crc: buffer.readUInt32LE(at + 16),
      compressedSize: buffer.readUInt32LE(at + 20),
      uncompressedSize: buffer.readUInt32LE(at + 24),
      localOffset: buffer.readUInt32LE(at + 42),
      mode: (buffer.readUInt32LE(at + 38) >>> 16) & 0xffff,
      directory: name.endsWith('/'),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Resolve one zip entry name against the destination, refusing escapes.
 *
 * @param destination - extraction root.
 * @param name - entry name from the archive.
 * @returns the absolute target path.
 * @throws when the name is absolute or climbs out of the destination.
 */
function zipTarget(destination, name) {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error(`the archive contains an absolute path: ${name}`)
  const root = path.resolve(destination)
  const target = path.resolve(root, normalized)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`the archive contains a path that escapes the destination: ${name}`)
  return target
}

/**
 * Extract one entry's bytes.
 *
 * @param buffer - the whole archive.
 * @param entry - a record from {@link zipEntries}.
 * @returns the uncompressed bytes.
 */
function zipEntryData(buffer, entry) {
  const at = entry.localOffset
  if (buffer.readUInt32LE(at) !== ZIP_LOCAL_SIGNATURE) throw new Error(`the archive entry ${entry.name} has no local header`)
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`the archive entry ${entry.name} uses compression method ${entry.method}, which this plugin cannot unpack`)
}

/**
 * Unpack a whole zip archive into a directory.
 *
 * Symlinks are recreated rather than followed into files: the macOS Chrome for
 * Testing bundle is built out of them, and flattening them changes what the
 * browser is.
 *
 * @param buffer - the whole archive.
 * @param destination - extraction root.
 * @returns how many files were written.
 */
async function extractZip(buffer, destination) {
  let written = 0
  for (const entry of zipEntries(buffer)) {
    const target = zipTarget(destination, entry.name)
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    const data = zipEntryData(buffer, entry)
    if (entry.crc !== 0 && crc32(data) !== entry.crc) {
      throw new Error(`the archive entry ${entry.name} is corrupt (checksum mismatch); the download was probably cut short`)
    }
    if ((entry.mode & 0o170000) === 0o120000) {
      await rm(target, { force: true })
      await symlink(data.toString('utf8'), target)
    } else {
      await writeFile(target, data)
      if (entry.mode !== 0) await chmod(target, entry.mode & 0o777).catch(() => {})
    }
    written += 1
  }
  return written
}

/**
 * Stream a URL to a file.
 *
 * @param url - what to fetch.
 * @param destination - where to put it.
 * @param options - `{ signal, onProgress }`.
 * @returns `{ bytes, total }`.
 */
async function downloadFile(url, destination, options = {}) {
  const response = await fetch(url, { signal: options.signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`the download answered ${response.status} ${response.statusText}`)
  if (response.body === null) throw new Error('the download returned an empty body')
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (options.onProgress !== undefined) {
        try {
          options.onProgress(received, total)
        } catch {
          /* progress reporting must never break the download */
        }
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(destination))
  return { bytes: received, total }
}

/**
 * Which Chrome for Testing asset suits this machine.
 *
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the asset's platform key.
 */
function chromeForTestingPlatform(platform, arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  return arch === 'arm64' ? 'linux-arm64' : 'linux64'
}

/**
 * Download and unpack the current Chrome for Testing stable build.
 *
 * The point of using Chrome for Testing rather than a package manager: it needs
 * nothing on the machine but this plugin. A user with no browser, no npm and no
 * package-manager rights still ends up with a browser they can drive.
 *
 * @param options - `{ stateDir, platform, arch, signal, log, onProgress }`.
 * @returns `{ version, destination, bytes }`.
 * @throws when the index, the download, or the unpack fails.
 */
async function installChromeForTesting(options) {
  const { stateDir, platform = process.platform, arch = process.arch, signal, log } = options
  const response = await fetch(CHROME_FOR_TESTING_INDEX, { signal })
  if (!response.ok) throw new Error(`the Chrome for Testing index answered ${response.status}`)
  const index = await response.json()
  const stable = index !== null && typeof index === 'object' ? index.channels?.Stable : undefined
  const wanted = chromeForTestingPlatform(platform, arch)
  const assets = stable !== null && typeof stable === 'object' && Array.isArray(stable.downloads?.chrome) ? stable.downloads.chrome : []
  const asset = assets.find((entry) => entry !== null && typeof entry === 'object' && entry.platform === wanted)
  const version = typeof stable?.version === 'string' ? stable.version : ''
  if (version === '' || asset === undefined || typeof asset.url !== 'string') {
    throw new Error(`the Chrome for Testing index did not describe a ${wanted} build`)
  }
  const browsersDir = path.join(stateDir, 'browsers')
  const destination = path.join(browsersDir, `chrome-for-testing-${version}`)
  const archive = path.join(tmpdir(), `chrome-for-testing-${version}-${wanted}.zip`)
  await mkdir(browsersDir, { recursive: true })
  log?.(`downloading Chrome for Testing ${version} (${wanted}) from ${asset.url}`)
  const downloaded = await downloadFile(asset.url, archive, { signal, onProgress: options.onProgress })
  try {
    log?.(`downloaded ${Math.round(downloaded.bytes / 1048576)} MB; unpacking`)
    const written = await extractZip(readFileSync(archive), destination)
    log?.(`unpacked ${written} files into ${destination}`)
  } finally {
    await rm(archive, { force: true })
  }
  return { version, destination, bytes: downloaded.bytes }
}

/** What the user picks when the plugin offers to fetch a browser. */
const DOWNLOAD_ANSWER = '下载一个 Chrome for Testing (Recommended)'
/** What the user picks to switch the plugin off instead. */
const DECLINE_ANSWER = '不用了，先停用这个插件'

/**
 * The question shown in the DSH UI when there is no browser to drive.
 *
 * Written for someone who has never heard of CDP: what is missing, why Firefox
 * will not do, what the download costs, and that saying no is fine.
 *
 * @returns one `AskUserQuestionRequest` question.
 */
function browserQuestion() {
  return {
    id: 'browser-download',
    header: '需要浏览器',
    question: '这台机器上找不到可以自动化的浏览器（Chrome / Chromium / Edge / Brave 都没有）。要我现在下载一个吗？',
    detail: [
      '这个插件通过 Chrome DevTools Protocol 驱动浏览器，所以必须是 Chromium 系；**Firefox 和 Safari 不行**，协议完全不同。',
      '',
      `选择「${DOWNLOAD_ANSWER}」的话，我会取 Google 官方的 Chrome for Testing 稳定版：`,
      '',
      '- 下载约 **196 MB**（版本 154 实测），解压后占用更多磁盘；',
      '- 放在插件自己的目录 `~/.dsh/browser-panel/browsers/`，**不动你系统里的任何浏览器**；',
      '- 只给这个插件用，删掉整个目录即可卸载。',
      '',
      '也可以自己装，装好之后插件会自动认出来，不用重启：',
      '',
      '- Windows：`winget install Google.Chrome`',
      '- macOS：`brew install --cask google-chrome`',
      '- Linux：`sudo apt install chromium-browser`（或 `dnf` / `snap`）',
    ].join('\n'),
    options: [
      { label: DOWNLOAD_ANSWER, description: '官方 Chrome for Testing 稳定版，约 196 MB，只装进插件自己的目录。' },
      { label: DECLINE_ANSWER, description: '插件保持停用，不再询问；你随时可以自己装一个，它能自动认出来。' },
    ],
  }
}

/**
 * Read the plugin's remembered decisions.
 *
 * @param file - state file path.
 * @returns the parsed object, or `{}` when absent or unreadable.
 */
async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * One CDP connection to one target.
 *
 * Deliberately transport-agnostic: the constructor takes anything with
 * `send`/`close` plus assignable `onmessage`/`onclose`/`onerror`, so tests can
 * drive the id correlation, error and timeout paths without a socket at all.
 */
class CdpClient {
  /**
   * @param socket - a WebSocket-like transport.
   * @param options - `{ timeoutMs }` default budget for one command.
   */
  constructor(socket, options = {}) {
    this.socket = socket
    this.timeoutMs = clampInt(options.timeoutMs, DEFAULTS.actionTimeoutMs, 200, 300000)
    this.nextId = 0
    /** Commands awaiting a reply. */
    this.pending = new Map()
    /** Protocol events this half listens for. */
    this.listeners = new Map()
    this.closed = false
    this.closeReason = ''
    socket.onmessage = (event) => {
      this.handleMessage(event === null || event === undefined ? '' : event.data)
    }
    socket.onclose = () => {
      this.fail('the browser closed the connection')
    }
    socket.onerror = () => {
      this.fail('the browser connection failed')
    }
  }

  /**
   * Open a connection, failing fast when the target never answers.
   *
   * @param url - the target's `webSocketDebuggerUrl`.
   * @param options - `{ timeoutMs }`.
   * @returns a connected client.
   */
  static async connect(url, options = {}) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the browser did not accept a devtools connection within 10 s`))
      }, 10000)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('the browser refused a devtools connection'))
      }
    })
    return new CdpClient(socket, options)
  }

  /**
   * Send one command and await its reply.
   *
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param timeoutMs - per-call budget, clamped to the client's own range.
   * @returns the protocol result.
   * @throws on a protocol error, a timeout, or a closed connection.
   */
  send(method, params = {}, timeoutMs) {
    if (this.closed) return Promise.reject(new Error(`the browser connection is closed (${this.closeReason})`))
    const budget = clampInt(timeoutMs, this.timeoutMs, 100, 300000)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer "${method}" within ${budget} ms`))
      }, budget)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Route one inbound frame: a reply to a pending command, or an event.
   *
   * @param raw - the frame payload.
   */
  handleMessage(raw) {
    if (typeof raw !== 'string' || raw === '') return
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined && message.error !== null) {
        const detail = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)
        entry.reject(new Error(detail))
        return
      }
      entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const handlers = this.listeners.get(message.method)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {})
      } catch {
        /* a listener must never take the connection down */
      }
    }
  }

  /**
   * Subscribe to one protocol event.
   *
   * @param method - event name.
   * @param handler - invoked with the event params.
   * @returns an unsubscribe function.
   */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set()
    handlers.add(handler)
    this.listeners.set(method, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.listeners.delete(method)
    }
  }

  /**
   * Await one protocol event.
   *
   * @param method - event name.
   * @param timeoutMs - how long to wait.
   * @returns the event params, or null when the wait expired.
   */
  waitForEvent(method, timeoutMs) {
    const budget = clampInt(timeoutMs, this.timeoutMs, 100, 300000)
    return new Promise((resolve) => {
      let unsubscribe = () => {}
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, budget)
      unsubscribe = this.on(method, (params) => {
        clearTimeout(timer)
        unsubscribe()
        resolve(params)
      })
    })
  }

  /**
   * Mark the connection dead and reject everything still in flight.
   *
   * @param reason - why it died, surfaced to every waiting caller.
   */
  fail(reason) {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    this.listeners.clear()
  }

  /** Close deliberately, releasing every waiter. */
  close() {
    if (this.closed) return
    this.closed = true
    this.closeReason = 'the plugin closed it'
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(this.closeReason))
    }
    this.pending.clear()
    this.listeners.clear()
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Owns the browser process, its tabs, and one CDP connection per agent.
 *
 * Lifecycle is deliberately lazy: nothing is spawned until a tool that needs a
 * page runs. `browser_panel_status` only reports, so a status call can never
 * surprise the user with a window.
 */
class BrowserWindowController {
  /**
   * @param config - the Loader row's config mapping.
   * @param seams - injectable edges: `{ ask, install, log, env, platform, arch }`.
   *   Production passes the cordis context's user-questions service; tests pass
   *   fakes, which is how the Linux and no-browser paths are covered at all.
   */
  constructor(config, seams = {}) {
    this.config = normalizeConfig(config)
    this.seams = seams
    this.env = seams.env ?? process.env
    this.platform = seams.platform ?? process.platform
    this.arch = seams.arch ?? process.arch
    this.child = null
    this.port = 0
    this.browserPath = ''
    this.version = ''
    this.lastError = ''
    /** Agent id -> `{ targetId, client }`. */
    this.tabs = new Map()
    this.browserClient = undefined
    /** The marker tab that tells a human this window is the AI's. */
    this.marker = undefined
    /** Last discovery result; refreshed whenever it matters. */
    this.discovery = undefined
    /** `ok` | `missing` | `declined` | `installing` | `install-failed` | `unknown`. */
    this.provision = 'unknown'
    /** The last thing that happened around provisioning, for `status`. */
    this.provisionDetail = ''
    /** The last launch plan, so `status` can report the effective environment. */
    this.plan = undefined
    this.launchNotes = []
    /** The log file of the current browser process. */
    this.logFile = ''
    /** Exit code of a browser that already died, for the failure report. */
    this.exitCodeSeen = undefined
    /** True when attached to a browser this controller did not start itself. */
    this.adopted = false
    /** Agent id -> human-readable owner label, remembered across tool calls. */
    this.agentLabels = new Map()
    /**
     * Agents this controller has seen alive. A page outlives its agent on
     * purpose, so "is the owner still running?" cannot be answered from
     * {@link tabs}; it needs its own record.
     */
    this.liveAgents = new Set()
  }

  /**
   * The profile directory this browser would use.
   *
   * Reported even before launch, and through {@link effectiveProfile} once the
   * launch plan has moved it somewhere a confinement will accept.
   *
   * @returns an absolute directory path.
   */
  profileDirectory() {
    const configured = this.config.profileDir
    return configured === '' ? path.join(stateDirectory(this.env), 'browser-profile') : path.resolve(configured)
  }

  /** @returns the profile the next launch would actually use. */
  effectiveProfile() {
    return this.plan?.profileDir ?? this.profileDirectory()
  }

  /** @returns whether this controller currently has a browser it can drive. */
  get running() {
    if (this.adopted) return true
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * What this machine has, ranked. Filesystem only: never starts anything.
   *
   * @param force - re-run discovery instead of using the cached answer.
   * @returns the discovery record.
   */
  probe(force = false) {
    if (force || this.discovery === undefined) {
      this.discovery = discoverBrowsers(this.config, this.env, this.platform)
    }
    return this.discovery
  }

  /** @returns the browser discovery would use, or '' when there is none. */
  get bestBrowser() {
    return this.probe().found[0]?.path ?? ''
  }

  /** @returns the state file remembering what the user decided. */
  provisionStateFile() {
    return path.join(stateDirectory(this.env), 'state.json')
  }

  /**
   * Run the activation-time check.
   *
   * Detection happens here so the answer is known before anything is asked of
   * the user; the question itself cannot be asked from here, because the DSH
   * answerer only routes requests carrying a live agent.
   *
   * @returns a promise that settles when the check is recorded.
   */
  async start() {
    const state = await readState(this.provisionStateFile())
    const declined = state.provision?.declined === true
    const discovery = this.probe(true)
    this.provision = discovery.found.length > 0 ? 'ok' : (declined ? 'declined' : 'missing')
    this.provisionDetail = discovery.found.length > 0
      ? `using ${discovery.found[0].path} (${discovery.found[0].source})`
      : (declined ? 'no browser, and the download was declined earlier' : 'no Chromium-family browser found on this machine')
    this.seams.log?.(`browser panel: ${this.provisionDetail}`)
  }

  /**
   * Remember that the user does not want a downloaded browser.
   *
   * @param declined - whether the refusal stands.
   */
  async rememberDecline(declined) {
    const file = this.provisionStateFile()
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({
        provision: { declined, at: new Date().toISOString() },
      }, null, 2))
    } catch (error) {
      this.seams.log?.(`browser panel: could not record the provisioning decision: ${messageOf(error)}`)
    }
  }

  /**
   * Start the browser if it is not already running.
   *
   * @param exec - the tool call context, needed to ask the user a question.
   * @throws {BrowserUnavailableError} when there is nothing to drive and nothing to do about it.
   */
  async ensureBrowser(exec) {
    if (this.running) return
    if (this.child !== null) this.forgetBrowser()
    installExitHook()
    let discovery = this.probe(true)
    if (discovery.found.length === 0) {
      const installed = await this.offerBrowser(exec)
      discovery = this.probe(true)
      if (!installed || discovery.found.length === 0) throw this.unavailable(discovery)
    }
    // A browser that appeared later lifts an earlier refusal by itself.
    if (this.provision === 'declined') {
      this.provision = 'ok'
      await this.rememberDecline(false)
    }

    const browserPath = discovery.found[0].path
    const profileDirectory = this.profileDirectory()
    await mkdir(profileDirectory, { recursive: true })
    // Must happen before the first launch: afterwards the profile has a name of
    // its own and the window title stops being a clue.
    await seedProfileName(profileDirectory, this.config.windowName)

    // A browser from an earlier session may still own this profile. Starting a
    // second one would hand off to it and exit, so adopt it instead — it records
    // its devtools port in the profile precisely so this is possible.
    const existing = await this.readActivePort(profileDirectory)
    if (existing !== 0) {
      await this.adopt(existing, browserPath)
      return
    }

    // 0 means "pick a port and record it", which removes both the port race and
    // the need to guess where a still-running browser is listening. A fixed
    // `debugPort` is still honoured for people who attach a second CDP client.
    const port = this.config.debugPort

    // A Chromium older than 112 does not know `--headless=new` and, having no
    // display, dies on the unknown flag rather than the missing one. Only a
    // headless run is worth retrying: a visible one is unaffected by the flag.
    const probePlan = launchPlan({
      browserPath,
      config: this.config,
      port: 0,
      profileDir: profileDirectory,
      env: this.env,
      platform: this.platform,
    })
    const flags = probePlan.headless ? ['new', 'legacy'] : ['new']
    let lastFailure
    for (const headlessFlag of flags) {
      try {
        await this.launch(browserPath, profileDirectory, port, headlessFlag)
        return
      } catch (error) {
        lastFailure = error
        const retryable = error instanceof BrowserUnavailableError && error.kind === 'exited' && headlessFlag !== 'legacy'
        if (!retryable) break
        this.seams.log?.('browser panel: retrying once with the legacy --headless flag')
      }
    }
    this.dispose()
    throw lastFailure
  }

  /**
   * Attach to a browser that is already running for this profile.
   *
   * @param port - the devtools port it recorded.
   * @param browserPath - the executable discovery chose, for reporting.
   */
  async adopt(port, browserPath) {
    const version = await this.devTools('/json/version', port)
    this.port = port
    this.browserPath = browserPath
    this.version = version !== null && typeof version === 'object' && typeof version.Browser === 'string' ? version.Browser : ''
    this.adopted = true
    this.lastError = ''
    this.seams.log?.(`browser panel: reusing the browser already running for this profile on port ${port}`)
  }

  /**
   * The port a running browser for this profile recorded, or 0.
   *
   * The file is a claim, not a promise: it survives an unclean exit, so the port
   * is verified before anything is built on it.
   *
   * @param profileDirectory - the browser's user data directory.
   * @param timeoutMs - how long to give the probe.
   * @returns a live devtools port, or 0.
   */
  async readActivePort(profileDirectory, timeoutMs = 1500) {
    let port
    try {
      port = Number(String(readFileSync(activePortFile(profileDirectory), 'utf8')).split('\n')[0].trim())
    } catch {
      return 0
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return 0
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return 0
      // Insist on a devtools answer: the recorded port may since have been taken
      // by an unrelated service, and adopting that would fail much later and
      // much more confusingly.
      const version = await response.json().catch(() => null)
      if (version === null || typeof version !== 'object') return 0
      if (typeof version.Browser !== 'string' && typeof version.webSocketDebuggerUrl !== 'string') return 0
      return port
    } catch {
      return 0
    }
  }

  /**
   * Spawn the browser once and wait for its devtools endpoint.
   *
   * @param browserPath - the executable.
   * @param profileDirectory - its profile.
   * @param port - the debugging port.
   * @param headlessFlag - `new` or `legacy`.
   * @throws {BrowserUnavailableError} with the browser's own output attached.
   */
  async launch(browserPath, profileDirectory, port, headlessFlag) {
    const plan = launchPlan({
      browserPath,
      config: this.config,
      port,
      profileDir: profileDirectory,
      env: this.env,
      platform: this.platform,
      headlessFlag,
    })
    this.plan = plan
    this.launchNotes = plan.notes
    await mkdir(plan.profileDir, { recursive: true })
    if (plan.profileDir !== profileDirectory) await seedProfileName(plan.profileDir, this.config.windowName)

    const log = processLogFile()
    const fd = openSync(log, 'a')
    const child = spawn(browserPath, plan.args, { stdio: ['ignore', fd, fd], windowsHide: false })
    closeSync(fd)
    this.child = child
    this.port = port
    this.browserPath = browserPath
    this.logFile = log
    this.lastError = ''
    LIVE_BROWSERS.add(child)
    child.on('exit', (code, signal) => this.onExit(child, code, signal))
    // A spawn failure (missing file, no permission) would otherwise only surface
    // as the devtools timeout 25 s later.
    const spawnFailure = new Promise((_, reject) => {
      child.once('error', (error) => reject(new BrowserUnavailableError(
        `could not start ${browserPath}: ${error.message}`,
        { kind: 'not-executable', remedy: 'Check that this file exists and is executable.' },
      )))
    })
    spawnFailure.catch(() => {})
    this.exitCodeSeen = undefined
    try {
      await Promise.race([this.waitForDevTools(plan.profileDir, port), spawnFailure])
    } catch (error) {
      // A spawn failure already names the file and the reason; anything that got
      // as far as running needs the browser's own output attached instead.
      const tail = tailOfLog(log)
      const kind = error instanceof BrowserUnavailableError ? error.kind : 'silent'
      this.dispose()
      if (kind === 'not-executable') throw error
      throw new BrowserUnavailableError([
        `${browserPath} ${kind === 'exited' ? 'exited before it could be driven' : 'never published a devtools endpoint'}.`,
        this.exitCodeSeen === undefined ? '' : `It exited with code ${this.exitCodeSeen}.`,
        tail === '' ? '' : `Its output was:\n${tail}`,
        plan.notes.length === 0 ? '' : `Environment notes: ${plan.notes.join('; ')}`,
      ].filter((line) => line !== '').join('\n'), {
        kind,
        remedy: [
          kind === 'exited'
            ? 'This is the shape of a confined or incomplete install: a snap or flatpak build that cannot write its profile, a missing shared library, no display, or a refusal to run as root.'
            : (kind === 'handoff'
              ? 'Another browser process is using this profile but is not answering on a devtools port — close the plugin\'s browser window (or any browser opened with this profile) and retry.'
              : 'Something is holding the devtools port, or the browser started but is stuck. Try a fixed debugPort, or set headless: true.'),
          'Set browserPath to a different browser to work around it.',
        ].join('\n'),
      })
    }
  }

  /**
   * The failure value for "no browser, and we are not getting one".
   *
   * @param discovery - the last discovery result.
   * @returns the error to throw.
   */
  unavailable(discovery) {
    if (this.provision === 'declined') {
      return new BrowserUnavailableError(
        'this plugin is switched off: no Chromium-family browser was found, and the offer to download one was declined.',
        {
          kind: 'declined',
          remedy: [
            `Install any Chromium-family browser and it will be picked up automatically, or set browserPath.`,
            `Delete ${this.provisionStateFile()} to be asked again, or set provision: auto to download without asking.`,
          ].join('\n'),
        },
      )
    }
    const failed = this.provision === 'install-failed'
    const message = failed
      ? ['downloading a browser did not work out.', this.provisionDetail, '', missingBrowserMessage(this.config, this.env, this.platform)].join('\n')
      : missingBrowserMessage(this.config, this.env, this.platform)
    return new BrowserUnavailableError(message, {
      kind: failed ? 'install-failed' : 'missing',
      remedy: failed
        ? ['Download it by hand instead, or install a browser with your package manager, then retry.', missingBrowserRemedy(this.env, this.platform)].join('\n')
        : missingBrowserRemedy(this.env, this.platform),
    })
  }

  /**
   * Offer to fetch a browser, and act on the answer.
   *
   * `provision: ask` puts a question in the DSH UI (it cannot be asked at
   * activation: the answerer only routes requests carrying a live agent, which
   * only a tool call has). `auto` downloads without asking, `never` does
   * nothing and lets the caller report the missing browser.
   *
   * @param exec - the tool call context.
   * @returns whether a browser is now available.
   */
  async offerBrowser(exec) {
    if (this.provision === 'declined' || this.config.provision === 'never') return false
    if (this.config.provision === 'auto') return await this.install(exec)
    const ask = this.seams.ask
    if (typeof ask !== 'function') {
      this.provisionDetail = 'no user-questions answerer is available in this deployment'
      return false
    }
    let answer
    try {
      answer = await ask({ questions: [browserQuestion()], agent: exec?.agent, signal: exec?.signal })
    } catch (error) {
      // `NO_PROVIDER` on a headless deployment, `ASK_CANCELLED` when the card is
      // closed: both mean "not now", and neither is worth remembering.
      this.provisionDetail = messageOf(error)
      return false
    }
    const selected = Array.isArray(answer?.answers) ? answer.answers[0]?.selected : undefined
    const chosen = Array.isArray(selected) ? selected : []
    if (chosen.includes(DOWNLOAD_ANSWER)) return await this.install(exec)
    if (chosen.includes(DECLINE_ANSWER)) {
      this.provision = 'declined'
      this.provisionDetail = 'the user declined the download'
      await this.rememberDecline(true)
      return false
    }
    this.provisionDetail = 'the download question was dismissed'
    return false
  }

  /**
   * Download and unpack a browser, then report whether it worked.
   *
   * @param exec - the tool call context, for cancellation.
   * @returns whether discovery now finds a browser.
   */
  async install(exec) {
    const stateDir = stateDirectory(this.env)
    const run = this.seams.install ?? installChromeForTesting
    this.provision = 'installing'
    this.provisionDetail = 'downloading a browser'
    try {
      await mkdir(stateDir, { recursive: true })
      const result = await run({
        stateDir,
        platform: this.platform,
        arch: this.arch,
        signal: exec?.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        log: (message) => this.seams.log?.(`browser panel: ${message}`),
      })
      const version = result !== null && typeof result === 'object' && typeof result.version === 'string' ? result.version : ''
      this.provisionDetail = `installed Chrome for Testing ${version}`.trim()
      const found = this.probe(true).found.length > 0
      this.provision = found ? 'ok' : 'install-failed'
      if (!found) this.provisionDetail = `${this.provisionDetail}, but discovery still cannot find it`
      return found
    } catch (error) {
      this.provision = 'install-failed'
      this.provisionDetail = messageOf(error)
      return false
    }
  }

  /**
   * Wait for a devtools endpoint to answer for this profile.
   *
   * Deliberately keyed on the endpoint, not on the process: Edge 155's launcher
   * starts the real browser and exits 0, so "the process I spawned has gone" is
   * not the same as "the browser never started". Two consequences shape this:
   *
   *   - a clean exit keeps the wait going, because the browser may be up;
   *   - the port comes from the browser's own `DevToolsActivePort`, so a browser
   *     that picked its own port is found just as well as a fixed one.
   *
   * @param profileDirectory - the profile the browser was told to use.
   * @param plannedPort - the port we asked for, or 0 when the browser picks one.
   * @param budgetMs - how long to wait at most.
   * @throws {BrowserUnavailableError} `exited`, `handoff` or `silent`.
   */
  async waitForDevTools(profileDirectory, plannedPort, budgetMs = DEVTOOLS_BOOT_MS) {
    const deadline = Date.now() + budgetMs
    let lastProbe = ''
    let handedOff = false
    while (Date.now() < deadline) {
      const recorded = await this.readActivePort(profileDirectory, 800)
      const candidate = recorded !== 0 ? recorded : plannedPort
      if (candidate !== 0) {
        try {
          const version = await this.devTools('/json/version', candidate)
          this.port = candidate
          this.version = version !== null && typeof version === 'object' && typeof version.Browser === 'string' ? version.Browser : ''
          return
        } catch (error) {
          lastProbe = messageOf(error)
        }
      }
      if (this.child === null) {
        if (this.exitCodeSeen !== undefined && this.exitCodeSeen !== 0) {
          throw new BrowserUnavailableError(this.lastError === '' ? `the browser exited with code ${this.exitCodeSeen}` : this.lastError, { kind: 'exited' })
        }
        // Exit code 0: the launcher handed the run to the real browser process.
        handedOff = true
      }
      await sleep(POLL_MS)
    }
    if (handedOff) {
      throw new BrowserUnavailableError([
        `the browser launcher handed the run to another process, but no devtools endpoint answered within ${budgetMs} ms.`,
        'A browser is probably already using this profile without a debugging port (for example one opened by hand).',
        lastProbe === '' ? '' : `Last probe: ${lastProbe}`,
      ].filter((line) => line !== '').join('\n'), { kind: 'handoff' })
    }
    throw new BrowserUnavailableError(`the browser did not publish a devtools endpoint within ${budgetMs} ms (${this.browserPath}, port ${plannedPort}). Last probe: ${lastProbe}`, { kind: 'silent' })
  }

  /**
   * Call one HTTP endpoint of the devtools front end.
   *
   * @param pathname - `/json/version`, `/json/list`, ...
   * @param port - the devtools port; defaults to the one in use.
   * @returns the parsed JSON body.
   */
  async devTools(pathname, port = this.port) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
    if (!response.ok) throw new Error(`the devtools endpoint answered ${response.status} for ${pathname}`)
    return await response.json()
  }

  /**
   * The browser-scoped CDP connection, used for `Target.*`.
   *
   * @returns a connected browser client.
   */
  async browserEndpoint() {
    if (this.browserClient !== undefined && !this.browserClient.closed) return this.browserClient
    const version = await this.devTools('/json/version')
    const url = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : ''
    if (url === '') throw new Error('the browser reported no browser-level devtools websocket')
    this.browserClient = await CdpClient.connect(url, { timeoutMs: this.config.actionTimeoutMs })
    return this.browserClient
  }

  /**
   * List the browser's open pages.
   *
   * @returns devtools target records that can host a page session.
   */
  async pageTargets() {
    const list = await this.devTools('/json/list')
    if (!Array.isArray(list)) return []
    return list.filter((target) => target !== null && typeof target === 'object'
      && target.type === 'page'
      && typeof target.webSocketDebuggerUrl === 'string'
      && target.webSocketDebuggerUrl !== '')
  }

  /**
   * Open a fresh tab.
   *
   * @returns the new target's record.
   */
  async createTab() {
    const browser = await this.browserEndpoint()
    const created = await browser.send('Target.createTarget', { url: 'about:blank' }, this.config.actionTimeoutMs)
    const targetId = created !== null && typeof created === 'object' && typeof created.targetId === 'string' ? created.targetId : ''
    if (targetId === '') throw new Error('the browser did not report the tab it created')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const found = (await this.pageTargets()).find((target) => target.id === targetId)
      if (found !== undefined) return found
      await sleep(POLL_MS)
    }
    throw new Error('the browser opened a tab but never listed it')
  }

  /**
   * Connect to one existing target.
   *
   * @param targetId - devtools target id.
   * @returns a page client with the Page domain enabled.
   */
  async attach(targetId) {
    const target = (await this.pageTargets()).find((candidate) => candidate.id === targetId)
    if (target === undefined) throw new Error('that tab is no longer open')
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, { timeoutMs: this.config.actionTimeoutMs })
    await client.send('Page.enable', {}, 10000)
    await this.installOwnership(client)
    return client
  }

  /**
   * Teach one tab to mark itself as the AI's, now and after every navigation.
   *
   * Registration is per CDP session and dies with it, so a re-attached tab gets
   * exactly one registration and no duplicate badges.
   *
   * @param client - the tab's client.
   */
  async installOwnership(client) {
    if (this.config.ownership === 'off') return
    const source = buildOwnershipScript({ mode: this.config.ownership, brand: this.config.windowName })
    try {
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, 5000)
    } catch {
      /* the badge is cosmetic: it must never stop an action */
    }
    // Registering only covers documents that have not loaded yet. The document
    // in front of us needs the same source run once now — a tab that is already
    // on about:blank may never load another document at all. The script returns
    // early if it has already run, so this cannot double-paint.
    try {
      await client.send('Runtime.evaluate', { expression: source, returnByValue: true }, 5000)
    } catch {
      /* ditto */
    }
    await this.paint(client, 'idle', '', '')
  }

  /**
   * Push the ownership state into one tab, best effort.
   *
   * Never throws and never waits long: a page with a modal dialog can hold a
   * `Runtime.evaluate` open, and the badge is not worth a stalled tool call.
   *
   * @param client - the tab's client.
   * @param state - `'busy'` or `'idle'`.
   * @param label - what the AI is doing.
   * @param owner - who owns this page.
   */
  async paint(client, state, label, owner) {
    if (this.config.ownership === 'off' || client === undefined || client.closed) return
    try {
      await client.send('Runtime.evaluate', {
        expression: ownershipExpression(state, label, owner),
        returnByValue: true,
      }, 1500)
    } catch {
      /* a badge that cannot be painted is not a failed action */
    }
  }

  /**
   * Open the marker tab: the one page in this window that explains itself.
   *
   * Created once per browser process. If the user closes it, it stays closed —
   * re-opening a tab someone deliberately dismissed is worse than losing the
   * hint, and the window title still says whose window it is.
   */
  async ensureMarker() {
    if (this.config.ownership === 'off' || !this.config.markerTab || this.marker !== undefined) return
    const targets = await this.pageTargets()
    // An adopted browser already has the marker tab from the session that
    // started it; marking that one keeps the strip from growing a copy.
    const existing = targets.find((target) => target.url.endsWith(MARKER_HASH))
    if (existing !== undefined) {
      this.marker = { targetId: existing.id, client: await this.attach(existing.id) }
      await this.paint(this.marker.client, 'idle', '', '')
      return
    }
    const startup = targets.find((target) => target.url === '' || target.url === 'about:blank' || target.url === this.config.startUrl)
    const target = startup ?? await this.createTab()
    const client = await this.attach(target.id)
    try {
      await client.send('Page.navigate', { url: `about:blank${MARKER_HASH}` }, this.config.actionTimeoutMs)
    } catch {
      /* the tab still marks the window even if its card never renders */
    }
    // The startup tab is already `about:blank`, so adding the fragment is a
    // same-document navigation: no new document, no injected script, and the
    // badge painted above would stay. Repaint now that the hash identifies this
    // tab as the marker.
    await this.paint(client, 'idle', '', '')
    this.marker = { targetId: target.id, client }
  }

  /**
   * Run one action with the badge lit on the tab it uses.
   *
   * The badge is lit again in `finally`, which is also what puts the state back
   * on the *new* document after an action that navigated.
   *
   * @param agentId - the session asking.
   * @param label - what to show on the badge while it runs.
   * @param body - the action, handed the tab's client.
   * @returns whatever the action returns.
   */
  async withOwnership(agentId, label, body) {
    const owner = this.labelOfAgent(agentId)
    const client = await this.tabFor(agentId)
    await this.paint(client, 'busy', label, owner)
    await this.paint(this.marker?.client, 'busy', label, owner)
    try {
      return await body(client)
    } finally {
      await this.paint(client, 'idle', '', owner)
      await this.paint(this.marker?.client, 'idle', '', owner)
    }
  }

  /**
   * Bind one target to one agent, replacing any tab it owned before.
   *
   * @param agentId - the session asking.
   * @param target - devtools target record.
   * @returns the bound page client.
   */
  async bindTab(agentId, target) {
    const previous = this.tabs.get(agentId)
    if (previous !== undefined) previous.client.close()
    const client = await this.attach(target.id)
    this.tabs.set(agentId, { targetId: target.id, client })
    return client
  }

  /**
   * Remember who is asking, and under which label, on every tool call.
   *
   * The label is resolved once per call (a name can become available only after
   * a teammate joins), and kept for the lifetime of the controller so a page can
   * still say whose it was after that agent is gone.
   *
   * @param agent - the agent object a tool execution carries.
   * @returns its id, or '' when the execution carries no agent.
   */
  noteAgent(agent) {
    const id = typeof agent?.id === 'string' ? agent.id : ''
    if (id === '') return ''
    this.liveAgents.add(id)
    let label = ''
    try {
      label = this.seams.labelOf?.(agent) ?? ''
    } catch {
      label = ''
    }
    this.agentLabels.set(id, typeof label === 'string' && label !== '' ? label : agentLabel({ id }))
    return id
  }

  /**
   * @param agentId - the session whose page is in question.
   * @returns the label to show on a page, even after the agent is gone.
   */
  labelOfAgent(agentId) {
    return this.agentLabels.get(agentId) ?? agentLabel({ id: agentId })
  }

  /**
   * @param agentId - the session to check.
   * @returns whether it is still running, as far as this controller can tell.
   */
  isAgentLive(agentId) {
    if (agentId === '') return false
    if (this.liveAgents.has(agentId)) return true
    try {
      return this.seams.isLive?.(agentId) === true
    } catch {
      return false
    }
  }

  /**
   * @param targetId - a devtools target id.
   * @returns the agent that owns it, or '' when no agent does.
   */
  ownerOfTarget(targetId) {
    for (const [agentId, tab] of this.tabs) {
      if (tab.targetId === targetId) return agentId
    }
    return ''
  }

  /**
   * Record that a new agent is alive, so its page cannot be taken from it.
   *
   * @param agentId - the agent that was created.
   */
  markAgentLive(agentId) {
    if (typeof agentId === 'string' && agentId !== '') this.liveAgents.add(agentId)
  }

  /**
   * Record that an agent is gone, without closing the page it owned.
   *
   * The page stays exactly where it is — the user may still be reading it — but
   * its badge now says the owner finished, and another agent may adopt it.
   *
   * @param agentId - the agent that was disposed.
   */
  markAgentDisposed(agentId) {
    this.liveAgents.delete(agentId)
    const tab = this.tabs.get(agentId)
    if (tab === undefined || tab.client.closed) return
    const finished = `${this.labelOfAgent(agentId)}（已结束）`
    void this.paint(tab.client, 'idle', '', finished)
    void this.paint(this.marker?.client, 'idle', '', finished)
  }

  /**
   * Find a tab a new session may take over, or open one.
   *
   * Only a blank tab is ever adopted, so a tab the user opened for themselves is
   * never hijacked mid-read.
   *
   * @returns the target to use, and whether it was adopted rather than created.
   */
  async claimTarget() {
    const claimed = new Set([...this.tabs.values()].map((tab) => tab.targetId))
    if (this.marker !== undefined) claimed.add(this.marker.targetId)
    const blank = (await this.pageTargets()).find((target) => !claimed.has(target.id)
      && (target.url === '' || target.url === 'about:blank' || target.url === this.config.startUrl))
    if (blank !== undefined) return { target: blank, adopted: true }
    return { target: await this.createTab(), adopted: false }
  }

  /**
   * The page client bound to one agent.
   *
   * @param agentId - the session asking.
   * @returns its CDP client.
   * @throws with advice the model can act on when there is no usable tab.
   */
  async tabFor(agentId) {
    if (!this.running) {
      this.tabs.delete(agentId)
      const why = this.lastError === '' ? '' : ` (${this.lastError})`
      throw new Error(`the browser window is not open${why}; call browser_panel_open to open it`)
    }
    const bound = this.tabs.get(agentId)
    if (bound === undefined) throw new Error('no browser tab is bound to this session yet; call browser_panel_open first')
    if (bound.client.closed) {
      this.tabs.delete(agentId)
      throw new Error('the tab this session owned was closed; call browser_panel_open again')
    }
    return bound.client
  }

  /**
   * Evaluate one expression in the page's main frame.
   *
   * @param client - the tab's client.
   * @param expression - the expression to run.
   * @param timeoutMs - per-call budget.
   * @returns the JSON value, or null when the result is not serializable.
   */
  async evaluate(client, expression, timeoutMs) {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs ?? this.config.actionTimeoutMs)
    if (response !== null && typeof response === 'object' && response.exceptionDetails !== undefined) {
      throw new Error(describeException(response.exceptionDetails))
    }
    if (response === null || typeof response !== 'object') return null
    const result = response.result
    if (result === null || typeof result !== 'object' || result.value === undefined) return null
    return result.value
  }

  /**
   * Read where the tab currently is.
   *
   * @param client - the tab's client.
   * @returns url, title and readyState.
   */
  async readState(client) {
    const value = await this.evaluate(client, '({ url: location.href, title: document.title, ready: document.readyState })', 10000)
    const state = value !== null && typeof value === 'object' ? value : {}
    return { url: asText(state.url, 2000), title: asText(state.title, 500), ready: asText(state.ready, 40) }
  }

  /**
   * Navigate a tab and wait for it to settle.
   *
   * @param client - the tab's client.
   * @param address - absolute URL to load.
   * @returns the resulting page state.
   */
  async loadUrl(client, address) {
    const budget = this.config.actionTimeoutMs
    const before = await this.readState(client)
    const navigation = await client.send('Page.navigate', { url: address }, budget)
    const errorText = navigation !== null && typeof navigation === 'object' && typeof navigation.errorText === 'string' ? navigation.errorText : ''
    if (errorText !== '') throw new Error(`the browser could not load ${address}: ${errorText}`)
    return await this.settleAfter(client, before.url, Math.min(budget, LOAD_WAIT_CAP_MS))
  }

  /**
   * Wait for a navigation to land, without trusting any single signal.
   *
   * A load event is the usual answer, but a history navigation served from the
   * back/forward cache fires none, and a same-document navigation only changes
   * the URL. Waiting on either one, bounded, covers both without stalling.
   *
   * @param client - the tab's client.
   * @param previousUrl - the URL the tab was on before the navigation started.
   * @param budgetMs - how long to wait at most.
   * @returns the page state afterwards.
   */
  async settleAfter(client, previousUrl, budgetMs) {
    const loaded = client.waitForEvent('Page.loadEventFired', budgetMs)
    const changed = (async () => {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        const state = await this.readState(client)
        if (state.url !== previousUrl) return
        await sleep(50)
      }
    })()
    await Promise.race([loaded, changed])
    return await this.readState(client)
  }

  /**
   * Bring the tab on screen before sending it real input.
   *
   * Chromium drops synthesized key and mouse events aimed at a tab that is not
   * frontmost, so a session whose tab was pushed into the background by another
   * session would otherwise click and type into nothing.
   *
   * @param client - the tab's client.
   */
  async focusTab(client) {
    try {
      await client.send('Page.bringToFront', {}, 5000)
    } catch {
      /* a tab that refuses to come forward should still receive the input */
    }
  }

  /**
   * Give an input that may navigate a moment to commit before the next call.
   *
   * A click on a link, Enter in a form, and Space on a button all navigate or
   * mutate the page asynchronously. Reading the page immediately afterwards
   * would race that; this waits for the change, and gives up quickly when there
   * was nothing to wait for.
   *
   * @param client - the tab's client.
   * @param previousUrl - the URL before the input was delivered.
   */
  async settleShortly(client, previousUrl) {
    await Promise.race([
      this.settleAfter(client, previousUrl, CLICK_SETTLE_MS + 2000),
      sleep(CLICK_SETTLE_MS),
    ])
  }

  /**
   * Dispatch one key press described by {@link keyDescriptor}.
   *
   * @param client - the tab's client.
   * @param descriptor - the key's Chromium descriptor.
   * @param budget - per-command timeout.
   */
  async sendKey(client, descriptor, budget) {
    const base = {
      key: descriptor.key,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    }
    if (descriptor.code !== '') base.code = descriptor.code
    if (descriptor.text !== '') {
      await client.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: descriptor.text, unmodifiedText: descriptor.text }, budget)
    } else {
      await client.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, budget)
    }
    await client.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, budget)
  }

  /**
   * The `browser_panel_open` action: every agent ends up owning one page.
   *
   * Three shapes, in order:
   *
   *   1. `adopt` — take over a page whose agent has finished. The caller's
   *      previous page, if any, is released rather than closed.
   *   2. the caller already owns a live page — navigate it. A second
   *      `browser_panel_open` never becomes a second tab, which is the whole
   *      point: abandoned tabs were the cost of the old default.
   *   3. the caller owns nothing — adopt the browser's blank startup tab, or
   *      create exactly one.
   *
   * @param agentId - the session asking.
   * @param options - `{ url, adopt }`; at least one is required.
   * @returns the canonical open value.
   */
  async open(agentId, options, exec) {
    const requested = typeof options.url === 'string' ? options.url : ''
    const adoptId = typeof options.adopt === 'string' ? options.adopt : ''
    if (requested === '' && adoptId === '') throw new Error('pass url, adopt, or both')
    const address = requested === '' ? '' : resolveUrl(requested, this.config.allowOrigins)
    await this.ensureBrowser(exec)
    // The marker tab goes in first so it is the leftmost thing in the strip.
    await this.ensureMarker()
    const owner = this.labelOfAgent(agentId)
    const bound = this.tabs.get(agentId)
    const boundLive = bound !== undefined && !bound.client.closed

    if (adoptId !== '') {
      const targets = await this.pageTargets()
      const target = targets.find((candidate) => candidate.id === adoptId)
      if (target === undefined) {
        throw new Error(`no open page has target id "${adoptId}"; call browser_panel_status for the ids that exist now`)
      }
      if (this.marker !== undefined && this.marker.targetId === adoptId) {
        throw new Error('the AI marker tab belongs to the window, not to an agent; it cannot be adopted')
      }
      const previousOwner = this.ownerOfTarget(adoptId)
      if (previousOwner !== '' && previousOwner !== agentId && this.isAgentLive(previousOwner)) {
        throw new Error(`that page is still owned by an active agent (${this.labelOfAgent(previousOwner)}); only a page whose agent has finished can be adopted`)
      }
      let released = ''
      if (boundLive && bound.targetId !== adoptId) {
        released = bound.targetId
        this.tabs.delete(agentId)
        bound.client.close()
      }
      if (previousOwner !== '' && previousOwner !== agentId) {
        const stale = this.tabs.get(previousOwner)
        if (stale !== undefined) {
          this.tabs.delete(previousOwner)
          stale.client.close()
        }
      }
      const client = await this.bindTab(agentId, target)
      await this.paint(client, 'busy', OPERATION_LABELS.open, owner)
      await this.paint(this.marker?.client, 'busy', OPERATION_LABELS.open, owner)
      const state = address === '' ? await this.readState(client) : await this.loadUrl(client, address)
      await this.paint(client, 'idle', '', owner)
      await this.paint(this.marker?.client, 'idle', '', owner)
      return this.openValue({
        requested,
        reuse: true,
        state,
        owner,
        adoptedFrom: previousOwner === '' ? '' : this.labelOfAgent(previousOwner),
        released,
        note: previousOwner === ''
          ? 'adopted a page no agent owned'
          : `took over the page ${this.labelOfAgent(previousOwner)} left behind`,
      })
    }

    if (boundLive) {
      await this.paint(bound.client, 'busy', OPERATION_LABELS.open, owner)
      await this.paint(this.marker?.client, 'busy', OPERATION_LABELS.open, owner)
      const state = await this.loadUrl(bound.client, address)
      await this.paint(bound.client, 'idle', '', owner)
      await this.paint(this.marker?.client, 'idle', '', owner)
      return this.openValue({
        requested,
        reuse: true,
        state,
        owner,
        adoptedFrom: '',
        released: '',
        note: 'navigated the page this agent already owns (one page per agent)',
      })
    }

    const { target, adopted } = await this.claimTarget()
    const client = await this.bindTab(agentId, target)
    await this.paint(client, 'busy', OPERATION_LABELS.open, owner)
    await this.paint(this.marker?.client, 'busy', OPERATION_LABELS.open, owner)
    const state = await this.loadUrl(client, address)
    await this.paint(client, 'idle', '', owner)
    await this.paint(this.marker?.client, 'idle', '', owner)
    return this.openValue({
      requested,
      reuse: false,
      state,
      owner,
      adoptedFrom: '',
      released: '',
      note: adopted ? 'adopted the blank tab the browser opened on startup' : 'opened a new tab in the browser window',
    })
  }

  /**
   * Assemble the canonical open value from a page state.
   *
   * @param input - requested address, reuse flag, page state, owner, adoption
   *   details, note.
   * @returns the value `browser_panel_open` declares.
   */
  openValue(input) {
    return {
      requested: input.requested,
      reuse: input.reuse,
      url: input.state.url,
      title: input.state.title,
      browser: this.version,
      visible: this.running && !this.config.headless,
      owner: input.owner,
      adoptedFrom: input.adoptedFrom,
      released: input.released,
      note: input.note,
    }
  }

  /**
   * The `browser_panel_snapshot` action.
   *
   * @param agentId - the session asking.
   * @param maxChars - cap on the returned page text.
   * @returns the canonical snapshot value.
   */
  async snapshot(agentId, maxChars) {
    return await this.withOwnership(agentId, OPERATION_LABELS.snapshot, async (client) => {
      const raw = await this.evaluate(client, buildSnapshotExpression(maxChars))
      const page = raw !== null && typeof raw === 'object' ? raw : {}
      const outline = Array.isArray(page.outline) ? page.outline : []
      return {
        url: asText(page.url, 2000),
        title: asText(page.title, 500),
        text: asText(page.text, 200000),
        truncated: page.truncated === true,
        outline: outline.slice(0, OUTLINE_LIMIT).map((item) => ({
          ref: asText(item?.ref, 2000),
          tag: asText(item?.tag, 40),
          type: asText(item?.type, 40),
          href: asText(item?.href, 2000),
          disabled: item?.disabled === true,
          text: asText(item?.text, 200),
        })),
      }
    })
  }

  /**
   * The `browser_panel_click` action.
   *
   * The click is real synthesized mouse input at the element's centre, not a
   * scripted `element.click()`, so it goes through the same hit testing and
   * default actions a user's click would.
   *
   * @param agentId - the session asking.
   * @param options - `{ selector, text, index }`.
   * @returns the canonical click value.
   */
  async click(agentId, options) {
    return await this.withOwnership(agentId, OPERATION_LABELS.click, async (client) => {
      const budget = this.config.actionTimeoutMs
      await this.focusTab(client)
      const before = await this.readState(client)
      const resolved = await this.evaluate(client, buildClickExpression(options.selector, options.text, options.index))
      if (resolved === null || typeof resolved !== 'object') throw new Error('the page returned nothing for that click')
      if (resolved.matched !== true) {
        return {
          matched: false,
          ref: '',
          label: '',
          reason: asText(resolved.reason, 400) || 'nothing matched',
          url: before.url,
        }
      }
      const x = Number(resolved.x)
      const y = Number(resolved.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('the page reported no usable position for that element')
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, budget)
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, budget)
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, budget)
      await this.settleShortly(client, before.url)
      const state = await this.readState(client)
      return { matched: true, ref: asText(resolved.ref, 2000), label: asText(resolved.label, 200), reason: '', url: state.url }
    })
  }

  /**
   * The `browser_panel_type` action.
   *
   * @param agentId - the session asking.
   * @param options - `{ selector, text, clear, submit }`.
   * @returns the canonical type value.
   */
  async typeText(agentId, options) {
    return await this.withOwnership(agentId, OPERATION_LABELS.type, async (client) => {
      const budget = this.config.actionTimeoutMs
      await this.focusTab(client)
      const focus = await this.evaluate(client, buildFocusExpression(options.selector, true))
      const focused = focus !== null && typeof focus === 'object' ? focus : {}
      if (focused.found !== true) {
        return { typed: false, inserted: 'none', editable: false, submitted: false, value: '', reason: asText(focused.reason, 400) || 'selector matched no element' }
      }
      if (focused.editable !== true) {
        return { typed: false, inserted: 'none', editable: false, submitted: false, value: '', reason: asText(focused.reason, 400) || 'the matched element cannot take text' }
      }
      if (options.clear) {
        // Select-all through real key input, so the insertion below replaces the
        // field's contents through the same path a user's Ctrl+A would.
        const modifier = process.platform === 'darwin' ? 4 : 2
        const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier }
        await client.send('Input.dispatchKeyEvent', { ...selectAll, type: 'rawKeyDown' }, budget)
        await client.send('Input.dispatchKeyEvent', { ...selectAll, type: 'keyUp' }, budget)
      }
      let inserted = 'none'
      if (options.text !== '') {
        await client.send('Input.insertText', { text: options.text }, budget)
        inserted = 'insertText'
      }
      // Read the field back before submitting: after a submit the page may be
      // gone, and the caller asked what this field holds.
      const value = await this.evaluate(client, buildValueExpression(options.selector), 10000)
      let submitted = false
      if (options.submit) {
        const before = await this.readState(client)
        await this.sendKey(client, keyDescriptor('Enter'), budget)
        submitted = true
        await this.settleShortly(client, before.url)
      }
      return {
        typed: inserted !== 'none',
        inserted,
        editable: true,
        submitted,
        value: asText(value, 4000),
        reason: '',
      }
    })
  }

  /**
   * The `browser_panel_press` action.
   *
   * @param agentId - the session asking.
   * @param options - `{ key, selector }`.
   * @returns the canonical press value.
   */
  async press(agentId, options) {
    return await this.withOwnership(agentId, OPERATION_LABELS.press, async (client) => {
      const budget = this.config.actionTimeoutMs
      await this.focusTab(client)
      const selectorChecked = options.selector !== ''
      let focused = false
      if (selectorChecked) {
        const focus = await this.evaluate(client, buildFocusExpression(options.selector, false))
        const result = focus !== null && typeof focus === 'object' ? focus : {}
        if (result.found !== true) {
          return { key: options.key, sent: false, focused: false, selectorChecked, note: asText(result.reason, 400) || 'selector matched no element' }
        }
        focused = true
      }
      const descriptor = keyDescriptor(options.key)
      if (descriptor === null) {
        return {
          key: options.key,
          sent: false,
          focused,
          selectorChecked,
          note: `"${options.key}" is not a key this tool expresses; pass Enter, Tab, Escape, Backspace, Delete, an arrow, PageUp, PageDown, Home, End, Space, or a single character`,
        }
      }
      const before = await this.readState(client)
      await this.sendKey(client, descriptor, budget)
      // Enter and Space run the focused element's default action, which may
      // navigate; every other key in this set only moves focus or the caret.
      if (descriptor.key === 'Enter' || descriptor.key === ' ') await this.settleShortly(client, before.url)
      return { key: options.key, sent: true, focused, selectorChecked, note: '' }
    })
  }

  /**
   * The `browser_panel_navigate` action.
   *
   * @param agentId - the session asking.
   * @param direction - `back`, `forward`, or `reload`.
   * @returns the canonical navigate value.
   */
  async navigate(agentId, direction) {
    return await this.withOwnership(agentId, OPERATION_LABELS.navigate, async (client) => {
      const budget = this.config.actionTimeoutMs
      const waitCap = Math.min(budget, LOAD_WAIT_CAP_MS)
      const before = await this.readState(client)
      if (direction === 'reload') {
        const settled = this.settleAfter(client, before.url, waitCap)
        await client.send('Page.reload', {}, budget)
        const state = await settled
        return { direction, url: state.url, title: state.title, note: '' }
      }
      const history = await client.send('Page.getNavigationHistory', {}, budget)
      const index = history !== null && typeof history === 'object' ? Number(history.currentIndex) : Number.NaN
      const entries = history !== null && typeof history === 'object' && Array.isArray(history.entries) ? history.entries : []
      const wanted = direction === 'back' ? index - 1 : index + 1
      if (!Number.isInteger(index) || wanted < 0 || wanted >= entries.length) {
        return {
          direction,
          url: before.url,
          title: before.title,
          note: `the tab has no ${direction === 'back' ? 'earlier' : 'later'} entry in its history`,
        }
      }
      const settled = this.settleAfter(client, before.url, waitCap)
      await client.send('Page.navigateToHistoryEntry', { entryId: entries[wanted].id }, budget)
      const state = await settled
      return { direction, url: state.url, title: state.title, note: '' }
    })
  }

  /**
   * The `browser_panel_eval` action.
   *
   * @param agentId - the session asking.
   * @param script - an async function body.
   * @returns the canonical eval value.
   */
  async runEval(agentId, script) {
    return await this.withOwnership(agentId, OPERATION_LABELS.eval, async (client) => {
      const value = await this.evaluate(client, `(async () => {\n${script}\n})()`)
      return { value: value ?? null }
    })
  }

  /**
   * The `browser_panel_screenshot` action.
   *
   * Unlike Electron's `capturePage`, CDP captures a page that is not being
   * composited on screen, so this works even while the window is behind others.
   *
   * @param agentId - the session asking.
   * @returns the PNG bytes and their true pixel size.
   */
  async screenshot(agentId) {
    return await this.withOwnership(agentId, OPERATION_LABELS.screenshot, async (client) => {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, this.config.actionTimeoutMs)
      const data = shot !== null && typeof shot === 'object' && typeof shot.data === 'string' ? shot.data : ''
      if (data === '') throw new Error('the browser returned no PNG data')
      const bytes = Buffer.from(data, 'base64')
      const size = pngSize(bytes)
      return { bytes, width: size.width, height: size.height }
    })
  }

  /**
   * The `browser_panel_status` action. Read-only: it never starts the browser.
   *
   * @param agentId - the session asking.
   * @returns the canonical status value.
   */
  async status(agentId) {
    const discovery = this.probe()
    const best = discovery.found[0]
    const plan = this.plan ?? launchPlan({
      browserPath: best?.path ?? '',
      config: this.config,
      port: 0,
      profileDir: this.profileDirectory(),
      env: this.env,
      platform: this.platform,
    })
    const remedy = this.provision === 'declined'
      ? `Install any Chromium-family browser and it will be picked up automatically, or set browserPath; delete ${this.provisionStateFile()} to be asked again.`
      : (best === undefined ? missingBrowserRemedy(this.env, this.platform) : '')
    const value = {
      plugin: PLUGIN,
      version: VERSION,
      running: this.running,
      browser: this.version,
      browserPath: this.browserPath,
      pid: this.child !== null && typeof this.child.pid === 'number' ? this.child.pid : 0,
      debugPort: this.running ? this.port : 0,
      profileDir: this.running ? this.effectiveProfile() : this.profileDirectory(),
      headless: plan.headless,
      headlessReason: plan.headlessReason,
      noSandbox: plan.noSandbox,
      visible: this.running && !plan.headless,
      browserAvailable: best !== undefined,
      browserSource: best?.source ?? '',
      browserFound: discovery.found.slice(0, 8).map((entry) => `${entry.path}  (${entry.source})`),
      browserRemedy: remedy,
      provision: this.provision,
      provisionDetail: this.provisionDetail,
      window: { left: 0, top: 0, width: 0, height: 0 },
      pages: [],
      selected: '',
      marker: '',
      reused: this.adopted,
      windowName: this.config.windowName,
      ownership: this.config.ownership,
      limits: { actionTimeoutMs: this.config.actionTimeoutMs, maxSnapshotChars: this.config.maxSnapshotChars },
      lastError: this.lastError,
    }
    if (!this.running) return value
    const bound = this.tabs.get(agentId)
    value.selected = bound === undefined ? '' : bound.targetId
    value.marker = this.marker === undefined ? '' : this.marker.targetId
    try {
      const ownerByTarget = new Map([...this.tabs.entries()].map(([agentId, tab]) => [tab.targetId, agentId]))
      value.pages = (await this.pageTargets()).map((target) => {
        const ownerId = ownerByTarget.get(target.id) ?? ''
        return {
          targetId: asText(target.id, 100),
          url: asText(target.url, 2000),
          title: asText(target.title, 500),
          selected: target.id === value.selected,
          marker: target.id === value.marker,
          agentBound: ownerId !== '',
          owner: ownerId,
          ownerLabel: ownerId === '' ? '' : this.labelOfAgent(ownerId),
          ownerActive: ownerId !== '' && this.isAgentLive(ownerId),
        }
      })
      if (bound !== undefined && !bound.client.closed) {
        const reported = await bound.client.send('Browser.getWindowForTarget', {}, 5000)
        const box = reported !== null && typeof reported === 'object' && reported.bounds !== null && typeof reported.bounds === 'object' ? reported.bounds : {}
        const number = (candidate) => (Number.isFinite(Number(candidate)) ? Number(candidate) : 0)
        value.window = { left: number(box.left), top: number(box.top), width: number(box.width), height: number(box.height) }
      }
    } catch (error) {
      value.lastError = messageOf(error)
    }
    return value
  }

  /**
   * Forget a browser process that has already died.
   *
   * @param child - the process that exited.
   * @param code - its exit code.
   * @param signal - the signal that killed it, when there was one.
   */
  onExit(child, code, signal) {
    LIVE_BROWSERS.delete(child)
    if (this.child !== child) return
    this.exitCodeSeen = code ?? signal ?? 0
    this.forgetBrowser()
    const how = signal === null || signal === undefined ? `exit code ${code}` : `signal ${signal}`
    this.lastError = `the browser window closed (${how})`
  }

  /** Drop every trace of the browser process and its tabs. */
  forgetBrowser() {
    if (this.child !== null) LIVE_BROWSERS.delete(this.child)
    this.child = null
    this.port = 0
    this.version = ''
    this.adopted = false
    if (this.browserClient !== undefined) this.browserClient.close()
    this.browserClient = undefined
    for (const tab of this.tabs.values()) tab.client.close()
    this.tabs.clear()
    if (this.marker !== undefined) this.marker.client.close()
    this.marker = undefined
  }

  /**
   * Close the browser and every connection this plugin owns.
   *
   * An adopted browser has no child handle to kill, so it is asked to close over
   * its own devtools endpoint instead. That is deliberately fire-and-forget: a
   * disposal path must not be able to hang on a browser that is already gone.
   */
  dispose() {
    const child = this.child
    const adoptedPort = this.adopted ? this.port : 0
    this.forgetBrowser()
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      return
    }
    if (adoptedPort !== 0) void this.closeBrowserOnPort(adoptedPort)
  }

  /**
   * Ask a browser this controller attached to (rather than started) to close.
   *
   * @param port - its devtools port.
   */
  async closeBrowserOnPort(port) {
    try {
      const version = await this.devTools('/json/version', port)
      const url = version !== null && typeof version === 'object' && typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : ''
      if (url === '') return
      const client = await CdpClient.connect(url, { timeoutMs: 5000 })
      await client.send('Browser.close', {}, 5000).catch(() => {})
      client.close()
    } catch {
      /* nothing to close, or it closed itself */
    }
  }
}

/** The only rendered shape these tools use: one text content block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Render a compact, model-readable block of key/value lines.
 *
 * @param heading - first line.
 * @param rows - `[label, value]` pairs; empty values are skipped.
 * @returns the formatted text.
 */
function lines(heading, rows) {
  const body = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
  return [heading, ...body].join('\n')
}

/**
 * Declare one tool's canonical output.
 *
 * Two consumers read this declaration, and they read different halves of it:
 * native function calling turns the value into content blocks through `render`,
 * while PTC mode hands the value itself to the sandbox. Program code reads
 * fields, not prose, so the value must be the real structure and the readable
 * form must live in `render` alone.
 *
 * The schema is written as raw JSON Schema in the subset `register` enforces:
 * object root, one scalar `type`, `properties`/`required`/boolean
 * `additionalProperties`, `items`, and annotation-only nodes for unconstrained
 * JSON. No `type` arrays, hence no nullable fields: an absent value is spelled
 * `''`, `0` or `false`, and every declared property is always present so
 * `required` stays exact.
 *
 * @param schema - schema of the canonical JSON value `execute` returns.
 * @param render - turns that value into content blocks.
 * @returns the `output` field of a tool definition.
 */
function output(schema, render) {
  return { schema, render }
}

/**
 * Build the implicit open parameter root the way `defineTool` does.
 *
 * @param properties - per-parameter JSON Schemas.
 * @param required - names that must be present.
 * @returns an object-rooted schema with no openness override.
 */
function params(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/** One outline entry, normalized to non-null scalars. */
const OUTLINE_ITEM = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string' },
    tag: { type: 'string' },
    type: { type: 'string' },
    href: { type: 'string' },
    disabled: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ref', 'tag', 'type', 'href', 'disabled', 'text'],
})

/** One open tab, as `browser_panel_status` reports it. */
const PAGE_ITEM = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    targetId: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    selected: { type: 'boolean', description: 'True for the tab bound to the session that asked.' },
    marker: { type: 'boolean', description: 'True for the tab that tells a human this window is the AI\'s.' },
    agentBound: { type: 'boolean', description: 'True when some agent owns this tab.' },
    owner: { type: 'string', description: 'The agent id that owns this tab; empty when nobody does.' },
    ownerLabel: { type: 'string', description: 'The human-readable owner label shown on the page badge.' },
    ownerActive: { type: 'boolean', description: 'True when the owner is a running agent; false once it has finished.' },
  },
  required: ['targetId', 'url', 'title', 'selected', 'marker', 'agentBound', 'owner', 'ownerLabel', 'ownerActive'],
})

/** Render the canonical status value as the model-facing text. */
function renderStatus(value) {
  const head = lines('Browser window:', [
    ['plugin', `${value.plugin} v${value.version}`],
    ['running', String(value.running)],
    ['browser', value.browser],
    ['path', value.browserPath],
    ['pid', value.pid === 0 ? '' : String(value.pid)],
    ['debug port', value.debugPort === 0 ? '' : String(value.debugPort)],
    ['profile', value.profileDir],
    ['window name', value.windowName],
    ['mode', value.running ? (value.headless ? 'headless (no window on screen)' : 'visible window') : 'not started'],
    ['headless reason', value.headlessReason],
    ['no sandbox', value.noSandbox ? 'yes — running as root, the renderer sandbox is off' : ''],
    ['window', value.window.width === 0 ? '' : `${value.window.width}x${value.window.height} at ${value.window.left},${value.window.top}`],
    ['ownership badge', value.ownership === 'off' ? 'off' : `${value.ownership} (in-page marker on every tab)`],
    ['marker tab', value.marker === '' ? 'none' : value.marker],
    ['reused', value.reused ? 'yes — attached to a browser that was already running for this profile' : ''],
    ['limits', JSON.stringify(value.limits)],
    ['last error', value.lastError],
  ])
  const tabs = value.pages.map((page, index) => {
    const flags = [
      page.selected ? '[selected]' : '',
      page.marker ? '[AI marker]' : '',
      page.ownerLabel === '' ? '' : `[owner: ${page.ownerLabel}${page.ownerActive ? '' : ', finished'}]`,
    ].filter(Boolean).join(' ')
    // The id is printed because `adopt` takes one: a reader that can only see
    // the rendered text would otherwise have no way to name a page.
    return `${index + 1}. ${flags === '' ? '' : `${flags} `}${page.title === '' ? '(untitled)' : page.title} — ${page.url}  (id: ${page.targetId})`
  })
  const adoptable = value.pages.some((page) => page.ownerLabel !== '' && !page.ownerActive && !page.marker)
  const browser = value.browserAvailable
    ? lines('Browser on this machine:', [
      ['available', 'true'],
      ['using', `${value.browserSource}`],
      ...value.browserFound.map((entry, index) => [`found ${index + 1}`, entry]),
    ])
    : [
      'Browser on this machine: none this plugin can drive.',
      `provision: ${value.provision}${value.provisionDetail === '' ? '' : ` (${value.provisionDetail})`}`,
      value.browserRemedy === '' ? '' : `\nWhat to do:\n${value.browserRemedy}`,
    ].join('\n')
  return [
    head,
    '',
    browser,
    '',
    'Tabs:',
    value.running
      ? (tabs.length === 0 ? '(none)' : tabs.join('\n'))
      : 'the browser window is not open; call browser_panel_open to start it',
    '',
    `This session's tab: ${value.selected === '' ? '(none yet)' : value.selected}`,
    adoptable ? 'To continue on a finished agent\'s page, call browser_panel_open with adopt set to that page\'s (id: …).' : '',
  ].join('\n')
}

/** Render the canonical open value as the model-facing text. */
function renderOpen(value) {
  return lines(`Browser window (${value.reuse ? 'reused' : 'opened'}):`, [
    ['requested', value.requested],
    ['url', value.url],
    ['title', value.title],
    ['browser', value.browser],
    ['visible', String(value.visible)],
    ['owner', value.owner],
    ['adopted from', value.adoptedFrom],
    ['released', value.released === '' ? '' : `${value.released} (kept open, no longer yours)`],
    ['note', value.note],
  ])
}

/** Render the canonical snapshot value as the model-facing text. */
function renderSnapshot(value) {
  const rendered = value.outline.map((item, index) => {
    const attributes = [
      item.tag,
      item.type === '' ? undefined : `type=${item.type}`,
      item.href === '' ? undefined : `href=${item.href}`,
    ].filter(Boolean).join(' ')
    return `${index + 1}. ${item.ref}  [${attributes}]  ${item.text === '' ? '(no label)' : item.text}`
  })
  return [
    lines('Page:', [
      ['url', value.url],
      ['title', value.title],
      ['text truncated', String(value.truncated)],
    ]),
    '',
    'Interactive elements (pass ref to browser_panel_click / browser_panel_type):',
    rendered.length === 0 ? '(none found)' : rendered.join('\n'),
    '',
    'Visible text:',
    value.text === '' ? '(unavailable)' : value.text,
  ].join('\n')
}

/** Render the canonical click value as the model-facing text. */
function renderClick(value) {
  const head = lines('Click:', [
    ['matched', String(value.matched)],
    ['ref', value.ref],
    ['label', value.label],
    ['reason', value.reason],
    ['url now', value.url],
  ])
  return value.matched
    ? head
    : `${head}\n\nNothing was clicked. Re-read with browser_panel_snapshot and retry with an exact ref.`
}

/** Render the canonical type value as the model-facing text. */
function renderType(value) {
  return lines('Type:', [
    ['typed', String(value.typed)],
    ['inserted via', value.inserted],
    ['value now', value.value],
    ['submitted', String(value.submitted)],
    ['reason', value.reason],
  ])
}

/** Render the canonical press value as the model-facing text. */
function renderPress(value) {
  return lines('Press:', [
    ['key', value.key],
    ['focused', value.selectorChecked ? String(value.focused) : undefined],
    ['sent', String(value.sent)],
    ['note', value.note],
  ])
}

/** Render the canonical navigate value as the model-facing text. */
function renderNavigate(value) {
  return lines(`Navigate ${value.direction}:`, [
    ['url now', value.url],
    ['title now', value.title],
    ['note', value.note],
  ])
}

/** Render the canonical screenshot value as the model-facing text. */
function renderScreenshot(value) {
  return lines('Screenshot:', [
    ['path', value.path],
    ['bytes', String(value.bytes)],
    ['width', String(value.width)],
    ['height', String(value.height)],
  ]) + '\n\nRead it back with read_image to look at the page.'
}

/** One canonical output per tool. */
const OUTPUTS = {
  status: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      plugin: { type: 'string' },
      version: { type: 'string' },
      running: { type: 'boolean', description: 'Whether this plugin currently owns a live browser process.' },
      browser: { type: 'string', description: "The browser's own version string; '' before it starts." },
      browserPath: { type: 'string' },
      pid: { type: 'number', description: '0 when no browser process is owned.' },
      debugPort: { type: 'number', description: '0 when no browser process is owned.' },
      profileDir: { type: 'string', description: 'The browser profile directory backing this window.' },
      headless: { type: 'boolean' },
      headlessReason: { type: 'string', description: "Why this run is windowless; '' when it is not." },
      noSandbox: { type: 'boolean', description: 'True when --no-sandbox had to be added (running as root on Linux).' },
      visible: { type: 'boolean', description: 'True when the browser runs with a window on screen.' },
      browserAvailable: { type: 'boolean', description: 'Whether this machine has any browser this plugin can drive.' },
      browserSource: { type: 'string', description: "Which discovery layer supplied the chosen browser: 'config', 'environment', 'known-path', 'path' or 'browser-cache'." },
      browserFound: { type: 'array', items: { type: 'string' }, description: 'Every browser found, best first, as "path (source)".' },
      browserRemedy: { type: 'string', description: "What to do when nothing can be driven; '' when a browser is available." },
      provision: { type: 'string', description: "'ok', 'missing', 'declined', 'installing', 'install-failed' or 'unknown'." },
      provisionDetail: { type: 'string', description: 'The last thing that happened around getting a browser.' },
      window: {
        type: 'object',
        additionalProperties: false,
        properties: {
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['left', 'top', 'width', 'height'],
      },
      pages: { type: 'array', items: PAGE_ITEM },
      selected: { type: 'string', description: "The devtools target id bound to this session; '' when none is." },
      marker: { type: 'string', description: "The marker tab's target id; '' when the marker is off or was closed." },
      reused: { type: 'boolean', description: 'True when this controller attached to a browser that was already running for this profile.' },
      windowName: { type: 'string', description: 'The name this browser profile carries, which the OS window title shows.' },
      ownership: { type: 'string', description: "'always', 'operating', or 'off'." },
      limits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          actionTimeoutMs: { type: 'number' },
          maxSnapshotChars: { type: 'number' },
        },
        required: ['actionTimeoutMs', 'maxSnapshotChars'],
      },
      lastError: { type: 'string', description: "Why the browser is missing or misbehaving; '' when nothing is wrong." },
    },
    required: [
      'plugin', 'version', 'running', 'browser', 'browserPath', 'pid', 'debugPort', 'profileDir',
      'headless', 'headlessReason', 'noSandbox', 'visible', 'browserAvailable', 'browserSource',
      'browserFound', 'browserRemedy', 'provision', 'provisionDetail', 'window', 'pages', 'selected',
      'marker', 'reused', 'windowName', 'ownership', 'limits', 'lastError',
    ],
  }, (_args, value) => text(renderStatus(value))),

  open: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      requested: { type: 'string' },
      reuse: { type: 'boolean', description: 'True when an existing page was navigated or adopted instead of a new tab being created.' },
      url: { type: 'string' },
      title: { type: 'string' },
      browser: { type: 'string' },
      visible: { type: 'boolean' },
      owner: { type: 'string', description: 'The owner label now shown on this page for this agent.' },
      adoptedFrom: { type: 'string', description: 'The previous owner label when a page was adopted; empty otherwise.' },
      released: { type: 'string', description: 'Target id of the page this agent released while adopting; it stays open.' },
      note: { type: 'string' },
    },
    required: ['requested', 'reuse', 'url', 'title', 'browser', 'visible', 'owner', 'adoptedFrom', 'released', 'note'],
  }, (_args, value) => text(renderOpen(value))),

  snapshot: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      truncated: { type: 'boolean', description: 'True when the page text was capped at maxChars.' },
      text: { type: 'string' },
      outline: { type: 'array', items: OUTLINE_ITEM },
    },
    required: ['url', 'title', 'truncated', 'text', 'outline'],
  }, (_args, value) => text(renderSnapshot(value))),

  click: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      matched: { type: 'boolean' },
      ref: { type: 'string' },
      label: { type: 'string' },
      reason: { type: 'string', description: "Why nothing matched; '' on success." },
      url: { type: 'string' },
    },
    required: ['matched', 'ref', 'label', 'reason', 'url'],
  }, (_args, value) => text(renderClick(value))),

  type: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      typed: { type: 'boolean' },
      inserted: { type: 'string', description: "Which mechanism inserted the text: 'insertText' or 'none'." },
      editable: { type: 'boolean' },
      submitted: { type: 'boolean' },
      value: { type: 'string', description: "The field's value read back afterwards." },
      reason: { type: 'string', description: "Why nothing was typed; '' on success." },
    },
    required: ['typed', 'inserted', 'editable', 'submitted', 'value', 'reason'],
  }, (_args, value) => text(renderType(value))),

  press: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string' },
      sent: { type: 'boolean' },
      focused: { type: 'boolean', description: 'Whether the focus selector matched; meaningless unless selectorChecked.' },
      selectorChecked: { type: 'boolean', description: 'Whether the call passed a selector to focus first.' },
      note: { type: 'string' },
    },
    required: ['key', 'sent', 'focused', 'selectorChecked', 'note'],
  }, (_args, value) => text(renderPress(value))),

  navigate: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      direction: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['direction', 'url', 'title', 'note'],
  }, (_args, value) => text(renderNavigate(value))),

  eval: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { description: 'The JSON value the snippet returned; any JSON shape.' },
    },
    required: ['value'],
  }, (_args, value) => text(`Page returned:\n${JSON.stringify(value.value, null, 2)}`)),

  screenshot: output({
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      bytes: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    },
    required: ['path', 'bytes', 'width', 'height'],
  }, (_args, value) => text(renderScreenshot(value))),
}

/**
 * Resolve the directory screenshots default into.
 *
 * Tool executions carry no cwd, so the owning session's workspace is read from
 * the `sessions` service when it is present, falling back to the host process
 * cwd. Both are best-effort: a caller-supplied absolute path always wins.
 *
 * @param ctx - the host plugin context.
 * @param exec - the tool run context.
 * @returns an absolute directory path.
 */
function workspaceRoot(ctx, exec) {
  try {
    const sessions = ctx.get('sessions')
    const cwd = sessions?.get?.(exec?.agent?.id)?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    /* fall through to the process cwd */
  }
  return process.cwd()
}

/**
 * Build every model-facing browser tool definition.
 *
 * @param ctx - the plugin context (used to resolve the session workspace).
 * @param service - the live browser controller.
 * @returns the registry-ready definitions, in registration order.
 */
function buildToolDefinitions(ctx, service) {
  const timeoutMs = service.config.actionTimeoutMs + 5000
  // Every call also remembers who is asking: the controller needs the owner
  // label to paint on the page, and to tell a finished agent's page from a live
  // one's when an adopt request arrives.
  const agentOf = (exec) => {
    if (typeof service.noteAgent === 'function') return service.noteAgent(exec?.agent)
    return typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
  }
  const definitions = []
  const register = (definition) => {
    definitions.push(definition)
  }

  register({
    name: 'browser_panel_status',
    description: "Report the state of the browser window this plugin owns: whether it is running, which browser binary and profile back it, its window rectangle, the name that marks it as the AI's in the OS window title, and every open tab (including the AI marker tab) with the agent that owns it and whether that owner is still running. Read-only — it never starts the browser. Call this first when browser automation fails, and to find the targetId to adopt.",
    parameters: params({}),
    output: OUTPUTS.status,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return await service.status(agentOf(exec))
    },
  })

  register({
    name: 'browser_panel_open',
    description: "Open a URL in the plugin's own browser window (a real Chromium window driven over the DevTools Protocol), starting that browser if it is not running. The window is marked as AI-owned: its OS title carries this plugin's window name, the first tab explains what it is, and every page shows a small badge naming its owner. Each agent owns at most one page: calling open again navigates the page you already own and never creates a second tab. Pages stay open after their agent finishes, so the user can inspect the result; to continue on such a page, pass adopt=<targetId from browser_panel_status> (url is optional then). Accepts HTTP(S) addresses; a bare host is upgraded to HTTPS.",
    parameters: params({
      url: { type: 'string', description: 'HTTP(S) address to load. Optional when adopt is given; without it the adopted page keeps its current address.' },
      adopt: { type: 'string', description: 'Target id of a page whose agent has finished. That page becomes yours; any page you owned before is released, not closed.' },
    }),
    output: OUTPUTS.open,
    timeoutMs: timeoutMs + 20000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const url = String(args?.url ?? '').trim()
      const adopt = String(args?.adopt ?? '').trim()
      if (url === '' && adopt === '') throw new Error('pass url, adopt, or both')
      return await service.open(agentOf(exec), { url, adopt }, exec)
    },
  })

  register({
    name: 'browser_panel_snapshot',
    description: 'Read the page this session\'s browser tab is showing: address, title, visible text, and an outline of clickable/typable elements with stable CSS refs for browser_panel_click and browser_panel_type.',
    parameters: params({
      maxChars: { type: 'number', description: 'Cap on returned page text. Defaults to the plugin config.' },
    }),
    output: OUTPUTS.snapshot,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const maxChars = clampInt(args?.maxChars, service.config.maxSnapshotChars, 500, 200000)
      return await service.snapshot(agentOf(exec), maxChars)
    },
  })

  register({
    name: 'browser_panel_click',
    description: 'Click an element in the browser window, by CSS selector (ref from browser_panel_snapshot) or by visible label text. Label matching looks at anchors, buttons and ARIA roles first, then at any visible element whose label matches exactly — which is how controls built from a plain div with an onclick handler are reached. The click is real synthesized mouse input at the element\'s centre, so hit testing and default actions behave as they would for a user.',
    parameters: params({
      selector: { type: 'string', description: 'CSS selector of the element to click.' },
      text: { type: 'string', description: 'Visible label text to match when selector is omitted.' },
      index: { type: 'number', description: 'Zero-based match index when several elements match text. Defaults to 0.' },
    }),
    output: OUTPUTS.click,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
      const label = typeof args?.text === 'string' ? args.text.trim() : ''
      if (selector === '' && label === '') throw new Error('pass either selector or text')
      return await service.click(agentOf(exec), {
        selector,
        text: label,
        index: clampInt(args?.index, 0, 0, 500),
      })
    },
  })

  register({
    name: 'browser_panel_type',
    description: 'Focus an input/textarea/contenteditable in the browser window and insert text into it as real keyboard input, optionally replacing the field\'s contents first and submitting with Enter.',
    parameters: params({
      selector: { type: 'string', description: 'CSS selector of the field (ref from browser_panel_snapshot).' },
      text: { type: 'string', description: 'Text to insert.' },
      clear: { type: 'boolean', description: 'Select the current contents first so the text replaces them. Defaults to false.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
    }, ['selector', 'text']),
    output: OUTPUTS.type,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selector = String(args?.selector ?? '').trim()
      if (selector === '') throw new Error('selector is required')
      return await service.typeText(agentOf(exec), {
        selector,
        text: String(args?.text ?? ''),
        clear: args?.clear === true,
        submit: args?.submit === true,
      })
    },
  })

  register({
    name: 'browser_panel_press',
    description: 'Send one real key press to the browser window (Enter, Tab, Escape, an arrow, PageUp/PageDown, Home, End, Backspace, Delete, Space, or a single character). Focus an element first with the optional selector.',
    parameters: params({
      key: { type: 'string', description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown, PageDown, or a single character.' },
      selector: { type: 'string', description: 'Focus this element before pressing.' },
    }, ['key']),
    output: OUTPUTS.press,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = String(args?.key ?? '').trim()
      if (key === '') throw new Error('key is required')
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
      return await service.press(agentOf(exec), { key, selector })
    },
  })

  register({
    name: 'browser_panel_navigate',
    description: "Move this session's browser tab through its own history: back, forward, or reload.",
    parameters: params({
      direction: {
        type: 'string',
        enum: ['back', 'forward', 'reload'],
        description: 'Which history movement to perform.',
      },
    }, ['direction']),
    output: OUTPUTS.navigate,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const direction = String(args?.direction ?? '').trim()
      if (!['back', 'forward', 'reload'].includes(direction)) throw new Error('direction must be back, forward, or reload')
      return await service.navigate(agentOf(exec), direction)
    },
  })

  register({
    name: 'browser_panel_eval',
    description: "Run one snippet as an async function body inside this session's browser tab and return its JSON value. Use it for what the other tools do not cover; the snippet runs in the page's main frame, so it can read anything the page can.",
    parameters: params({
      script: { type: 'string', description: 'The async function body. `return` the value you want back; it must be JSON-serializable.' },
    }, ['script']),
    output: OUTPUTS.eval,
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const script = String(args?.script ?? '')
      if (script.trim() === '') throw new Error('script is required')
      return await service.runEval(agentOf(exec), script)
    },
  })

  register({
    name: 'browser_panel_screenshot',
    description: "Capture this session's browser tab as a PNG and write it to disk, returning the path. Works even when the window is behind others. Read the file back with read_image to actually look at the page.",
    parameters: params({
      path: { type: 'string', description: 'Absolute path, or a path relative to the session workspace. Defaults to .dsh-browser-panel/shot-<timestamp>.png.' },
    }),
    output: OUTPUTS.screenshot,
    timeoutMs: timeoutMs + 15000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const shot = await service.screenshot(agentOf(exec))
      const requested = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : ''
      const target = requested === ''
        ? path.join(workspaceRoot(ctx, exec), SHOT_DIR, `shot-${Date.now()}.png`)
        : path.isAbsolute(requested)
          ? requested
          : path.join(workspaceRoot(ctx, exec), requested)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, shot.bytes)
      return { path: target, bytes: shot.bytes.length, width: shot.width, height: shot.height }
    },
  })
  return definitions
}

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'browser-panel'
/** Services this plugin requires before it is constructed. */
export const inject = ['tools']

/**
 * Resolve the best owner label the running deployment can offer for one agent.
 *
 * Team member names are the only human-readable identity DSH exposes, so they
 * win; a subagent that is not on the roster still gets its delegation depth from
 * the session header, and anything else falls back to the session tag. Every
 * lookup is best effort: attribution must never break a browser action.
 *
 * @param ctx - the plugin context.
 * @param agent - the agent object from a tool execution.
 * @returns a label such as `lead`, `子 agent L1 #b26f74`, or `主会话 #add7af`.
 */
function labelOfAgent(ctx, agent) {
  const details = { id: typeof agent?.id === 'string' ? agent.id : '' }
  try {
    const members = ctx.get('agentTeams')
    const member = members?.membership?.(agent)
    if (member !== undefined && typeof member.name === 'string') details.name = member.name
  } catch {
    /* no team service, or this agent is not on a roster */
  }
  try {
    const header = ctx.get('sessions')?.get?.(details.id)?.header
    if (header !== undefined) {
      details.subagent = header.origin === 'subagent'
      if (typeof header.delegationDepth === 'number') details.delegationDepth = header.delegationDepth
    }
  } catch {
    /* the session registry is optional here too */
  }
  return agentLabel(details)
}

/**
 * Whether an agent is still running, asked of the session registry.
 *
 * @param ctx - the plugin context.
 * @param agentId - the session to check.
 * @returns true when the registry still lists it.
 */
function isAgentLive(ctx, agentId) {
  try {
    return ctx.get('sessions')?.get?.(agentId) !== undefined
  } catch {
    return false
  }
}

/**
 * Mount the browser controller and publish the model-facing tools.
 *
 * Registration is a plain `ctx.tools.register()` rather than a deferred
 * dependency callback: a rejected definition must fail this activation loudly
 * instead of vanishing inside a callback whose error nobody observes.
 *
 * @param ctx - the plugin context.
 * @param config - the Loader row's config mapping.
 */
export function apply(ctx, config) {
  const service = new BrowserWindowController(config, {
    // The DSH answerer routes only requests carrying a live agent, which is why
    // the question is asked from a tool call rather than from activation.
    ask: async (request) => {
      const questions = ctx.get('userQuestions')
      if (questions === undefined || typeof questions.ask !== 'function') {
        throw new Error('no user-questions answerer is available in this deployment')
      }
      return await questions.ask(request)
    },
    log: (message) => {
      try {
        ctx.logger?.('browser-panel')?.info?.(message)
      } catch {
        /* logging is never worth failing over */
      }
    },
    labelOf: (agent) => labelOfAgent(ctx, agent),
    isLive: (agentId) => isAgentLive(ctx, agentId),
  })
  // Detection runs at load, before anything can ask the user for help.
  void service.start().catch(() => {})
  for (const definition of buildToolDefinitions(ctx, service)) {
    ctx.tools.register(definition)
  }
  // The page-ownership rule belongs in the system prompt, not only in tool
  // descriptions the model reads once: it explains why a second `open` does not
  // mint a second tab, and how to take over a page a finished agent left.
  try {
    // `ctx.systemPrompt` is only a property when the service is injected, so
    // fetch it by name like every other optional service. Getting this wrong is
    // silent: the tools keep working while the rule never reaches the prompt.
    let prompt
    try {
      prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    } catch {
      prompt = undefined
    }
    if (prompt === undefined) {
      try {
        prompt = ctx.systemPrompt
      } catch {
        prompt = undefined
      }
    }
    if (prompt !== undefined && typeof prompt.section === 'function') {
      // A renamed order slot must not cost us the whole rule: fall back to the
      // computer-use band rather than skipping the section.
      let order = 3000
      try {
        const resolved = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_COMPUTER_USE') : 0
        if (Number.isFinite(resolved)) order = resolved
      } catch {
        /* keep the numeric fallback */
      }
      const install = () => prompt.section({
        name: 'browser-panel:page-ownership',
        order,
        text: PAGE_OWNERSHIP_PROMPT,
      })
      if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }
  } catch {
    /* a missing prompt hook leaves the tool descriptions in charge */
  }
  if (typeof ctx.on === 'function') {
    // Pages outlive their agents on purpose, so the controller has to be told
    // when an owner stops being live: only then may someone else adopt its page.
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (typeof agent?.id === 'string') service.markAgentLive(agent.id)
      } catch {
        /* lifecycle bookkeeping must never break agent creation */
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      try {
        if (typeof agent?.id === 'string') service.markAgentDisposed(agent.id)
      } catch {
        /* ditto */
      }
    })
    ctx.on('dispose', () => service.dispose())
  }
}

export {
  buildToolDefinitions,
  normalizeConfig,
  CdpClient,
  BrowserWindowController,
  BrowserUnavailableError,
  browserCandidates,
  browserSearchNames,
  browserCacheRoots,
  discoverBrowsers,
  findBrowser,
  launchPlan,
  installChromeForTesting,
  chromeForTestingPlatform,
  extractZip,
  zipEntries,
  crc32,
  downloadFile,
  browserQuestion,
  stateDirectory,
  resolveUrl,
  keyDescriptor,
  pngSize,
  buildSnapshotExpression,
  buildClickExpression,
  buildFocusExpression,
  buildValueExpression,
  buildOwnershipScript,
  ownershipExpression,
  seedProfileName,
  sessionTag,
  agentLabel,
  PAGE_OWNERSHIP_PROMPT,
  VERSION,
  PLUGIN,
  SHOT_DIR,
  MARKER_HASH,
  MARKER_TITLE,
  OWNERSHIP_PILL_ID,
  OWNERSHIP_FRAME_ID,
  OPERATION_LABELS,
  DOWNLOAD_ANSWER,
  DECLINE_ANSWER,
}
