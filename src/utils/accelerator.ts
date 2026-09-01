import type { Snapshot } from '../types/models'

type AcceleratorVendor = NonNullable<Snapshot['acceleratorVendor']>

const ACCELERATOR_PRESENTATION: Record<AcceleratorVendor, { label: string; driver: string }> = {
  nvidia: { label: 'GPU', driver: 'NVIDIA 驱动' },
  ascend: { label: 'NPU', driver: 'NPU 驱动' },
  ppu: { label: 'PPU', driver: 'PPU 驱动' },
}

function acceleratorPresentation(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return ACCELERATOR_PRESENTATION[snapshot.acceleratorVendor ?? 'nvidia']
}

export function acceleratorLabel(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return acceleratorPresentation(snapshot).label
}

export function acceleratorMemoryLabel(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return `${acceleratorLabel(snapshot)} MEM`
}

export function acceleratorDriverLabel(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return acceleratorPresentation(snapshot).driver
}

export function acceleratorDeviceName(name: string) {
  return name.replace(/^NVIDIA\s+/, '')
}
