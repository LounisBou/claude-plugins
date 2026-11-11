// The PNG files Playwright writes, read without a dependency: 8-bit RGB or RGBA, not interlaced,
// every row filter. A diff image is read for what its comparator paints: each differing pixel in
// pure red, every other one grey (r = g = b) or, anti-aliasing it forgave, yellow. Two captures
// are also compared byte for byte, the diff painted the same way, and written as an RGBA PNG.
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { DriftError } from './compare.ts'

export interface Image {
  readonly width: number
  readonly height: number
  /** RGBA, four bytes a pixel, row after row. */
  readonly data: Buffer
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Colour types read: 2 is RGB, 6 is RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 2: 3, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A PNG's pixels as RGBA; a tool error for a file that is not one, or not of the kinds read. */
export function decodePng(file: Buffer): Image {
  if (file.length < 33 || !file.subarray(0, 8).equals(SIGNATURE)) throw new DriftError('not a PNG')
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  for (let at = 8; ;) {
    if (at + 8 > file.length) throw new DriftError('a truncated PNG')
    const length = file.readUInt32BE(at)
    const type = file.toString('ascii', at + 4, at + 8)
    const body = file.subarray(at + 8, at + 8 + length)
    if (body.length !== length) throw new DriftError('a truncated PNG')
    at += 12 + length
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8] ?? 0
      const colour = body[9] ?? 0
      channels = depth === 8 ? CHANNELS[colour] ?? 0 : 0
      if (channels === 0) throw new DriftError(`a PNG of bit depth ${depth}, colour type ${colour}: only 8-bit RGB and RGBA are read`)
      if (body[12] !== 0) throw new DriftError('an interlaced PNG: not read')
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
  }
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(data))
  } catch {
    throw new DriftError('a PNG whose image data does not inflate')
  }
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new DriftError('a truncated PNG')
  const rows = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? rows[y * stride + i - channels] ?? 0 : 0
      const b = y > 0 ? rows[(y - 1) * stride + i] ?? 0 : 0
      const c = i >= channels && y > 0 ? rows[(y - 1) * stride + i - channels] ?? 0 : 0
      let predictor: number
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) predictor = paeth(a, b, c)
      else throw new DriftError(`a PNG row of unknown filter ${filter ?? 'none'}`)
      rows[y * stride + i] = ((line[i] ?? 0) + predictor) & 0xff
    }
  }
  if (channels === 4) return { width, height, data: rows }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) rgba.set([rows[i * 3] ?? 0, rows[i * 3 + 1] ?? 0, rows[i * 3 + 2] ?? 0, 255], i * 4)
  return { width, height, data: rgba }
}

/** The smallest box around the pixels `differs` names, and their count. */
function boxOf(width: number, height: number, differs: (at: number) => boolean): { pixels: number; box?: Box } {
  let pixels = 0
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!differs((y * width + x) * 4)) continue
      pixels++
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return pixels === 0 ? { pixels } : { pixels, box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } }
}

/** The differing pixels of a diff image: their count, and the box around them when there is one. */
export function diffOf(file: Buffer): { pixels: number; box?: Box } {
  const { width, height, data } = decodePng(file)
  return boxOf(width, height, at => data[at] === 255 && data[at + 1] === 0 && data[at + 2] === 0)
}

/** How much of the base's darkness a diff image keeps around its red pixels. */
const FADE = 0.1
const RED = [255, 0, 0, 255]

/**
 * Two images compared byte for byte, no pixel forgiven, on a canvas of the larger width and
 * height, where a pixel past one image's edge is transparent: the pixels whose RGBA differ, the box
 * around them, and a diff image painting each one red over the base (else the head) in faded grey.
 */
export function exactDiff(base: Image, head: Image): { pixels: number; box?: Box; image: Image } {
  const width = Math.max(base.width, head.width)
  const height = Math.max(base.height, head.height)
  const pixel = (image: Image, at: number): number => {
    const x = (at / 4) % width
    const y = Math.floor(at / 4 / width)
    return x < image.width && y < image.height ? image.data.readUInt32BE((y * image.width + x) * 4) : 0
  }
  const differs = (at: number): boolean => pixel(base, at) !== pixel(head, at)
  const data = Buffer.alloc(width * height * 4)
  for (let at = 0; at < data.length; at += 4) {
    const shown = pixel(base, at) !== 0 ? pixel(base, at) : pixel(head, at)
    const lightness = ((shown >>> 24) + ((shown >>> 16) & 0xff) + ((shown >>> 8) & 0xff)) / 3
    const grey = 255 - Math.round((255 - lightness) * FADE)
    data.set(differs(at) ? RED : [grey, grey, grey, 255], at)
  }
  return { ...boxOf(width, height, differs), image: { width, height, data } }
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** An image as an 8-bit RGBA PNG, every row unfiltered. */
export function encodePng(image: Image): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = image.width * 4
  const rows = Buffer.alloc(image.height * (stride + 1))
  for (let y = 0; y < image.height; y++) image.data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** A PNG's size from its header alone. */
export function sizeOfPng(file: Buffer): { width: number; height: number } {
  if (file.length < 24 || !file.subarray(0, 8).equals(SIGNATURE)) throw new DriftError('not a PNG')
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) }
}
