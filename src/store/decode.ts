/**
 * Decoding of the session store's `events.data` column.
 *
 * The SQLite persistence backend stores each event payload as JSON text, or as
 * a zstd frame compressed against a schema-pinned dictionary, or as a packed
 * physical row holding several logical chunk events. This module owns both
 * facts the row reader must apply: which rows are packed, and how a data value
 * becomes JSON text.
 * @module dsh-token-perf/store/decode
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** `ignorable` value marking one packed chunk row; scalars carry 0/1 or NULL. */
const PACKED_ROW_SENTINEL = 0

/** Event types a packed row may carry; any other type is a malformed row. */
const CHUNK_TAGS: readonly string[] = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks']

/** Turns one `events.data` column value into its stored JSON text. */
export type DataTextDecoder = (value: string | Uint8Array) => string

/**
 * Build a decoder bound to one zstd dictionary.
 *
 * The dictionary is read once per store scan and reused for every row: it is
 * the physical-format key, so a store written with a different dictionary
 * fails to decompress rather than decoding to wrong text.
 * @param dictionaryPath - absolute path of the schema's zstd dictionary.
 * @returns a decoder returning JSON text, unchanged for rows stored uncompressed.
 */
export function createDataDecoder(dictionaryPath: string): DataTextDecoder {
  const dictionary = readFileSync(dictionaryPath)
  // Non-fatal decoding would hide a corrupt frame as replacement characters.
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  return value => typeof value === 'string'
    ? value
    : utf8.decode(zstdDecompressSync(value, { dictionary }))
}

/**
 * Test whether one `events` row is a packed chunk row.
 *
 * The `ignorable` column doubles as the physical-format discriminator: only a
 * packed row carries the sentinel, and only chunk types may be packed, so a
 * sentinel on any other type means the store is not the schema this reader
 * understands.
 * @param ignorable - the row's `ignorable` column, `null` when stored NULL.
 * @param type - the row's `type` column.
 * @returns true when the row is a packed chunk row the day report must skip.
 * @throws {Error} when the packed sentinel carries a non-chunk type.
 */
export function isPackedChunkRow(ignorable: number | null, type: string): boolean {
  if (ignorable !== PACKED_ROW_SENTINEL) return false
  if (!CHUNK_TAGS.includes(type)) {
    throw new Error(`malformed ${type} storage row: packed discriminator requires a chunk tag`)
  }
  return true
}
