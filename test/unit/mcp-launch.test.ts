import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareMcpLaunch } from '../../src/acp/mcp.js'
import { childVisiblePath } from '../../src/acp/child-path.js'

test('childVisiblePath maps guest files into the AgentOS shadow root', () => {
  assert.equal(
    childVisiblePath('/tmp/pi-acp/config.json', { AGENTOS_SANDBOX_ROOT: '/host/shadow' }),
    '/host/shadow/tmp/pi-acp/config.json'
  )
  assert.equal(childVisiblePath('/tmp/pi-acp/config.json', {}), '/tmp/pi-acp/config.json')
})

test('prepareMcpLaunch writes ACP stdio servers for the Pi MCP extension', () => {
  const launch = prepareMcpLaunch([
    {
      name: 'demo',
      command: '/usr/bin/demo-mcp',
      args: ['--stdio'],
      env: [{ name: 'TOKEN', value: 'secret' }]
    }
  ])

  assert.ok(launch)
  const configPath = launch.args.at(-1)
  assert.ok(configPath)
  assert.equal(launch.args.at(-2), '--mcp-config')
  assert.ok(launch.args.includes('--extension'))
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    mcpServers: {
      demo: {
        command: '/usr/bin/demo-mcp',
        args: ['--stdio'],
        env: { TOKEN: 'secret' },
        directTools: true,
        lifecycle: 'keep-alive'
      }
    }
  })

  launch.cleanup()
  assert.equal(existsSync(configPath), false)
})

test('prepareMcpLaunch isolates ACP servers from global and project MCP configs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-project-'))
  mkdirSync(join(cwd, '.pi'), { recursive: true })
  writeFileSync(
    join(cwd, '.pi', 'mcp.json'),
    JSON.stringify({ mcpServers: { demo: { command: '/wrong' }, unrelated: { command: '/also-wrong' } } })
  )

  const launch = prepareMcpLaunch([{ name: 'demo', command: '/right', args: [], env: [] }])
  assert.ok(launch)
  try {
    const extensionPath = launch.args[launch.args.indexOf('--extension') + 1]!
    const configPath = launch.args[launch.args.indexOf('--mcp-config') + 1]!
    const configModulePath = join(extensionPath, '..', 'config.ts')
    const { loadMcpConfig } = await import(`${pathToFileURL(configModulePath).href}?test=${Date.now()}`)
    const loaded = loadMcpConfig(configPath, cwd)

    assert.deepEqual(Object.keys(loaded.mcpServers), ['demo'])
    assert.equal(loaded.mcpServers.demo.command, '/right')
  } finally {
    launch.cleanup()
  }
})

test('prepareMcpLaunch rejects unsupported transports and duplicate names', () => {
  assert.throws(
    () => prepareMcpLaunch([{ type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: [] }]),
    /Unsupported MCP transport/
  )

  assert.throws(
    () =>
      prepareMcpLaunch([
        { name: 'same', command: '/bin/a', args: [], env: [] },
        { name: 'same', command: '/bin/b', args: [], env: [] }
      ]),
    /Duplicate MCP server name/
  )
})
