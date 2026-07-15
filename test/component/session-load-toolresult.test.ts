import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays assistant blocks and updates their tool calls', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'checking the shell' },
              { type: 'text', text: 'Running it.' },
              { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hello' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { command: 'echo hello' },
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    assert.equal(updates.filter(u => u?.sessionUpdate === 'tool_call').length, 1)
    assert.equal(updates[0]?.sessionUpdate, 'agent_thought_chunk')
    assert.deepEqual(updates[0]?.content, { type: 'text', text: 'checking the shell' })
    assert.equal(updates[1]?.sessionUpdate, 'agent_message_chunk')
    assert.deepEqual(updates[1]?.content, { type: 'text', text: 'Running it.' })

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.content, undefined)
    assert.equal(toolCall._meta, undefined)
    assert.deepEqual(toolCall.rawInput, { command: 'echo hello' })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate.content, [{ type: 'content', content: { type: 'text', text: 'hello from bash' } }])
    assert.equal(toolCallUpdate._meta, undefined)
    assert.deepEqual(toolCallUpdate.rawOutput, {
      result: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'echo hello' },
        content: [{ type: 'text', text: 'hello from bash' }],
        isError: false
      },
      exitCode: 0
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
