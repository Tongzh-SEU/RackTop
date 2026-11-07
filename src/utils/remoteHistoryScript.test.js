// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

const collector = readFileSync('src-tauri/assets/remote-history-collector.sh', 'utf8')
const usage = readFileSync('src-tauri/assets/remote-history-usage.sh', 'utf8')
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  mkdirSync('tmp', { recursive: true })
  const directory = mkdtempSync(join(process.cwd(), 'tmp/remote-history-'))
  directories.push(directory)
  const state = join(directory, '.racktop')
  mkdirSync(state)
  // A legacy lock left by the old implementation must not block the new collector.
  mkdirSync(join(state, '.collect.lock'))
  writeFileSync(join(directory, 'stat'), 'cpu  10 0 10 80 0 0 0 0\n')
  writeFileSync(join(directory, 'meminfo'), 'MemTotal: 100\nMemAvailable: 60\nSwapTotal: 0\nSwapFree: 0\n')
  writeFileSync(join(directory, 'nvidia-smi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  if (process.platform !== 'linux') writeFileSync(join(directory, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const script = join(directory, 'collector.sh')
  writeFileSync(script, 'racktop_probe_npu() { racktop_npu_status=1; }\n' + collector
    .replaceAll('/proc/stat', join(directory, 'stat')).replaceAll('/proc/meminfo', join(directory, 'meminfo')))
  const fetch = join(directory, 'usage.sh')
  writeFileSync(fetch, usage)
  const env = { ...process.env, HOME: directory, PATH: `${directory}:/usr/bin:/bin`, RACKTOP_COLLECTOR_BOUNDED: '1' }
  const run = (path, ...args) => spawnSync('sh', [path, ...args.map(String)], { env, encoding: 'utf8', timeout: 15000 })
  return { directory, state, script, fetch, env, run }
}

test.skipIf(process.platform === 'win32')('an exported partial hour stays minute-granular after compaction and retry', () => {
  const f = fixture()
  const hour = Math.floor(Date.now() / 3600000) * 3600 - 5 * 3600
  const file = join(f.state, '.usage-v1.tsv')
  writeFileSync(file, `v1|${hour + 1800}|GPU-a|alice|60|6000|60\n`)
  expect(f.run(f.fetch, hour + 1800).status).toBe(0)
  appendFileSync(file, `v1|${hour + 1920}|GPU-a|alice|60|12000|60\nv1|${hour + 3660}|GPU-a|alice|60|18000|60\n`)
  const collected = f.run(f.script)
  expect(collected.stderr).toBe('')
  expect(collected.status).toBe(0)
  const compacted = readFileSync(file, 'utf8')
  expect(compacted).toContain(`v1|${hour + 1920}|`)
  expect(compacted).toContain(`v2|${hour + 3600}|`)
  expect(compacted).not.toContain(`v2|${hour}|`)
  const backfill = f.run(f.fetch, hour + 1860)
  expect(backfill.status).toBe(0)
  expect(backfill.stdout).toContain(`v1|${hour + 1920}|GPU-a|alice|60|12000|60`)
  expect(f.run(f.fetch, hour + 1860).stdout).toBe(backfill.stdout)
})

test.skipIf(process.platform === 'win32')('protects the sync boundary even before any GPU usage is available', () => {
  const f = fixture()
  const since = Math.floor(Date.now() / 1000) - 1800
  expect(f.run(f.fetch, since).status).toBe(0)
  expect(readFileSync(join(f.state, '.usage-minute-hours'), 'utf8')).toContain(String(since - since % 3600))
})

test.skipIf(process.platform !== 'linux')('releases the actual collector lock after SIGKILL and rejects concurrent collectors', async () => {
  const f = fixture()
  const ready = join(f.directory, 'ready')
  writeFileSync(join(f.directory, 'nvidia-smi'), `#!/bin/sh\ntouch '${ready}'\nsleep 30\n`, { mode: 0o700 })
  const child = spawn('sh', [f.script], { env: f.env, detached: true, stdio: 'ignore' })
  const closed = once(child, 'close')
  try {
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(ready)).toBe(true)
    expect(f.run(f.script).status).toBe(1)
  } finally {
    process.kill(-child.pid, 'SIGKILL')
    await closed
  }
  writeFileSync(join(f.directory, 'nvidia-smi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  expect(f.run(f.script).status).toBe(0)
  expect(existsSync(join(f.state, '.history-v1.tsv'))).toBe(true)
}, 15000)


test.skipIf(process.platform === 'win32')('two clients share one minute without duplicating history and preserve old rows', () => {
  const f = fixture()
  const fixedNow = Math.floor(Date.now() / 60000) * 60 + 5
  writeFileSync(join(f.directory, 'date'), `#!/bin/sh\nprintf '%s\\n' '${fixedNow}'\n`, { mode: 0o700 })
  const history = join(f.state, '.history-v1.tsv')
  const oldBucket = Math.floor(Date.now() / 60000) * 60 - 600
  const oldRow = `v3|${oldBucket}|10|20|0|GPU-old,30,40,0,50,100,20`
  writeFileSync(history, oldRow + String.fromCharCode(10))
  f.env.RACKTOP_CLIENT_STATE_DIR = join(f.state, 'instances/a')
  expect(f.run(f.script).status).toBe(0)
  const first = readFileSync(history, 'utf8')
  f.env.RACKTOP_CLIENT_STATE_DIR = join(f.state, 'instances/b')
  expect(f.run(f.script).status).toBe(0)
  expect(readFileSync(history, 'utf8')).toBe(first)
  expect(first).toContain(oldRow)
  expect(first.trim().split(String.fromCharCode(10))).toHaveLength(2)
  expect(readFileSync(join(f.state, '.usage-minute-hours'), 'utf8').trim()).not.toBe('')
})
