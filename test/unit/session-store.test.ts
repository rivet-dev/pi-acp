import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore } from '../../src/acp/session-store.js'

function writeSession(path: string, sessionId: string, cwd: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-07-14T00:00:00.000Z',
      cwd
    }) + '\n',
    'utf8'
  )
}

test('SessionStore writes atomically and returns a matching native pi session', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-session-store-'))
  const mapPath = join(root, 'session-map.json')
  const sessionFile = join(root, 'session.jsonl')
  writeSession(sessionFile, 'session-1', '/project')

  const store = new SessionStore(mapPath)
  store.upsert({ sessionId: 'session-1', cwd: '/project', sessionFile })

  assert.equal(store.get('session-1')?.sessionFile, sessionFile)
  assert.deepEqual(
    store.list().map(session => session.sessionId),
    ['session-1']
  )
  assert.deepEqual(
    readdirSync(root).filter(name => name.endsWith('.tmp')),
    []
  )
  assert.equal(JSON.parse(readFileSync(mapPath, 'utf8')).sessions['session-1'].cwd, '/project')
})

test('SessionStore rejects missing, corrupt, and mismatched-id session files and repairs stale cwd data', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-session-store-'))
  const mapPath = join(root, 'session-map.json')
  const sessionFile = join(root, 'session.jsonl')
  const store = new SessionStore(mapPath)

  store.upsert({ sessionId: 'session-1', cwd: '/project', sessionFile })
  assert.equal(store.get('session-1'), null)

  writeFileSync(sessionFile, 'not json\n', 'utf8')
  assert.equal(store.get('session-1'), null)

  writeSession(sessionFile, 'different-id', '/project')
  assert.equal(store.get('session-1'), null)

  writeSession(sessionFile, 'session-1', '/different-project')
  assert.equal(store.get('session-1')?.cwd, '/different-project')
})

test('SessionStore ignores malformed records and recovers a corrupt map on the next write', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-session-store-'))
  const mapPath = join(root, 'session-map.json')
  const sessionFile = join(root, 'session.jsonl')
  writeSession(sessionFile, 'session-1', '/project')
  writeFileSync(mapPath, '{invalid', 'utf8')

  const store = new SessionStore(mapPath)
  assert.equal(store.get('session-1'), null)
  store.upsert({ sessionId: 'session-1', cwd: '/project', sessionFile })
  assert.equal(store.get('session-1')?.cwd, '/project')

  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  map.sessions.bad = { sessionId: 'different', cwd: 123, sessionFile: null, updatedAt: false }
  writeFileSync(mapPath, JSON.stringify(map), 'utf8')

  assert.equal(store.get('bad'), null)
  assert.equal(store.get('session-1')?.sessionId, 'session-1')
})
