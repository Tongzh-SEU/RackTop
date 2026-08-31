import AppKit
import Foundation

guard CommandLine.arguments.count == 4,
      let scale = Int(CommandLine.arguments[3]),
      scale == 1 || scale == 2 else {
    fputs("Usage: render-dmg-background.swift <input.svg> <output.png> <1|2>\n", stderr)
    exit(2)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let width = 720
let height = 390

guard let sourceImage = NSImage(contentsOf: sourceURL) else {
    fputs("Unable to read DMG background SVG at \(sourceURL.path)\n", stderr)
    exit(1)
}

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width * scale,
    pixelsHigh: height * scale,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bitmapFormat: [],
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("Unable to create DMG background bitmap\n", stderr)
    exit(1)
}

bitmap.size = NSSize(width: width, height: height)

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fputs("Unable to create DMG background graphics context\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
sourceImage.draw(
    in: NSRect(x: 0, y: 0, width: width, height: height),
    from: NSRect(origin: .zero, size: sourceImage.size),
    operation: .copy,
    fraction: 1,
    respectFlipped: true,
    hints: nil
)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Unable to encode DMG background PNG\n", stderr)
    exit(1)
}

do {
    try png.write(to: outputURL, options: .atomic)
} catch {
    fputs("Unable to write DMG background PNG: \(error)\n", stderr)
    exit(1)
}
