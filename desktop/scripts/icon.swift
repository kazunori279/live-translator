// Recreate the desktop UI's 文 ↔ A mark as a macOS app icon.
import AppKit
let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 237/255, green: 242/255, blue: 1, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 220, yRadius: 220).fill()
let blue = NSColor(calibratedRed: 56/255, green: 106/255, blue: 232/255, alpha: 1)
let text = NSMutableAttributedString(string: "文", attributes: [.font: NSFont.systemFont(ofSize: 270, weight: .bold), .foregroundColor: blue])
text.append(NSAttributedString(string: " ↔ ", attributes: [.font: NSFont.systemFont(ofSize: 160, weight: .bold), .foregroundColor: blue]))
text.append(NSAttributedString(string: "A", attributes: [.font: NSFont.systemFont(ofSize: 270, weight: .bold), .foregroundColor: blue]))
let bounds = text.size()
text.draw(at: NSPoint(x: (1024 - bounds.width)/2, y: (1024 - bounds.height)/2))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
