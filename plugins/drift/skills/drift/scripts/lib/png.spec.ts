import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { DriftError } from './compare.ts'
import { decodePng, diffOf, encodePng, exactDiff, sizeOfPng, type Image } from './png.ts'

/** An 8-bit PNG of `image` (RGBA, or RGB when `rgb`), every row written with `filter`. */
function encode(image: Image, filter: number, rgb = false): Buffer {
  const channels = rgb ? 3 : 4
  const stride = image.width * channels
  const raw: number[] = []
  let previous = new Array<number>(stride).fill(0)
  for (let y = 0; y < image.height; y++) {
    const row: number[] = []
    for (let x = 0; x < image.width; x++) for (let c = 0; c < channels; c++) row.push(image.data[(y * image.width + x) * 4 + c] ?? 0)
    raw.push(filter)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] ?? 0 : 0
      const b = previous[i] ?? 0
      const c = i >= channels ? previous[i - channels] ?? 0 : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0
      raw.push(((row[i] ?? 0) - predictor) & 0xff)
    }
    previous = row
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = rgb ? 2 : 6
  const compressed = deflateSync(Buffer.from(raw))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', compressed.subarray(0, 5)),
    chunk('IDAT', compressed.subarray(5)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A grey image with the given pixels painted. */
function image(width: number, height: number, painted: ReadonlyArray<readonly [number, number, number, number, number]> = []): Image {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set([200 + (i % 7), 200, 200, 255], i * 4)
  for (const [x, y, r, g, b] of painted) data.set([r, g, b, 255], (y * width + x) * 4)
  return { width, height, data }
}

test('every row filter decodes to the pixels encoded, RGBA and RGB', () => {
  const source = image(5, 4, [[1, 1, 10, 20, 30], [4, 3, 250, 0, 9]])
  for (const filter of [0, 1, 2, 3, 4]) {
    assert.deepEqual(decodePng(encode(source, filter)), source, `filter ${filter}`)
    assert.deepEqual(decodePng(encode(source, filter, true)), source, `filter ${filter}, RGB`)
  }
})

test('a diff image reads its red pixels: their count and the box around them', () => {
  const red: Array<[number, number, number, number, number]> = [[2, 1, 255, 0, 0], [6, 4, 255, 0, 0], [3, 3, 255, 0, 0]]
  assert.deepEqual(diffOf(encode(image(8, 6, [...red, [0, 0, 255, 255, 0]]), 4)), { pixels: 3, box: { x: 2, y: 1, width: 5, height: 4 } })
  assert.deepEqual(diffOf(encode(image(8, 6, [[7, 5, 255, 0, 0]]), 1)), { pixels: 1, box: { x: 7, y: 5, width: 1, height: 1 } })
  assert.deepEqual(diffOf(encode(image(3, 3), 0)), { pixels: 0 })
  assert.deepEqual(sizeOfPng(encode(image(7, 2), 0)), { width: 7, height: 2 })
  assert.throws(() => sizeOfPng(Buffer.from('short')), /not a PNG/)
})

test('what is not an 8-bit, non-interlaced RGB or RGBA PNG is refused', () => {
  const good = encode(image(2, 2), 0)
  assert.throws(() => decodePng(Buffer.from('nope')), (e: unknown) => e instanceof DriftError && /not a PNG/.test(e.message))
  const deep = Buffer.from(good)
  deep[24] = 16
  assert.throws(() => decodePng(deep), /PNG of bit depth 16, colour type 6/)
  const interlaced = Buffer.from(good)
  interlaced[28] = 1
  assert.throws(() => decodePng(interlaced), /interlaced/)
  const truncated = good.subarray(0, good.length - 20)
  assert.throws(() => decodePng(truncated), /truncated|not a PNG/)
  const bad = encode(image(2, 2), 0)
  const idat = bad.indexOf('IDAT')
  bad[idat + 7] = 9
  assert.throws(() => decodePng(bad), DriftError)
})

test('two captures compared byte for byte: a one-pixel-wide grey column a shade darker is every pixel of it', () => {
  const column = (grey: number): Image => image(6, 5, [0, 1, 2, 3, 4].map(y => [2, y, grey, grey, grey] as const))
  const { pixels, box, image: diff } = exactDiff(column(128), column(100))
  assert.equal(pixels, 5)
  assert.deepEqual(box, { x: 2, y: 0, width: 1, height: 5 })
  assert.deepEqual(diffOf(encodePng(diff)), { pixels: 5, box: { x: 2, y: 0, width: 1, height: 5 } })
  assert.deepEqual(exactDiff(column(128), column(128)).pixels, 0)
  assert.deepEqual(exactDiff(column(128), column(128)).box, undefined)
  const taller = exactDiff(image(2, 2), image(2, 3))
  assert.deepEqual([taller.pixels, taller.box, taller.image.width, taller.image.height], [2, { x: 0, y: 2, width: 2, height: 1 }, 2, 3])
})

test('an image written as a PNG reads back the same', () => {
  const source = image(9, 4, [[8, 3, 1, 2, 3]])
  assert.deepEqual(decodePng(encodePng(source)), source)
})
