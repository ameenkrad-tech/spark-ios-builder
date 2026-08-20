import AppKit

// Renders a 1024×1024 app icon: a vibrant per-app gradient with a big WHITE SF Symbol (or a single
// initial fallback), auto-fit. Matches the client's NativeProject.makeAppIconPNG. AppKit (macOS/CI).
// Usage: swift icongen.swift <out.png> <AppName> [sf-symbol-name]
func makeIcon(name: String, symbol: String?) -> Data {
    let side: CGFloat = 1024
    let seed = name.unicodeScalars.reduce(5381) { ($0 &* 33 &+ Int($1.value)) & 0x7fffffff }
    let hue = CGFloat(seed % 360) / 360.0
    let top = NSColor(hue: hue, saturation: 0.68, brightness: 0.98, alpha: 1)
    let bot = NSColor(hue: (hue + 0.06).truncatingRemainder(dividingBy: 1.0), saturation: 0.90, brightness: 0.60, alpha: 1)
    // Explicit 1024×1024 OPAQUE bitmap (iOS icons must be exactly this size with no alpha).
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let gctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = gctx
    let ctx = gctx.cgContext
    let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [top.cgColor, bot.cgColor] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: side * 0.15, y: side), end: CGPoint(x: side * 0.85, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    let box = side * 0.52
    if let symbol,
       let raw = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: box, weight: .semibold).applying(.init(paletteColors: [.white]))) {
        let s = min(box / max(raw.size.width, 1), box / max(raw.size.height, 1))
        let w = raw.size.width * s, h = raw.size.height * s
        raw.draw(in: NSRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
    } else {
        let letter = String((name.first.map(String.init) ?? "A")).uppercased() as NSString
        var size: CGFloat = 640
        let para = NSMutableParagraphStyle(); para.alignment = .center
        var attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: .heavy), .foregroundColor: NSColor.white, .paragraphStyle: para]
        var ts = letter.size(withAttributes: attrs)
        let maxDim = side * 0.62
        if max(ts.width, ts.height) > maxDim {
            size *= maxDim / max(ts.width, ts.height)
            attrs[.font] = NSFont.systemFont(ofSize: size, weight: .heavy)
            ts = letter.size(withAttributes: attrs)
        }
        letter.draw(in: NSRect(x: (side - ts.width) / 2, y: (side - ts.height) / 2, width: ts.width, height: ts.height), withAttributes: attrs)
    }
    gctx.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let name = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "App"
let symbol = (CommandLine.arguments.count > 3 && !CommandLine.arguments[3].isEmpty) ? CommandLine.arguments[3] : nil
do { try makeIcon(name: name, symbol: symbol).write(to: URL(fileURLWithPath: out)); print("wrote \(out)") }
catch { FileHandle.standardError.write("icongen failed: \(error)\n".data(using: .utf8)!); exit(1) }
