import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'

test('listPiSessions: respects sessionDir from pi settings.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const customSessionsDir = join(root, 'somewhere-else', '--p--')
  mkdirSync(customSessionsDir, { recursive: true })

  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({ sessionDir: join(root, 'somewhere-else') }, null, 2),
    'utf8'
  )

  writeFileSync(
    join(customSessionsDir, 's.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-custom',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const s = listPiSessions().find(x => x.sessionId === 'sess-custom')
    assert.ok(s)
    assert.equal(s?.sessionFile, join(customSessionsDir, 's.jsonl'))
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('listPiSessions: project sessionDir overrides global settings and resolves relative to cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const project = join(root, 'project')
  const projectSessions = join(project, 'relative-sessions')
  mkdirSync(join(project, '.pi'), { recursive: true })
  mkdirSync(projectSessions, { recursive: true })

  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: join(root, 'global-sessions') }), 'utf8')
  writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ sessionDir: './relative-sessions' }), 'utf8')
  writeFileSync(
    join(projectSessions, 'project.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-project',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: project
    }) + '\n',
    'utf8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  try {
    const sessions = listPiSessions(project)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.sessionId, 'sess-project')
    assert.equal(sessions[0]?.sessionFile, join(projectSessions, 'project.jsonl'))
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
