import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childVisiblePath } from './child-path.js'

export type PermissionGateLaunch = {
  args: string[]
  cleanup(): void
}

const PERMISSION_EXTENSION = `export default function permissionGate(pi) {
  const guardedTools = new Set(['bash', 'edit', 'write'])

  pi.on('tool_call', async (event, ctx) => {
    if (!guardedTools.has(event.toolName)) return
    if (!ctx.hasUI) {
      return { block: true, reason: 'Permission approval is unavailable for this tool call.' }
    }

    const input = JSON.stringify(event.input ?? {}, null, 2)
    const detail = input.length > 4000 ? input.slice(0, 4000) + '\\n…' : input
    const confirmed = await ctx.ui.confirm('Allow ' + event.toolName + '?', detail)
    if (!confirmed) return { block: true, reason: 'Tool call was denied by the user.' }
  })
}
`

export function preparePermissionGateLaunch(env = process.env): PermissionGateLaunch | null {
  if (env.PI_ACP_PERMISSION_GATE !== '1') return null

  const extensionDir = mkdtempSync(join(tmpdir(), 'pi-acp-permissions-'))
  const extensionPath = join(extensionDir, 'permission-gate.ts')
  try {
    writeFileSync(extensionPath, PERMISSION_EXTENSION, 'utf8')
  } catch (error) {
    rmSync(extensionDir, { recursive: true, force: true })
    throw error
  }

  let cleaned = false
  return {
    args: ['--extension', childVisiblePath(extensionPath, env)],
    cleanup() {
      if (cleaned) return
      cleaned = true
      rmSync(extensionDir, { recursive: true, force: true })
    }
  }
}
