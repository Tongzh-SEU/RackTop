import { describe, expect, it } from 'vitest'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from './terminalPaste'

describe('terminal paste protection', () => {
  it('normalizes Windows and legacy line endings without changing commands', () => {
    expect(normalizeTerminalPaste('cd /tmp\r\necho ready\r')).toBe('cd /tmp\necho ready\n')
  })

  it('only treats pasted line breaks as a multi-line command block', () => {
    expect(isMultilineTerminalPaste('echo ready')).toBe(false)
    expect(isMultilineTerminalPaste('echo one\necho two')).toBe(true)
  })

  it('wraps a multi-line script in the standard bracketed-paste control sequence', () => {
    expect(bracketTerminalPaste('echo one\r\necho two')).toBe('\x1b[200~echo one\necho two\x1b[201~')
  })
})
