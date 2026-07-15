import { RequestError, type McpServer } from '@agentclientprotocol/sdk'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { childVisiblePath } from './child-path.js'

export type McpLaunch = {
  args: string[]
  cleanup(): void
}

type StdioServer = Extract<McpServer, { command: string }>

function isStdioServer(server: McpServer): server is StdioServer {
  return !('type' in server) && 'command' in server
}

export function prepareMcpLaunch(servers: McpServer[] | undefined): McpLaunch | null {
  if (!servers?.length) return null

  const names = new Set<string>()
  const mcpServers: Record<string, unknown> = {}

  for (const server of servers) {
    if (!isStdioServer(server)) {
      throw RequestError.invalidParams({}, `Unsupported MCP transport for server: ${server.name}`)
    }
    if (names.has(server.name)) {
      throw RequestError.invalidParams({}, `Duplicate MCP server name: ${server.name}`)
    }
    names.add(server.name)

    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(item => [item.name, item.value])),
      directTools: true,
      lifecycle: 'keep-alive'
    }
  }

  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('pi-mcp-adapter/package.json')
  const packageDir = dirname(packagePath)
  const configDir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  const configPath = join(configDir, 'mcp.json')
  let extensionPath: string
  try {
    extensionPath = materializeExclusiveAdapter(configDir, packageDir)
    writeFileSync(configPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8')
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true })
    throw error
  }

  let cleaned = false
  return {
    args: ['--extension', childVisiblePath(extensionPath), '--mcp-config', childVisiblePath(configPath)],
    cleanup() {
      if (cleaned) return
      cleaned = true
      rmSync(configDir, { recursive: true, force: true })
    }
  }
}

/**
 * pi-mcp-adapter normally merges global and project MCP files with --mcp-config.
 * ACP session configuration must be isolated, so run a temporary copy whose
 * loader treats the generated override as the only source.
 */
function materializeExclusiveAdapter(configDir: string, packageDir: string): string {
  const adapterDir = join(configDir, 'adapter')
  cpSync(packageDir, adapterDir, { recursive: true })
  symlinkSync(dirname(packageDir), join(configDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

  const configSourcePath = join(adapterDir, 'config.ts')
  const source = readFileSync(configSourcePath, 'utf8')
  const marker = 'export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {\n'
  if (!source.includes(marker)) throw new Error('Unsupported pi-mcp-adapter config loader')

  const exclusiveLoader = `${marker}  if (overridePath) {\n    return readValidatedConfig(overridePath, \`MCP config from \${overridePath}\`) ?? { mcpServers: {} };\n  }\n\n`
  writeFileSync(configSourcePath, source.replace(marker, exclusiveLoader), 'utf8')
  return join(adapterDir, 'index.ts')
}
