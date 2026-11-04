// Regenerate the static website icons on macOS: swift scripts/generate-brand-icons.swift
// Uses the same Arial Bold lettering and colors as .brand-icon; no runtime fonts.
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let font = CTFontCreateWithName("Arial-BoldMT" as CFString, 24 * 64 / 33, nil)
let characters = Array("n.".utf16)
var glyphs = [CGGlyph](repeating: 0, count: characters.count)
CTFontGetGlyphsForCharacters(font, characters, &glyphs, characters.count)
var advances = [CGSize](repeating: .zero, count: glyphs.count)
CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, glyphs.count)
let lettering = CGMutablePath()
var cursor: CGFloat = 0
for (index, glyph) in glyphs.enumerated() {
    if let outline = CTFontCreatePathForGlyph(font, glyph, nil) {
        lettering.addPath(outline, transform: CGAffineTransform(translationX: cursor, y: 0))
    }
    cursor += advances[index].width - 0.8 * 64 / 33
}
let bounds = lettering.boundingBoxOfPath
let positioned = CGMutablePath()
positioned.addPath(lettering, transform: CGAffineTransform(translationX: (64 - bounds.width) / 2 - bounds.minX, y: 14.5))

func number(_ value: CGFloat) -> String { String(format: "%.3f", Double(value)) }
func point(_ value: CGPoint) -> String { "\(number(value.x)) \(number(value.y))" }
var outline = ""
positioned.applyWithBlock { element in
    let e = element.pointee
    switch e.type {
    case .moveToPoint: outline += "M\(point(e.points[0]))"
    case .addLineToPoint: outline += "L\(point(e.points[0]))"
    case .addQuadCurveToPoint: outline += "Q\(point(e.points[0])) \(point(e.points[1]))"
    case .addCurveToPoint: outline += "C\(point(e.points[0])) \(point(e.points[1])) \(point(e.points[2]))"
    case .closeSubpath: outline += "Z"
    @unknown default: fatalError("Unsupported path element")
    }
}
let svg = """
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="19.394" fill="#d5eabc"/>
  <path fill="#204739" transform="translate(0 64) scale(1 -1)" d="\(outline)"/>
</svg>

"""
try svg.write(toFile: "src/app/icon.svg", atomically: true, encoding: .utf8)

func png(_ size: Int) -> Data {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: CGFloat(size) / 64, y: CGFloat(size) / 64)
    context.setFillColor(CGColor(red: 213 / 255, green: 234 / 255, blue: 188 / 255, alpha: 1))
    context.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 64, height: 64), cornerWidth: 64 * 10 / 33, cornerHeight: 64 * 10 / 33, transform: nil))
    context.fillPath()
    context.setFillColor(CGColor(red: 32 / 255, green: 71 / 255, blue: 57 / 255, alpha: 1))
    context.addPath(positioned)
    context.fillPath()
    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    return output as Data
}
func littleEndian(_ value: Int, bytes: Int) -> Data {
    Data((0..<bytes).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
}
let sizes = [16, 32, 48, 64, 128, 256]
let images = sizes.map(png)
var ico = littleEndian(0, bytes: 2) + littleEndian(1, bytes: 2) + littleEndian(sizes.count, bytes: 2)
var offset = 6 + 16 * sizes.count
for (size, data) in zip(sizes, images) {
    ico += Data([UInt8(truncatingIfNeeded: size), UInt8(truncatingIfNeeded: size), 0, 0])
    ico += littleEndian(1, bytes: 2) + littleEndian(32, bytes: 2)
    ico += littleEndian(data.count, bytes: 4) + littleEndian(offset, bytes: 4)
    offset += data.count
}
for data in images { ico += data }
try ico.write(to: URL(fileURLWithPath: "src/app/favicon.ico"))
try png(180).write(to: URL(fileURLWithPath: "src/app/apple-icon.png"))
print("Generated matching SVG, favicon.ico (16–256 px), and Apple touch icon.")
