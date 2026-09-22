# Third-party notices

`dsh-token-perf` is Apache-2.0 (see [`LICENSE`](LICENSE)). It contains one third-party file and reimplements one documented metric definition; both are recorded here.

## Vendored file: `src/store/zstd-dictionary.bin`

| | |
|---|---|
| Origin | DeepSeek Harness — `deepseek-ai/deepseek-harness`, `packages/session/session-persistence-sqlite/resources/zstd-dictionary.bin` |
| Version | `v0.1.5-rc.2` |
| License | MIT, Copyright (c) 2026 DeepSeek |
| Copy | Verbatim, byte for byte; no modification |
| sha256 | `dad18fa0247a8fdd886a62d8552eabd36cbd50c25af172873080d2f0ae770d17` |
| Size | 65409 bytes |

**Why it is vendored.** The SQLite session store compresses each `events.data` payload as zstd **with a dictionary** (`zstdDecompressSync(payload, { dictionary })`). Without those exact bytes a payload cannot be decoded at all, and no runtime API of the harness exposes the dictionary: it is a resource file inside the `session-persistence-sqlite` package, and a machine that installs this plugin as a profile package has no harness checkout to read it from. Shipping the bytes inside this package is what makes the reader self-contained. The default path is resolved next to the built entry (`lib/zstd-dictionary.bin`) and can be overridden with the `dictionaryPath` Config field.

The copy is tied to session-store schema version 20. A harness release that changes the store's compression would ship a different dictionary; the reader's schema-version guard rejects such a store with `unsupported-schema` before decoding any payload, and a new dictionary must be vendored (with an updated hash above) before the plugin can read it.

The full MIT license text covering this file:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Metric definitions

The token accounting in this plugin — folding provider usage samples per `(session, turn, step)` with later samples replacing earlier ones, clearing a slot on `llm/retry-started`, reading a sample from `assistant/message`'s `usage` or from the last usage chunk of `assistant/attempt`'s stream, and mapping the provider fields onto the `input`/`output`/`cacheRead`/`cacheWrite`/`reasoning` buckets — mirrors the documented semantics of DeepSeek Harness's own `tokenUsage` projection (`packages/llm/token-meter/src/usage-projection.ts`).

That is an **independent reimplementation of the projection's semantics, not copied code**: no DeepSeek Harness source file is included in this package. The plugin shares no module with the harness, reads only the session store's data, and stays aligned with the projection by construction so that its numbers are comparable with the harness's own accounting.
