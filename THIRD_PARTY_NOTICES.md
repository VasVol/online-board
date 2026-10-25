# Third-party software

Поле embeds `@excalidraw/excalidraw` (MIT), `yjs`, `y-websocket`, `y-indexeddb`, `y-protocols`, React, Express, better-sqlite3, ws and their dependencies. Dependency versions are fixed by `package-lock.json`; preserve upstream copyright notices and licenses when distributing builds.

## Excalidraw

Source: https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE

MIT License

Copyright (c) 2020 Excalidraw

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

## Excalidraw renderer adaptation

`scripts/patch-excalidraw.mjs` reproducibly changes two freehand options in both dev and production bundles of 0.18.1: `size = strokeWidth` and `thinning = 0`. This disables pressure-dependent width while retaining upstream smoothing, input, history and rendering/export code. It is applied on installation and verified before dev/build/browser tests. Unknown versions or changed code fail explicitly. Original licenses remain in the dependency. See `docs/UNIFORM_PEN.md`.

## Dependency overrides

The SDK pins older transitive libraries. This project overrides nanoid (SDK: 3.3.20, mermaid adapter: 5.1.16), lodash-es (4.18.1), and KaTeX (0.18.2) to remove advisories present in the unmodified dependency tree on 2026-10-24. `npm audit` reported zero known advisories after a clean `npm ci`. These overrides are deliberate: re-check the production build and browser tests when changing them. Mermaid-specific import is not part of this application's tested feature set.
