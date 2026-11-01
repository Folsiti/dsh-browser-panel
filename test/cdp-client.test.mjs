/**
 * The CDP client: id correlation, error and timeout handling, event routing.
 *
 * The transport is injected, so every failure path a real socket can produce —
 * a protocol error, a silent command, a dropped connection — is exercised
 * without a browser and without a network.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CdpClient } from '../host.js'

/**
 * A WebSocket-shaped fake that records what the client sent.
 *
 * @returns the socket plus a `reply` that feeds the client an inbound frame.
 */
function fakeSocket() {
  const socket = {
    sent: [],
    closed: false,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (socket.closed) throw new Error('socket is closed')
      socket.sent.push(JSON.parse(data))
    },
    close() {
      socket.closed = true
    },
    reply(message) {
      socket.onmessage?.({ data: JSON.stringify(message) })
    },
    replyRaw(data) {
      socket.onmessage?.({ data })
    },
  }
  return socket
}

test('send writes an incrementing id and resolves on the matching reply', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const first = client.send('Page.enable')
  socket.reply({ id: 1, result: { ok: true } })
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Page.enable', params: {} })

  const second = client.send('Runtime.evaluate', { expression: '1' })
  assert.equal(socket.sent[1].id, 2)
  assert.deepEqual(socket.sent[1].params, { expression: '1' })
  socket.reply({ id: 2, result: { result: { value: 1 } } })
  assert.deepEqual(await second, { result: { value: 1 } })
})

test('a protocol error rejects with its own message', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const pending = client.send('Page.navigate', { url: 'x' })
  socket.reply({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } })
  await assert.rejects(pending, /Cannot navigate to invalid URL/)
})

test('a silent command rejects with the method and the budget', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  await assert.rejects(client.send('Page.slow', {}, 150), /did not answer "Page\.slow" within 150 ms/)
  // The timed-out id must not be left behind to swallow a later reply.
  assert.equal(client.pending.size, 0)
})

test('a reply to an unknown id is ignored rather than thrown', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const pending = client.send('Page.enable')
  assert.doesNotThrow(() => socket.reply({ id: 99, result: { stray: true } }))
  assert.doesNotThrow(() => socket.replyRaw('not json at all'))
  assert.doesNotThrow(() => socket.replyRaw('null'))
  assert.doesNotThrow(() => socket.replyRaw('[1,2,3]'))
  socket.reply({ id: 1, result: { ok: true } })
  assert.deepEqual(await pending, { ok: true })
})

test('events reach every listener, and one throwing listener cannot stop the others', () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const seen = []
  client.on('Page.loadEventFired', () => {
    throw new Error('a careless listener')
  })
  client.on('Page.loadEventFired', (params) => seen.push(params))
  assert.doesNotThrow(() => socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 7 } }))
  assert.deepEqual(seen, [{ timestamp: 7 }])
})

test('an unsubscribed listener stops receiving events', () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  let count = 0
  const off = client.on('Page.loadEventFired', () => {
    count += 1
  })
  socket.reply({ method: 'Page.loadEventFired', params: {} })
  off()
  socket.reply({ method: 'Page.loadEventFired', params: {} })
  assert.equal(count, 1)
})

test('waitForEvent resolves on the event and gives up quietly on timeout', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const arriving = client.waitForEvent('Page.loadEventFired', 1000)
  socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 3 } })
  assert.deepEqual(await arriving, { timestamp: 3 })
  assert.equal(await client.waitForEvent('Page.loadEventFired', 120), null)
  assert.equal(client.listeners.size, 0, 'a timed-out wait must not leave its listener behind')
})

test('closing rejects everything in flight and refuses later commands', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const pending = client.send('Page.enable')
  client.close()
  await assert.rejects(pending, /the plugin closed it/)
  assert.equal(socket.closed, true)
  assert.equal(client.closed, true)
  await assert.rejects(client.send('Page.enable'), /the browser connection is closed/)
})

test('a dropped socket fails every waiter with the transport reason', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  const pending = client.send('Page.enable')
  socket.onclose()
  await assert.rejects(pending, /the browser closed the connection/)
  assert.equal(client.closed, true)
  assert.equal(client.pending.size, 0)
})

test('a send that throws synchronously rejects instead of escaping', async () => {
  const socket = fakeSocket()
  const client = new CdpClient(socket, { timeoutMs: 5000 })
  socket.closed = true
  await assert.rejects(client.send('Page.enable'), /socket is closed/)
})

test('connect resolves once the socket opens', async () => {
  const original = globalThis.WebSocket
  const opened = []
  globalThis.WebSocket = class {
    constructor(url) {
      opened.push(url)
      queueMicrotask(() => this.onopen?.())
    }

    send() {}

    close() {}
  }
  try {
    const client = await CdpClient.connect('ws://127.0.0.1:1/devtools/page/X', { timeoutMs: 5000 })
    assert.ok(client instanceof CdpClient)
    assert.deepEqual(opened, ['ws://127.0.0.1:1/devtools/page/X'])
  } finally {
    globalThis.WebSocket = original
  }
})

test('connect rejects when the target refuses the connection', async () => {
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => this.onerror?.())
    }

    send() {}

    close() {}
  }
  try {
    await assert.rejects(CdpClient.connect('ws://127.0.0.1:1/devtools/page/X'), /refused a devtools connection/)
  } finally {
    globalThis.WebSocket = original
  }
})
