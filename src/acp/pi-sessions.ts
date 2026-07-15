import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { getAgentDir, getConfiguredSessionDir } from './pi-settings.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024

export function getPiSessionsDir(cwd = process.cwd()): string {
  const configured = getConfiguredSessionDir(cwd)
  if (configured) return isAbsolute(configured) ? configured : resolve(cwd, configured)
  return join(getAgentDir(), 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

export function readPiSessionHeader(path: string): { sessionId: string; cwd: string } | null {
  const first = readFirstLine(path)
  return first ? parseSessionHeader(first) : null
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function scanSessionInfoNameFromFile(path: string): string | null {
  // Fallback when the session_info entry is older than our tail window.
  // Scan the whole file line-by-line and remember the last session_info.name.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    let leftover = ''
    let offset = 0
    let lastName: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + buf.subarray(0, n).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        const line = line0.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line) as any
          if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
            lastName = obj.name.trim()
          }
        } catch {
          // ignore
        }
      }
    }

    // Best-effort: parse leftover if it was a full line without trailing newline.
    const tailLine = leftover.trim()
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine) as any
        if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
          lastName = obj.name.trim()
        }
      } catch {
        // ignore
      }
    }

    return lastName
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function pickFallbackTitleFromHead(path: string): string | null {
  // Fallback to first user message.
  // NOTE: we keep this simple: read a small head chunk and parse line-by-line.
  try {
    const raw = readFileSync(path, { encoding: 'utf8' })
    const lines = raw.split(/\r?\n/)
    for (const line0 of lines) {
      const line = line0.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as any
        if (obj?.type === 'message' && obj?.message?.role === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') return content.slice(0, 80)
          if (Array.isArray(content)) {
            const t = content.find((c: any) => c?.type === 'text' && typeof c?.text === 'string')
            if (t?.text) return String(t.text).slice(0, 80)
          }
        }
      } catch {
        // ignore
      }

      // Avoid scanning extremely large files fully.
      // If we didn't find a user message in the first ~2000 lines, give up.
      // (Most sessions have it early.)
      if (lines.length > 2000) break
    }
  } catch {
    // ignore
  }

  return null
}

export function listPiSessions(cwd = process.cwd()): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir(cwd)
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    const header = readPiSessionHeader(file)
    if (!header) continue

    let updatedAt: string | null = null

    let title: string | null = null
    try {
      const tail = readTail(file)
      title = pickTitleFromTail(tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    // If the session was named early and grew large, it may fall outside of the tail window.
    if (!title) {
      title = scanSessionInfoNameFromFile(file)
    }

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    if (!title) {
      title = pickFallbackTitleFromHead(file)
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function findPiSession(sessionId: string, cwd = process.cwd()): PiSessionListItem | null {
  const all = listPiSessions(cwd)
  return all.find(s => s.sessionId === sessionId) ?? null
}

export function findPiSessionFile(sessionId: string, cwd = process.cwd()): string | null {
  return findPiSession(sessionId, cwd)?.sessionFile ?? null
}
