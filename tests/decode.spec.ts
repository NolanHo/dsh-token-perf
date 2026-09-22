import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createDataDecoder, isPackedChunkRow } from '../src/store/decode.ts'

const DICTIONARY_PATH = fileURLToPath(new URL('../src/store/zstd-dictionary.bin', import.meta.url))
const DICTIONARY = readFileSync(DICTIONARY_PATH)
const PAYLOAD = JSON.stringify({ turn: 4, step: 9, usage: { inputTokens: 11 } })

describe('createDataDecoder', () => {
  it('decodes a zstd frame the store wrote with its dictionary', () => {
    const decodeData = createDataDecoder(DICTIONARY_PATH)
    const frame = zstdCompressSync(Buffer.from(PAYLOAD), { dictionary: DICTIONARY })
    expect(decodeData(frame)).toBe(PAYLOAD)
    expect(JSON.parse(decodeData(frame))).toEqual({ turn: 4, step: 9, usage: { inputTokens: 11 } })
  })

  it('returns an uncompressed row unchanged', () => {
    const decodeData = createDataDecoder(DICTIONARY_PATH)
    expect(decodeData(PAYLOAD)).toBe(PAYLOAD)
  })

  it('rejects a frame whose text is not valid UTF-8', () => {
    const decodeData = createDataDecoder(DICTIONARY_PATH)
    const frame = zstdCompressSync(Buffer.from([0xff, 0xfe, 0xfd]), { dictionary: DICTIONARY })
    expect(() => decodeData(frame)).toThrow(TypeError)
  })
})

describe('isPackedChunkRow', () => {
  it.each(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])(
    'reports ignorable=0 %s as a packed row',
    type => {
      expect(isPackedChunkRow(0, type)).toBe(true)
    },
  )

  it('reports scalar rows as unpacked', () => {
    expect(isPackedChunkRow(1, 'user/message')).toBe(false)
    expect(isPackedChunkRow(null, 'assistant/message')).toBe(false)
    expect(isPackedChunkRow(1, 'text-chunks')).toBe(false)
  })

  it('rejects the packed sentinel on a scalar type', () => {
    expect(() => isPackedChunkRow(0, 'user/message')).toThrow(/malformed user\/message/)
    expect(() => isPackedChunkRow(0, 'assistant/message')).toThrow(/packed discriminator/)
  })
})
