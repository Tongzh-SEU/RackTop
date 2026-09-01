export function afterNextPaint(callback: () => void) {
  let secondFrame = 0
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(callback)
  })
  return () => {
    cancelAnimationFrame(firstFrame)
    if (secondFrame) cancelAnimationFrame(secondFrame)
  }
}
