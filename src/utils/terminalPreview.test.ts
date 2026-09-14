import { describe, expect, it } from 'vitest'
import { createTerminalPreview } from './terminalPreview'

describe('terminal preview', () => {
  it('fills beyond the current viewport and uses resized dimensions', () => {
    let output = ''
    const size = { cols: 80, rows: 24 }
    const input = createTerminalPreview(data => { output += data }, () => size)
    expect(output).toContain('0072')
    size.rows = 60
    output = ''
    input('fill\rsize\r')
    expect(output).toContain('0180')
    expect(output).toContain('80 列 × 60 行')
  })

  it('echoes input, deletes, clears and rejects real commands', () => {
    let output = ''
    const input = createTerminalPreview(data => { output += data }, () => ({ cols: 80, rows: 24 }))
    output = ''
    input('echo abc\x7fD\r')
    expect(output).toContain('\r\nabD\r\n')
    input('clear\r')
    expect(output).toContain('\x1b[2J\x1b[H')
    input('ssh host\r')
    expect(output).toContain('模拟终端不执行真实命令：ssh host')
  })

  it('does not execute pasted multiline commands until Enter', () => {
    let output = ''
    const input = createTerminalPreview(data => { output += data }, () => ({ cols: 80, rows: 24 }))
    output = ''
    input('\x1b[200~echo one\ntwo\x1b[201~')
    expect(output).toBe('echo one\r\ntwo')
    input('\r')
    expect(output).toContain('\r\none\r\ntwo\r\n')
  })

  it('preserves Chinese paragraphs and blank lines without executing pasted input', () => {
    let output = ''
    const input = createTerminalPreview(data => { output += data }, () => ({ cols: 80, rows: 24 }))
    output = ''
    input('\x1b[200~第一段文字\r\n\r\n第二段文字\n第三段文字\x1b[201~')
    expect(output).toBe('第一段文字\r\n\r\n第二段文字\r\n第三段文字')
    expect(output).not.toContain('preview@racktop')
  })
})
