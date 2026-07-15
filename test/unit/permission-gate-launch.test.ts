import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { preparePermissionGateLaunch } from '../../src/acp/permissions.js'

test('preparePermissionGateLaunch is opt-in', () => {
  assert.equal(preparePermissionGateLaunch({}), null)
})

test('preparePermissionGateLaunch materializes and cleans up the extension', () => {
  const launch = preparePermissionGateLaunch({ PI_ACP_PERMISSION_GATE: '1' })
  assert.ok(launch)
  assert.equal(launch.args[0], '--extension')

  const extensionPath = launch.args[1]!
  assert.equal(existsSync(extensionPath), true)
  const source = readFileSync(extensionPath, 'utf8')
  assert.match(source, /tool_call/)
  assert.match(source, /ctx\.ui\.confirm/)
  assert.match(source, /'bash', 'edit', 'write'/)

  launch.cleanup()
  assert.equal(existsSync(extensionPath), false)
  launch.cleanup()
})
