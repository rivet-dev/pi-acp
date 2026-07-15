import { isAbsolute, join } from 'node:path'

/**
 * Files created by pi-acp use guest paths under AgentOS. The nested Pi process
 * is a host process, so pass the corresponding shadow path when AgentOS exposes
 * one. Native pi-acp processes keep using the original path.
 */
export function childVisiblePath(path: string, env = process.env): string {
  const sandboxRoot = env.AGENTOS_SANDBOX_ROOT
  if (!sandboxRoot || !isAbsolute(path)) return path
  return join(sandboxRoot, path.replace(/^[/\\]+/, ''))
}
