# Third-party browser assets

The files under `vendor/` are upstream runtime distributions and model assets. They are not original FeelyReader source code. Preserve the licenses and notices alongside the corresponding files when redistributing the site.

## npm runtime packages

The following pinned archives were downloaded from the official npm registry. Their SHA-512 digests were checked against each version's registry `dist.integrity` during download. Files were then copied individually from regular archive members after validating member paths and rejecting links and special files; no unchecked archive extraction was used.

| Component | Version | Archive source | License | Installed files |
| --- | --- | --- | --- | --- |
| Tesseract.js | `6.0.1` | [Official npm archive](https://registry.npmjs.org/tesseract.js/-/tesseract.js-6.0.1.tgz), [upstream project](https://github.com/naptha/tesseract.js) | Apache-2.0; bundled notices also include MIT and BSD-3-Clause components | `vendor/tesseract/tesseract.min.js`, `worker.min.js`, `LICENSE`, and the original `*.LICENSE.txt` notices |
| Tesseract.js core | `6.0.0` | [Official npm archive](https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-6.0.0.tgz), [upstream project](https://github.com/naptha/tesseract.js-core) | Apache-2.0 | `vendor/tesseract/core/tesseract-core-lstm.wasm.js`, `.wasm`, `tesseract-core-simd-lstm.wasm.js`, `.wasm`, and `LICENSE` |
| MediaPipe Hands | `0.4.1675469240` | [Official npm archive](https://registry.npmjs.org/@mediapipe/hands/-/hands-0.4.1675469240.tgz), [upstream project](https://github.com/google-ai-edge/mediapipe) | Apache-2.0, as declared by the published package | `vendor/mediapipe/hands.js`, graph/model/data files, SIMD and non-SIMD JS/WASM runtimes |
| OpenCV.js | `@techstark/opencv-js@4.11.0-release.1` | [Official npm archive](https://registry.npmjs.org/@techstark/opencv-js/-/opencv-js-4.11.0-release.1.tgz), [packaging project](https://github.com/TechStark/opencv-js), [OpenCV project](https://github.com/opencv/opencv) | Apache-2.0 | `vendor/opencv/opencv.js`, including its embedded WASM, and `LICENSE` |

Tesseract.js bundle notices are retained as `vendor/tesseract/tesseract.min.js.LICENSE.txt` and `vendor/tesseract/worker.min.js.LICENSE.txt`. These identify regenerator-runtime, buffer, ieee754, and zlib.js notices present in the upstream distributions.

The MediaPipe npm archive does not contain a standalone license text. `vendor/mediapipe/PACKAGE-LICENSE.txt` records the archive's declared license and provenance. `vendor/mediapipe/LICENSE` contains the standard Apache License 2.0 text, copied verbatim from the verified OpenCV npm package's `LICENSE`; it is not presented as a file extracted from the MediaPipe archive. Original MediaPipe notices remain in its runtime files.

The OpenCV archive's registry SHA-512 integrity value is `sha512-d5h8cMiSbbnme5+I1ta4++EJ3mkca1zkVNh0A4+5ASJYOmO5OhVPRX3oPnNzs9I3KyGVX7QeFU8gVoI7I0w8RQ==`. The installed `opencv.js` is **11,386,540 bytes**, SHA-256 `5ad229d2666fce6803a3af4a569121bd6da8d09d5c164dbafb0d7f758460c25e`. The blocked docs.opencv.org download and the author's original OpenCV copy are not included in the distribution.

## Tesseract language models

Both language files are the official LSTM models from the fixed [`tesseract-ocr/tessdata_fast` tag `4.1.0`](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0), distributed under Apache-2.0. They are stored without gzip compression.

| Installed file | Official source | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `vendor/tesseract/lang/chi_sim.traineddata` | [Simplified Chinese model](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/chi_sim.traineddata) | 2,469,156 | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |
| `vendor/tesseract/lang/eng.traineddata` | [English model](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata) | 4,113,088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |
| `vendor/tesseract/lang/LICENSE` | [License from the same tag](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/LICENSE) | 11,358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |

## Tesseract LSTM runtime selection

The pinned Tesseract.js v6 `createWorker` defaults to `OEM.LSTM_ONLY`. With `legacyCore` disabled, its browser core loader selects exactly one of `tesseract-core-lstm.wasm.js` and `tesseract-core-simd-lstm.wasm.js`, depending on SIMD support. Both corresponding WASM files are included. Legacy Tesseract-only and combined legacy/LSTM modes are outside this packaged runtime selection.

Use local `workerPath`, `corePath`, and `langPath` settings. The packaged plain `.traineddata` language files require `gzip: false`.

## Offline verification

The Tesseract.js, Tesseract core, and MediaPipe files copied from their three archives total **38,276,371 bytes** across 21 files, excluding the separately supplied MediaPipe license files and the separate OpenCV package. The largest of those files is `hands_solution_simd_wasm_bin.wasm`, **6,026,259 bytes**. The OpenCV runtime is **11,386,540 bytes**; every installed runtime file remains below GitHub's 100 MiB single-file limit.

The local preparation report `outputs/web-assets/offline-vendor-manifest.json` records the SHA-256 digest and size of each copied file. `outputs/` is an ignored preparation directory and is not required by the published site.

Both Tesseract core variants were loaded with Node, instantiated their actual WebAssembly modules, and constructed `TessBaseAPI` with working `Init`/`End` methods. Integrated browser recognition was also verified in Edge at the local project subpath: four Chinese/English lines and a rotated two-page input containing eight lines were recognized, with no JavaScript or network errors in that check. This is a desktop integration check; target-phone performance still needs device testing.

The OpenCV package was also initialized with Node. A real `Mat` could be created and the required `findContours`, `warpPerspective`, `goodFeaturesToTrack`, `calcOpticalFlowPyrLK`, `findHomography`, and `invert` APIs were available. These checks verify initialization and API availability, not real-camera detection or tracking accuracy.
