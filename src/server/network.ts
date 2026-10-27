// Ring-buffer capture of the traffic that flows through the app-port reverse proxy,
// so the agent can inspect the user's real browser session (URLs, headers, cookies,
// bodies) through the network_list / network_get MCP tools. In memory only, capped,
// never persisted. Binary bodies are recorded as metadata without content.
import type { IncomingHttpHeaders } from 'node:http'

export type NetKind = 'doc' | 'json' | 'text' | 'script' | 'style' | 'image' | 'font' | 'other'

export interface NetworkEntry {
  id: number
  /** Date.now() when the request reached the proxy. */
  t: number
  method: string
  /** URL as the browser sees it (path + search on the proxy origin). */
  url: string
  /** Effective upstream URL (differs from url on relayed subdomain requests). */
  upstream: string
  relayed: boolean
  /** 0 until the response has been recorded. */
  status: number
  contentType: string
  kind: NetKind
  ms: number
  reqHeaders: Record<string, string>
  resHeaders: Record<string, string>
  reqBody?: string
  reqTruncated?: boolean
  resBody?: string
  resTruncated?: boolean
  /** The body could not be decoded (unknown content-encoding). */
  resEncoded?: boolean
  /** Bytes captured for the response body (compressed bytes when encoded). */
  resBytes: number
}

export interface NetworkStart {
  method: string
  url: string
  upstream: string
  relayed: boolean
  reqHeaders: Record<string, string>
}

export interface NetworkFinish {
  status: number
  contentType: string
  resHeaders: Record<string, string>
  ms: number
  resBody?: string
  resTruncated?: boolean
  resEncoded?: boolean
  resBytes: number
  /** Captured request body, filled in by the proxy when it records the response. */
  reqBody?: string
  reqTruncated?: boolean
}

const MAX_ENTRIES = 400
const MAX_REQ_CHARS = 64 * 1024
export const MAX_RES_CHARS = 160 * 1024
const MAX_CAPTURE_BYTES = 512 * 1024
const MAX_HEADER_CHARS = 4096

const KINDS: readonly string[] = ['doc', 'json', 'text', 'script', 'style', 'image', 'font', 'other']
const TEXTUAL: readonly NetKind[] = ['doc', 'json', 'text', 'script', 'style']

export function kindOf(contentType: string, url: string): NetKind {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  if (ct.endsWith('json')) return 'json'
  if (ct.includes('html')) return 'doc'
  if (ct.includes('css')) return 'style'
  if (/javascript|ecmascript/.test(ct)) return 'script'
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('font/') || ct.includes('woff')) return 'font'
  if (ct.startsWith('text/')) return 'text'
  const p = url.split('?')[0].toLowerCase()
  if (p.endsWith('.json') || p.endsWith('.map')) return 'json'
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'script'
  if (p.endsWith('.css')) return 'style'
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'doc'
  return 'other'
}

export function isNetKind(s: string): s is NetKind {
  return KINDS.includes(s)
}

export function isTextualKind(k: NetKind): boolean {
  return TEXTUAL.includes(k)
}

/** Only textual kinds get their body stored; images/fonts/media stay metadata-only. */
export function storeBody(kind: NetKind): boolean {
  return isTextualKind(kind)
}

export function capText(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max), truncated: true }
}

/** Flattens request/response headers into plain strings, capping long values. */
export function headerMap(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue
    const s = Array.isArray(v) ? v.join(', ') : String(v)
    out[k] = s.length > MAX_HEADER_CHARS ? s.slice(0, MAX_HEADER_CHARS) + '…' : s
  }
  return out
}

/** Accumulates raw (possibly compressed) bytes up to a cap, then only flags truncation. */
export class BodyCapture {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  add(c: Buffer): void {
    if (this.size + c.length > MAX_CAPTURE_BYTES) {
      this.truncated = true
      return
    }
    this.chunks.push(c)
    this.size += c.length
  }

  get buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }

  get bytes(): number {
    return this.size
  }

  /** Decoded request body (always text: forms, JSON, rarely anything else). */
  requestText(): { text: string; truncated: boolean } | undefined {
    if (!this.chunks.length && !this.truncated) return undefined
    const r = capText(this.buffer.toString('utf8'), MAX_REQ_CHARS)
    return { text: r.text, truncated: r.truncated || this.truncated }
  }

  /** Decoded response body for textual kinds; raw bytes are decompressed by the caller. */
  responseText(buf: Buffer): { text: string; truncated: boolean } {
    const r = capText(buf.toString('utf8'), MAX_RES_CHARS)
    return { text: r.text, truncated: r.truncated || this.truncated }
  }
}

export class NetworkRecorder {
  private entries: NetworkEntry[] = []
  private next = 1

  start(i: NetworkStart): number {
    const id = this.next++
    this.entries.push({
      id,
      t: Date.now(),
      status: 0,
      contentType: '',
      kind: 'other',
      ms: 0,
      resHeaders: {},
      resBytes: 0,
      ...i,
    })
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    return id
  }

  finish(id: number, f: NetworkFinish): void {
    const e = this.get(id)
    if (!e || e.status !== 0) return
    e.kind = kindOf(f.contentType, e.url)
    Object.assign(e, f)
  }

  list(filter: { q?: string; kind?: string; limit?: number } = {}): NetworkEntry[] {
    const q = filter.q?.toLowerCase()
    const kind = filter.kind !== undefined && isNetKind(filter.kind) ? filter.kind : undefined
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200))
    const out: NetworkEntry[] = []
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]
      if (q && !e.url.toLowerCase().includes(q) && !e.upstream.toLowerCase().includes(q)) continue
      if (kind && e.kind !== kind) continue
      out.push(e)
    }
    return out
  }

  total(): number {
    return this.entries.length
  }

  get(id: number): NetworkEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }
}
