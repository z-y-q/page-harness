import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { BodyCapture, kindOf, NetworkRecorder } from '../src/server/network'
import { createProxy } from '../src/server/proxy'

describe('kindOf', () => {
  it('classifies by content type and path', () => {
    expect(kindOf('application/json; charset=utf-8', '/api/x')).toBe('json')
    expect(kindOf('text/html', '/')).toBe('doc')
    expect(kindOf('text/javascript', '/a.js')).toBe('script')
    expect(kindOf('text/css', '/a.css')).toBe('style')
    expect(kindOf('image/png', '/a.png')).toBe('image')
    expect(kindOf('font/woff2', '/a.woff2')).toBe('font')
    expect(kindOf('text/plain', '/a.txt')).toBe('text')
    expect(kindOf('', '/bundle.js')).toBe('script')
    expect(kindOf('', '/no-extension')).toBe('other')
  })
})

describe('NetworkRecorder', () => {
  it('starts pending entries and finishes them', () => {
    const r = new NetworkRecorder()
    const id = r.start({ method: 'GET', url: '/a', upstream: 'http://t/a', relayed: false, reqHeaders: {} })
    expect(r.get(id)?.status).toBe(0)
    expect(r.list()[0].status).toBe(0)
    r.finish(id, { status: 200, contentType: 'application/json', resHeaders: {}, ms: 5, resBody: '{}', resBytes: 2 })
    const e = r.get(id)!
    expect(e.status).toBe(200)
    expect(e.kind).toBe('json')
    expect(e.ms).toBe(5)
  })

  it('filters by substring and kind, newest first', () => {
    const r = new NetworkRecorder()
    for (const [url, ct] of [
      ['/api/one', 'application/json'],
      ['/static/a.js', 'text/javascript'],
      ['/api/two', 'application/json'],
    ] as const) {
      const id = r.start({ method: 'GET', url, upstream: 'http://t' + url, relayed: false, reqHeaders: {} })
      r.finish(id, { status: 200, contentType: ct, resHeaders: {}, ms: 1, resBytes: 0 })
    }
    expect(r.list({ q: 'api' }).map((e) => e.url)).toEqual(['/api/two', '/api/one'])
    expect(r.list({ kind: 'script' }).map((e) => e.url)).toEqual(['/static/a.js'])
    expect(r.list({ q: 'API' }).length).toBe(2) // case-insensitive
    expect(r.list({ limit: 1 }).length).toBe(1)
  })

  it('ignores unknown kinds and double finishes', () => {
    const r = new NetworkRecorder()
    const id = r.start({ method: 'GET', url: '/', upstream: 'http://t/', relayed: false, reqHeaders: {} })
    r.finish(id, { status: 200, contentType: 'application/json', resHeaders: {}, ms: 1, resBytes: 0 })
    r.finish(id, { status: 500, contentType: 'text/html', resHeaders: {}, ms: 99, resBytes: 0 })
    expect(r.get(id)?.status).toBe(200)
    expect(r.list({ kind: 'nope' }).length).toBe(1)
  })

  it('caps captured bodies', () => {
    const cap = new BodyCapture()
    cap.add(Buffer.alloc(600 * 1024))
    expect(cap.truncated).toBe(true)
    const text = cap.requestText()!
    expect(text.truncated).toBe(true)
    expect(text.text.length).toBeLessThanOrEqual(64 * 1024)
  })
})

// ---- proxy integration ------------------------------------------------------

const servers: Array<() => void> = []
afterEach(() => {
  while (servers.length) servers.pop()?.()
})

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

describe('proxy network capture', () => {
  it('records method, url, status, kind and decoded response body', async () => {
    const target = http.createServer((rq, rs) => {
      rs.setHeader('content-type', 'application/json')
      rs.end(JSON.stringify({ ok: true, path: rq.url }))
    })
    const tPort = await listen(target)
    const rec = new NetworkRecorder()
    const proxy = createProxy({ target: new URL(`http://127.0.0.1:${tPort}`), cookieName: 'ph', controlOrigin: () => 'http://127.0.0.1:1', network: rec })
    const pServer = http.createServer((rq, rs) => proxy.handle(rq, rs))
    const pPort = await listen(pServer)
    servers.push(() => target.close(), () => pServer.close())

    const res = await fetch(`http://127.0.0.1:${pPort}/api/list?page=1`)
    expect(await res.json()).toEqual({ ok: true, path: '/api/list?page=1' })
    const list = rec.list()
    expect(list.length).toBe(1)
    const e = list[0]
    expect(e.method).toBe('GET')
    expect(e.url).toBe('/api/list?page=1')
    expect(e.status).toBe(200)
    expect(e.kind).toBe('json')
    expect(e.resBody).toBe(JSON.stringify({ ok: true, path: '/api/list?page=1' }))
    expect(e.relayed).toBe(false)
    expect(e.upstream).toContain(`/api/list?page=1`)
  })

  it('records request bodies and gzipped responses', async () => {
    const target = http.createServer((rq, rs) => {
      let body = ''
      rq.on('data', (c) => (body += c))
      rq.on('end', () => {
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ echo: body })))
        rs.setHeader('content-type', 'application/json')
        rs.setHeader('content-encoding', 'gzip')
        rs.end(payload)
      })
    })
    const tPort = await listen(target)
    const rec = new NetworkRecorder()
    const proxy = createProxy({ target: new URL(`http://127.0.0.1:${tPort}`), cookieName: 'ph', controlOrigin: () => 'http://127.0.0.1:1', network: rec })
    const pServer = http.createServer((rq, rs) => proxy.handle(rq, rs))
    const pPort = await listen(pServer)
    servers.push(() => target.close(), () => pServer.close())

    const res = await fetch(`http://127.0.0.1:${pPort}/submit`, { method: 'POST', body: 'hello=1' })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const text = await res.text()
    const e = rec.list()[0]
    expect(e.method).toBe('POST')
    expect(e.reqBody).toBe('hello=1')
    expect(e.resBody).toBe(text)
    expect(e.resEncoded).toBeFalsy()
  })

  it('records the upstream error instead of hanging the entry', async () => {
    const tPort = await listen(http.createServer()) // nothing listening after close
    const dead = http.createServer()
    const deadPort = await listen(dead)
    dead.close()
    void tPort
    const rec = new NetworkRecorder()
    const proxy = createProxy({ target: new URL(`http://127.0.0.1:${deadPort}`), cookieName: 'ph', controlOrigin: () => 'http://127.0.0.1:1', network: rec })
    const pServer = http.createServer((rq, rs) => proxy.handle(rq, rs))
    const pPort = await listen(pServer)
    servers.push(() => pServer.close())

    const res = await fetch(`http://127.0.0.1:${pPort}/x`, { headers: { accept: 'text/html' } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const e = rec.list()[0]
    expect(e.status).toBe(0)
    expect(e.resBody).toBeTruthy()
  })
})
