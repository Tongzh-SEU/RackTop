import type { Snapshot } from '../types/models'

export function acceleratorLabel(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return snapshot.acceleratorVendor === 'ascend' ? 'NPU' : 'GPU'
}

export function acceleratorMemoryLabel(snapshot: Pick<Snapshot, 'acceleratorVendor'>) {
  return snapshot.acceleratorVendor === 'ascend' ? 'NPU MEM' : 'GPU MEM'
}
