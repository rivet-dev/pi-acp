import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('getAuthMethods: includes Zed terminal-auth metadata when enabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true })
  assert.equal(methods.length, 1)
  const m: any = methods[0]

  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.ok(m._meta)
  assert.ok(m._meta['terminal-auth'])
  assert.ok(typeof m._meta['terminal-auth'].command === 'string')
  assert.deepEqual(m._meta['terminal-auth'].args, ['--terminal-login'])
  assert.equal(m._meta['terminal-auth'].label, 'Launch pi')
})

test('getAuthMethods: omits Zed terminal-auth metadata when disabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: false })
  const m: any = methods[0]
  assert.ok(!m._meta || !m._meta['terminal-auth'])
})

test('PiAcpAgent: authenticate accepts only the advertised terminal method', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.authenticate({ methodId: PI_SETUP_METHOD_ID })
  await assert.rejects(agent.authenticate({ methodId: 'unknown' }), /Unknown authentication method/)
})
