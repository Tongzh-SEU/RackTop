import { describe, expect, it } from 'vitest'
import { analyzeCudaCommand } from './cudaCommand'

describe('analyzeCudaCommand', () => {
  it('keeps a matching numeric assignment', () => {
    expect(analyzeCudaCommand('CUDA_VISIBLE_DEVICES=2 python train.py', 2)).toEqual({ command: 'CUDA_VISIBLE_DEVICES=2 python train.py', modified: false, requiresConfirmation: false, message: undefined })
  })

  it('only rewrites the assignment value when a numeric list conflicts', () => {
    expect(analyzeCudaCommand('echo 0,1; export CUDA_VISIBLE_DEVICES=0,1 python train.py', 3).command).toBe('echo 0,1; export CUDA_VISIBLE_DEVICES=3 python train.py')
  })

  it('resolves a preceding simple variable assignment', () => {
    const result = analyzeCudaCommand('CARD=0; CUDA_VISIBLE_DEVICES=$CARD python train.py', 1)
    expect(result.command).toBe('CARD=0; CUDA_VISIBLE_DEVICES=1 python train.py')
    expect(result.modified).toBe(true)
  })

  it.each([
    'CUDA_VISIBLE_DEVICES=$CARD python train.py',
    'CUDA_VISIBLE_DEVICES=$(pick_gpu) python train.py',
    'CUDA_VISIBLE_DEVICES=`pick_gpu` python train.py',
    'CUDA_VISIBLE_DEVICES=${CARD:-0} python train.py',
  ])('requires confirmation for unresolved expressions: %s', (command) => {
    expect(analyzeCudaCommand(command, 2).requiresConfirmation).toBe(true)
  })

  it('does not rewrite ordinary command text', () => {
    const command = 'printf "CUDA_VISIBLE_DEVICES=0"'
    expect(analyzeCudaCommand(command, 2)).toMatchObject({ command, modified: false, requiresConfirmation: false })
  })
})
