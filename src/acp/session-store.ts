import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPiAcpSessionMapPath } from './paths.js'
import { readPiSessionHeader } from './pi-sessions.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    const sessions: Record<string, StoredSession> = {}
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (
        entry &&
        typeof entry === 'object' &&
        entry.sessionId === sessionId &&
        typeof entry.cwd === 'string' &&
        entry.cwd.length > 0 &&
        typeof entry.sessionFile === 'string' &&
        entry.sessionFile.length > 0 &&
        typeof entry.updatedAt === 'string'
      ) {
        sessions[sessionId] = entry
      }
    }
    return { version: 1, sessions }
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // Preserve the original write/rename error.
    }
    throw error
  }
}

export class SessionStore {
  private readonly path: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    const stored = db.sessions[sessionId]
    if (!stored) return null

    const header = readPiSessionHeader(stored.sessionFile)
    if (!header || header.sessionId !== sessionId) return null
    return header.cwd === stored.cwd ? stored : { ...stored, cwd: header.cwd }
  }

  list(): StoredSession[] {
    const db = loadFile(this.path)
    const sessions: StoredSession[] = []
    for (const sessionId of Object.keys(db.sessions)) {
      const stored = this.get(sessionId)
      if (stored) sessions.push(stored)
    }
    return sessions
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    const db = loadFile(this.path)
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: new Date().toISOString()
    }
    saveFile(this.path, db)
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}
