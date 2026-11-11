// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = readFileSync('src-tauri/src/collector.rs', 'utf8')
const start = source.indexOf('if [ "${RACKTOP_INCLUDE_DISKS:-1}" = "1" ]; then')
const end = source.indexOf("printf '__RACKTOP_USERCPU__", start)
if (start < 0 || end < 0) throw new Error('Cannot locate the live disk collection block')
const script = source.slice(start, end)
const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function collect(environment = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-local-df-'))
  directories.push(directory)
  const log = join(directory, 'calls')
  writeFileSync(log, '')
  writeFileSync(join(directory, 'timeout'), `#!/bin/sh
[ "$1" = -k ] && [ "$2" = 1 ] && [ "$3" = 3 ] || exit 90
[ -z "\${TEST_TIMEOUT_EXIT:-}" ] || exit "$TEST_TIMEOUT_EXIT"
shift 3
exec "$@"
`, { mode: 0o700 })
  writeFileSync(join(directory, 'df'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DF_LOG"
local_only=0
for argument do [ "$argument" != -l ] || local_only=1; done
# An unrestricted query would contact an unavailable network filesystem.
[ "$local_only" = 1 ] || { printf 'network filesystem contacted\\n' >&2; exit 86; }
[ "\${TEST_DF_FAIL:-0}" != 1 ] || exit 1
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/root 100 40 60 40%% /\\n'
printf '/dev/data 200 50 150 25%% /data\\n'
printf '/dev/efi 10 1 9 10%% /boot/efi\\n'
`, { mode: 0o700 })
  const result = spawnSync('sh', ['-s'], {
    input: `${script}\nprintf 'after-disk-collection\\n'\n`,
    env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, TEST_DF_LOG: log, RACKTOP_INCLUDE_DISKS: '1', ...environment },
    encoding: 'utf8', timeout: 5000,
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return { result, calls }
}

test.skipIf(process.platform === 'win32')('live capacity collection never starts an unrestricted df query', () => {
  const { result, calls } = collect()
  expect(result.status, result.stderr).toBe(0)
  // The old fallback returned the same output, but first contacted NFS.
  expect(calls).toHaveLength(1)
  expect(calls[0].split(' ')).toContain('-l')
  expect(result.stdout).toBe('__RACKTOP_DISK__\n/|40|100|60\n/data|50|200|150\nafter-disk-collection\n')
})

test.skipIf(process.platform === 'win32')('a failed local capacity query does not retry or stop the remaining collector', () => {
  const { result, calls } = collect({ TEST_DF_FAIL: '1' })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0].split(' ')).toContain('-l')
  expect(result.stdout).toBe('__RACKTOP_DISK__\nafter-disk-collection\n')
})

test.skipIf(process.platform === 'win32')('lightweight snapshots that exclude disks do not start df', () => {
  const { result, calls } = collect({ RACKTOP_INCLUDE_DISKS: '0' })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toEqual([])
  expect(result.stdout).toBe('after-disk-collection\n')
})

test.skipIf(process.platform === 'win32').each([124, 137, 127])('timeout wrapper exit %i does not prevent the remaining collector from running', (code) => {
  const { result, calls } = collect({ TEST_TIMEOUT_EXIT: String(code) })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toEqual([])
  expect(result.stdout).toBe('__RACKTOP_DISK__\nafter-disk-collection\n')
})
