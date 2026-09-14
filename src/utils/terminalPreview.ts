/** Local preview only. Never executes commands or connects to a host. */
export function createTerminalPreview(write: (data: string) => void, size: () => { rows: number; cols: number }) {
  let line = ''
  const prompt = () => write('\x1b[32mpreview@racktop\x1b[0m:~$ ')
  const fill = () => {
    for (let i = 1; i <= size().rows * 3; i++) write(`模拟输出 ${String(i).padStart(4, '0')} · 终端应一直显示到框底部\r\n`)
  }
  write('RackTop 本地模拟终端（不连接 SSH、不执行真实命令）\r\n命令：help、fill、size、clear、echo 文本；支持回车和退格。\r\n')
  fill()
  prompt()
  return (data: string) => {
    if (data.startsWith('\x1b[200~')) {
      const pasted = data.slice(6).replace(/\x1b\[201~$/, '').replace(/\r\n?/g, '\n')
      line += pasted
      write(pasted.replace(/\n/g, '\r\n'))
      return
    }
    else if (data.startsWith('\x1b')) return
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        write('\r\n')
        const command = line.trim()
        line = ''
        if (command === 'fill') fill()
        else if (command === 'clear') write('\x1b[2J\x1b[H')
        else if (command === 'size') write(`${size().cols} 列 × ${size().rows} 行\r\n`)
        else if (command === 'help') write('fill：连续输出；size：当前列/行数；clear：清屏；echo 文本：回显\r\n')
        else if (command.startsWith('echo ')) write(`${command.slice(5).replace(/\n/g, '\r\n')}\r\n`)
        else if (command) write(`模拟终端不执行真实命令：${command.replace(/\n/g, '\r\n')}\r\n`)
        prompt()
      } else if (character === '\x7f') {
        if (line) { line = Array.from(line).slice(0, -1).join(''); write('\b \b') }
      } else if (character === '\x03' || character === '\x15') {
        line = ''; write('^C\r\n'); prompt()
      } else if (character >= ' ') { line += character; write(character) }
    }
  }
}
