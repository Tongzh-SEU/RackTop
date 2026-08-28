const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

export function normalizeTerminalPaste(value: string) {
  return value.replace(/\r\n?/g, '\n')
}

export function isMultilineTerminalPaste(value: string) {
  return /[\r\n]/.test(value)
}

export function bracketTerminalPaste(value: string) {
  return `${BRACKETED_PASTE_START}${normalizeTerminalPaste(value)}${BRACKETED_PASTE_END}`
}
