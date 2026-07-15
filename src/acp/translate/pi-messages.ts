export function normalizePiMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export function normalizePiAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export type PiAssistantReplayBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }

/** Preserve the order and structure of persisted Pi assistant content during ACP replay. */
export function piAssistantReplayBlocks(content: unknown): PiAssistantReplayBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []

  const blocks: PiAssistantReplayBlock[] = []
  for (const value of content) {
    const block = value as Record<string, unknown> | null
    if (!block) continue

    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      blocks.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'thinking') {
      const text =
        typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
      if (text) blocks.push({ type: 'thinking', text })
      continue
    }

    if ((block.type === 'toolCall' || block.type === 'tool_call') && typeof block.id === 'string' && block.id) {
      blocks.push({
        type: 'toolCall',
        id: block.id,
        name: typeof block.name === 'string' && block.name ? block.name : 'tool',
        arguments: block.arguments ?? block.input ?? null
      })
    }
  }

  return blocks
}
