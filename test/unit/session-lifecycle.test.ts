import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function withoutSignal(params: any) {
  assert.ok(params.signal instanceof AbortSignal)
  const { signal: _signal, ...rest } = params
  return rest
}

test('PiAcpAgent: advertises stable resume and close capabilities', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.resume, {})
  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.close, {})
})

test('PiAcpAgent: resume restores persisted state without replaying history', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-resume-'))
  const sessionFile = join(cwd, 'session.jsonl')
  const spawnCalls: any[] = []
  let getMessagesCalls = 0
  const proc = {
    onEvent: () => () => {},
    async getState() {
      return { thinkingLevel: 'high', model: { provider: 'test', id: 'alpha' } }
    },
    async getAvailableModels() {
      return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
    },
    async getMessages() {
      getMessagesCalls += 1
      return { messages: [{ role: 'assistant', content: 'must not replay' }] }
    }
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return proc
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const upserts: any[] = []
    ;(agent as any).store = {
      get(sessionId: string) {
        return sessionId === 'persisted' ? { sessionId, cwd, sessionFile } : null
      },
      upsert(entry: any) {
        upserts.push(entry)
      }
    }

    const response = await agent.resumeSession({
      sessionId: 'persisted',
      cwd,
      mcpServers: []
    })

    assert.deepEqual(spawnCalls.map(withoutSignal), [
      {
        cwd,
        sessionPath: sessionFile,
        mcpServers: [],
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.equal(getMessagesCalls, 0)
    assert.equal(response.modes?.currentModeId, 'high')
    assert.equal(response.configOptions?.find(option => option.id === 'model')?.currentValue, 'test/alpha')
    assert.deepEqual(upserts, [{ sessionId: 'persisted', cwd, sessionFile }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: resume rejects a cwd that differs from the persisted session', async () => {
  const persistedCwd = mkdtempSync(join(tmpdir(), 'pi-acp-resume-stored-'))
  const requestedCwd = mkdtempSync(join(tmpdir(), 'pi-acp-resume-requested-'))
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get() {
      return { sessionId: 'persisted', cwd: persistedCwd, sessionFile: join(persistedCwd, 'session.jsonl') }
    }
  }

  await assert.rejects(
    agent.resumeSession({ sessionId: 'persisted', cwd: requestedCwd, mcpServers: [] }),
    (error: any) => error?.code === -32602
  )
})

test('PiAcpAgent: resume validates the cwd of an already active session', async () => {
  const persistedCwd = mkdtempSync(join(tmpdir(), 'pi-acp-active-stored-'))
  const requestedCwd = mkdtempSync(join(tmpdir(), 'pi-acp-active-requested-'))
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = {
    maybeGet() {
      return { sessionId: 'active', cwd: persistedCwd, mcpServers: [] }
    }
  }

  await assert.rejects(
    agent.resumeSession({ sessionId: 'active', cwd: requestedCwd, mcpServers: [] }),
    (error: any) => error?.code === -32602
  )
})

test('PiAcpSession: close cancels active and queued prompts before disposing', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as FakePiRpcProcess & { disposeCount: number; dispose: () => void }
  proc.disposeCount = 0
  proc.dispose = () => {
    proc.disposeCount += 1
  }
  const session = new PiAcpSession({
    sessionId: 'active',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const active = session.prompt('one')
  const queued = session.prompt('two')
  await session.close()

  assert.equal(await active, 'cancelled')
  assert.equal(await queued, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  await assert.rejects(session.prompt('after close'), (error: any) => error?.code === -32602)
})

test('PiAcpSession: close does not wait for a wedged abort or client update', async () => {
  const conn = new FakeAgentSideConnection()
  conn.sessionUpdate = async () => new Promise<void>(() => {})
  const proc = new FakePiRpcProcess() as FakePiRpcProcess & { disposeCount: number; dispose: () => void }
  proc.abort = async () => new Promise<void>(() => {})
  proc.disposeCount = 0
  proc.dispose = () => {
    proc.disposeCount += 1
  }
  const session = new PiAcpSession({
    sessionId: 'wedged',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const prompt = session.prompt('one')
  const closed = await Promise.race([
    session.close().then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))
  ])

  assert.equal(closed, true)
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.disposeCount, 1)
})

test('PiAcpAgent: close cancels an in-flight restore before responding', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-close-restore-'))
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get() {
      return { sessionId: 'restoring', cwd, sessionFile: join(cwd, 'session.jsonl') }
    },
    upsert() {}
  }

  let startupSignal: AbortSignal | undefined
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    startupSignal = params.signal
    return new Promise((_resolve, reject) => {
      params.signal.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.name = 'PiRpcSpawnError'
        reject(error)
      })
    })
  }

  try {
    const resume = agent.resumeSession({ sessionId: 'restoring', cwd, mcpServers: [] })
    await new Promise(resolve => setImmediate(resolve))
    await agent.closeSession({ sessionId: 'restoring' })

    assert.equal(startupSignal?.aborted, true)
    await assert.rejects(resume)
    assert.equal((agent as any).sessions.maybeGet('restoring'), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpSession: prompt failures reject instead of reporting a successful end turn', async () => {
  const proc = {
    onEvent: () => () => {},
    async prompt() {
      throw new Error('provider failed')
    }
  }
  const session = new PiAcpSession({
    sessionId: 'failed',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection())
  })

  await assert.rejects(session.prompt('hello'), /Internal error: provider failed/)
})

test('SessionManager: close is isolated and idempotent', async () => {
  const manager = new SessionManager()
  const closed: string[] = []
  const fakeSession = (id: string) => ({
    async close() {
      closed.push(id)
    }
  })

  ;(manager as any).sessions.set('one', fakeSession('one'))
  ;(manager as any).sessions.set('two', fakeSession('two'))

  await manager.close('one')
  await manager.close('one')

  assert.deepEqual(closed, ['one'])
  assert.equal(manager.maybeGet('one'), undefined)
  assert.notEqual(manager.maybeGet('two'), undefined)
})

test('PiAcpAgent: close does not restore an inactive persisted session', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const closed: string[] = []
  ;(agent as any).sessions = {
    async close(sessionId: string) {
      closed.push(sessionId)
    }
  }
  ;(agent as any).store = {
    get() {
      throw new Error('close must not inspect persistence')
    }
  }

  assert.deepEqual(await agent.closeSession({ sessionId: 'inactive' }), {})
  assert.deepEqual(closed, ['inactive'])
})
