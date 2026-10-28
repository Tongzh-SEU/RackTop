// Run from the repository root: swift scripts/export-tray-icons.swift
import AppKit
let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "src-tauri/icons/tray"
for stem in ["macos-template", "color"] {
    let base = directory + "/" + stem
    let render = Process()
    render.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    render.arguments = ["-s", "format", "png", base + ".svg", "-o", base + ".png"]
    try render.run()
    render.waitUntilExit()
    guard render.terminationStatus == 0 else { exit(1) }
    let source = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: base + ".png")))!
    var data = Data()
    for y in 0..<36 {
        for x in 0..<36 {
            let color = source.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            for value in [color.redComponent, color.greenComponent, color.blueComponent, color.alphaComponent] {
                data.append(UInt8((value * 255).rounded()))
            }
        }
    }
    try data.write(to: URL(fileURLWithPath: base + ".rgba"))
}
