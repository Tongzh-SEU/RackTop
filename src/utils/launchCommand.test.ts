import { describe, expect, it } from 'vitest'
import { launchCommandPreview, normalizeLaunchCommand, parseLaunchParameters, parseTaskParameters, replaceLaunchContext, resolveProjectLogPath, updateLaunchParameter } from './launchCommand'

describe('normalizeLaunchCommand', () => {
  it('replaces copied working-directory, GPU, nohup, log and PID wrappers', () => {
    const result = normalizeLaunchCommand(`cd /home/tongzh/pycharm/MetaDistill
EXP_NAME=trial
nohup env CUDA_VISIBLE_DEVICES=2 \\
HTTP_PROXY=http://127.0.0.1:17990 \\
python train.py --save-path "runs/$EXP_NAME" > "logs/$EXP_NAME.log" 2>&1 &
echo $! > "runs/$EXP_NAME/launcher.pid"`)

    expect(result.detectedWorkingDirectory).toBe('/home/tongzh/pycharm/MetaDistill')
    expect(result.detectedCudaVisibleDevices).toEqual([2])
    expect(result.detectedProjectLogPath).toBe('logs/$EXP_NAME.log')
    expect(result.replacedCudaVisibleDevices).toBe(true)
    expect(result.removedNoHup).toBe(true)
    expect(result.command).toContain('HTTP_PROXY=http://127.0.0.1:17990')
    expect(result.command).toContain('python train.py')
    expect(result.command).not.toContain('CUDA_VISIBLE_DEVICES')
    expect(result.command).not.toContain('nohup')
    expect(result.command).not.toContain('launcher.pid')
    expect(result.command).not.toContain('2>&1')
  })

  it('resolves a copied project log path from its leading variable assignment', () => {
    expect(resolveProjectLogPath('logs/$EXP_NAME.log', 'EXP_NAME=meta_online_replay\npython train.py')).toBe('logs/meta_online_replay.log')
  })

  it('detects common project-log declarations beyond stdout redirection', () => {
    expect(normalizeLaunchCommand('python train.py --log-file runs/train.log').detectedProjectLogPath).toBe('runs/train.log')
    expect(normalizeLaunchCommand('python train.py | tee -a logs/train.log').detectedProjectLogPath).toBe('logs/train.log')
    expect(normalizeLaunchCommand('python train.py\n"logs/train.log" 2>&1 &').detectedProjectLogPath).toBe('logs/train.log')
  })

  it('recognizes the copied MetaDistill log line even when its redirect operator is missing', () => {
    const command = `cd /home/tongzh/pycharm/MetaDistill
EXP_NAME=meta_online_replay_distill_gpu2_4090d_r2w13_lr6e-6
mkdir -p "runs/$EXP_NAME" logs
nohup env CUDA_VISIBLE_DEVICES=2
HTTP_PROXY=http://127.0.0.1:17990
HTTPS_PROXY=http://127.0.0.1:17990
ALL_PROXY=socks5://127.0.0.1:17990
/home/tongzh/miniconda3/bin/conda run --no-capture-output -n MetaTestCode
python train.py
  --meta-online-replay-distill
  --lr 6e-6
  --save-path "runs/$EXP_NAME"
"logs/$EXP_NAME.log" 2>&1 &
echo $! > "runs/$EXP_NAME/launcher.pid"`

    const normalized = normalizeLaunchCommand(command)
    expect(normalized.detectedProjectLogPath).toBe('logs/$EXP_NAME.log')
    expect(resolveProjectLogPath(normalized.detectedProjectLogPath ?? '', command)).toBe('logs/meta_online_replay_distill_gpu2_4090d_r2w13_lr6e-6.log')
    expect(normalized.command).not.toContain('logs/$EXP_NAME.log')
  })

  it('keeps CUDA indices for the GPU selector before removing the copied assignment', () => {
    const result = normalizeLaunchCommand('CUDA_VISIBLE_DEVICES="0, 3" python train.py')

    expect(result.detectedCudaVisibleDevices).toEqual([0, 3])
    expect(result.command).toBe('python train.py')
  })

  it('removes the orphaned env wrapper while retaining copied proxy assignments', () => {
    const result = normalizeLaunchCommand(`nohup env CUDA_VISIBLE_DEVICES=2 \\
HTTP_PROXY=http://127.0.0.1:17990 \\
HTTPS_PROXY=http://127.0.0.1:17990 \\
python train.py`)

    expect(result.command).toContain('HTTP_PROXY=http://127.0.0.1:17990')
    expect(result.command).not.toMatch(/^\s*env\b/m)
    expect(result.command).not.toContain('CUDA_VISIBLE_DEVICES')
  })

  it('previews the selected directory and GPU indices as the effective command', () => {
    expect(launchCommandPreview('/project', 'python train.py', [0, 3])).toBe('cd -- /project\nCUDA_VISIBLE_DEVICES=0,3 \\\npython train.py')
  })

  it('replaces copied directory and CUDA values while preserving the command template', () => {
    const preview = replaceLaunchContext('cd /home/tongzh/pycharm/MetaDistill\nnohup env CUDA_VISIBLE_DEVICES=2 \\\npython train.py --lr 6e-6', '/home/zhaohaotong/narcissistic-project', [0])

    expect(preview).toContain('cd /home/zhaohaotong/narcissistic-project')
    expect(preview).toContain('nohup env CUDA_VISIBLE_DEVICES=0')
    expect(preview).toContain('python train.py --lr 6e-6')
  })

  it('finds editable long options while preserving the surrounding shell command', () => {
    const command = 'HTTP_PROXY=http://127.0.0.1:17990 python train.py --meta-online-replay-distill --lr 6e-6 --experiment-name "$EXP_NAME"'
    const parameters = parseLaunchParameters(command)

    expect(parameters.map(({ name, value, hasValue }) => ({ name, value, hasValue }))).toEqual([
      { name: '--meta-online-replay-distill', value: '', hasValue: false },
      { name: '--lr', value: '6e-6', hasValue: true },
      { name: '--experiment-name', value: '"$EXP_NAME"', hasValue: true },
    ])
    expect(updateLaunchParameter(command, parameters[1], '1e-5')).toContain('--lr 1e-5')
    expect(updateLaunchParameter(command, parameters[0], '', false)).not.toContain('--meta-online-replay-distill')
  })

  it('excludes conda launcher flags from task parameters', () => {
    const parameters = parseTaskParameters('/opt/conda/bin/conda run --no-capture-output -n MetaTestCode python train.py --meta-online-replay-distill --lr 6e-6')
    expect(parameters.map((parameter) => parameter.name)).toEqual(['--meta-online-replay-distill', '--lr'])
  })
})
