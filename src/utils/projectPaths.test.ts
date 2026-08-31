import { describe, expect, it } from 'vitest'
import { defaultProjectTargetPath, isLegacyProjectNameTargetPath } from './projectPaths'

describe('defaultProjectTargetPath', () => {
  it('keeps the source basename and its immediate parent directory', () => {
    expect(defaultProjectTargetPath('/mnt/tongzh/datasets/APPS_hf', 'apps')).toBe('~/datasets/APPS_hf')
    expect(defaultProjectTargetPath('~/projects/WaterFlower', 'ignored')).toBe('~/projects/WaterFlower')
  })

  it('falls back to the source basename or project name at home', () => {
    expect(defaultProjectTargetPath('/APPS_hf', 'apps')).toBe('~/APPS_hf')
    expect(defaultProjectTargetPath('', 'apps')).toBe('~/apps')
  })

  it('recognizes only target paths generated from the old project-name rule', () => {
    expect(isLegacyProjectNameTargetPath('/tempdisk2/tongzh/apps', '/mnt/tongzh/datasets/APPS_hf', 'apps')).toBe(true)
    expect(isLegacyProjectNameTargetPath('/data/custom-copy', '/mnt/tongzh/datasets/APPS_hf', 'apps')).toBe(false)
    expect(isLegacyProjectNameTargetPath('~/APPS_hf', '/mnt/tongzh/datasets/APPS_hf', 'apps')).toBe(false)
  })
})
