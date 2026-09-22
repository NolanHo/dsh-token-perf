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
/** Turns one `events.data` column value into its stored JSON text. */
export type DataTextDecoder = (value: string | Uint8Array) => string;
/**
 * Build a decoder bound to one zstd dictionary.
 *
 * The dictionary is read once per store scan and reused for every row: it is
 * the physical-format key, so a store written with a different dictionary
 * fails to decompress rather than decoding to wrong text.
 * @param dictionaryPath - absolute path of the schema's zstd dictionary.
 * @returns a decoder returning JSON text, unchanged for rows stored uncompressed.
 */
export declare function createDataDecoder(dictionaryPath: string): DataTextDecoder;
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
export declare function isPackedChunkRow(ignorable: number | null, type: string): boolean;
