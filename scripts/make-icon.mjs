/**
 * Draws `build/icon.png`, the app mark electron-builder derives every platform
 * icon from: the triple chevron — three `❯` strokes in the accent, each fainter
 * than the last — centred on the app's near-black rounded square.
 *
 * It is generated rather than hand-drawn, and generated with nothing but Node's
 * own zlib: adding a raster toolchain (or checking in a binary nobody can diff)
 * to produce one 1024px square is a poor trade. The output IS committed, so a
 * normal `pnpm package:*` never has to run this.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
/** Corner radius of the plate, as macOS-ish as a square icon gets. */
const CORNER = 200
/** tokens.css --bg */
const PLATE = [0x1c, 0x1c, 0x1f]
/** tokens.css --accent */
const ACCENT = [0xf0, 0x52, 0x19]

/** Half the stroke width; the caps are round because a capsule is round. */
const STROKE_HALF = 29
/** The three chevrons, front to back. */
const CHEVRONS = [
  { apexX: 397, opacity: 1 },
  { apexX: 577, opacity: 0.65 },
  { apexX: 757, opacity: 0.35 }
]
/** How far each arm reaches back and up/down from its apex. */
const ARM_X = 130
const ARM_Y = 150

/* === geometry =============================================================== */

/** Distance from a point to a segment — a capsule's field, so caps are round. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const lengthSq = abx * abx + aby * aby
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSq))
  const dx = px - (ax + abx * t)
  const dy = py - (ay + aby * t)
  return Math.hypot(dx, dy)
}

/** Signed distance to a rounded square, negative inside. */
function distanceToRoundedSquare(px, py, size, radius) {
  const dx = Math.abs(px - size / 2) - (size / 2 - radius)
  const dy = Math.abs(py - size / 2) - (size / 2 - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** One pixel of anti-aliasing either side of the edge. */
function coverageFromDistance(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance))
}

function chevronSegments({ apexX }) {
  const midY = SIZE / 2
  return [
    [apexX - ARM_X, midY - ARM_Y, apexX, midY],
    [apexX, midY, apexX - ARM_X, midY + ARM_Y]
  ]
}

/* === raster ================================================================= */

function renderPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const strokes = CHEVRONS.map((chevron) => ({
    opacity: chevron.opacity,
    segments: chevronSegments(chevron)
  }))

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const plate = coverageFromDistance(distanceToRoundedSquare(px, py, SIZE, CORNER))
      let red = PLATE[0]
      let green = PLATE[1]
      let blue = PLATE[2]
      let alpha = plate

      for (const stroke of strokes) {
        let nearest = Infinity
        for (const [ax, ay, bx, by] of stroke.segments) {
          nearest = Math.min(nearest, distanceToSegment(px, py, ax, ay, bx, by))
        }
        // Clipped to the plate so a stroke can never spill past a rounded corner.
        const ink = coverageFromDistance(nearest - STROKE_HALF) * stroke.opacity * plate
        if (ink <= 0) continue
        red = red + (ACCENT[0] - red) * ink
        green = green + (ACCENT[1] - green) * ink
        blue = blue + (ACCENT[2] - blue) * ink
        alpha = Math.max(alpha, ink)
      }

      const at = (y * SIZE + x) * 4
      pixels[at] = Math.round(red)
      pixels[at + 1] = Math.round(green)
      pixels[at + 2] = Math.round(blue)
      pixels[at + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

/* === PNG encoding =========================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  // compression, filter and interlace methods: the only values PNG defines
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // One filter byte per scanline; filter 0 (none) keeps the encoder honest and
  // costs little once deflate has seen the long runs of flat plate colour.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1)
    raw[at] = 0
    pixels.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* === main =================================================================== */

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
await mkdir(buildDir, { recursive: true })
const file = path.join(buildDir, 'icon.png')
await writeFile(file, encodePng(renderPixels(), SIZE))
console.log(`wrote ${file} (${SIZE}x${SIZE})`)
