[简体中文](README.md) | English

# pi-pseudo-vision

> Adds "tool-layer vision" to text-only providers in **Pi Coding Agent**: image attachments are converted to OCR text + color statistics + pixel scan + metadata on the LLM dispatch path, so any text-only model can "see" the image. Everything runs locally, **no external vision API**.

A **Pi port** of the same author's [dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision) (DeepSeek Harness plugin). All vision algorithms are preserved verbatim — color stats, meta, pixel scan, OCR + digit verification, chunked long-shot OCR — only the host integration is rewritten against Pi's extension API.

## What it does

- Registers four `vision_*` tools (OCR / color stats / pixel scan / meta) for direct LLM use, plus a `pseudo_vision_convert` tool that aggregates them into one evidence block.
- Registers a `/pseudo-vision` command with four uses: `on` / `off` / `status` / `<path>` (one-shot convert of a local file).
- Opt-in auto-bridge via the `context` event: when `/pseudo-vision on` has been issued this session OR the active provider is in `bridgeProviders`, AND the active model declares `input: ["text"]`, every `ImageContent` block is swapped for a `<pseudo-vision-context>` text block. **Native-vision models are never touched.**

## Tools exposed

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line in an image, with normalised bounding boxes; includes a digit verification pass for IP / URL / port / long numbers (`0↔6/9/8` glyph re-recognition + punctuation-preserving fusion) | `tesseract.js` (chi_sim + eng) |
| `vision_color_stats` | 9-bucket pixel share (white / black / grey / red / green / blue / yellow / cyan / magenta / other) + average luminance | `sharp` histogram |
| `vision_pixel_scan` | `mode=target` scans for a configurable colour (default red `#ff0000`); `mode=universal` shares the 512px downsample with colour stats and surfaces every non-background bucket; up to 5 rows + 5 cols per bucket | `sharp` raw pixel access |
| `vision_meta` | Dimensions, format, colour space, 4-corner + centre samples | `sharp` metadata |
| `pseudo_vision_convert` | Aggregates the four tools into a single `<pseudo-vision-context>` evidence block (same shape the auto-bridge uses) | `sharp` + `tesseract.js` |

> Digit verification (v0.5.1 of the upstream algorithm): after the first OCR pass, IP / URL / port / long-number tokens are re-read using an ASCII whitelist + PSM 7 single-line mode; punctuation positions keep the first-pass skeleton (so `127-0.0.1` won't survive — it becomes `127.0.0.1`). Only same-length re-reads with confidence gain ≥5 are accepted; the `[数字复核 N 处]` block keeps a full audit trail.

## Install

```bash
# GitHub (recommended)
pi install git:github.com:DDDFXYqiming/pi-pseudo-vision

# Local path when schannel / npm blockers hit on Windows
git clone https://github.com/DDDFXYqiming/pi-pseudo-vision.git
cd pi-pseudo-vision && npm install
pi install <local absolute path>
```

`npm install` pulls `sharp` + `tesseract.js`; no build step is needed — Pi loads TypeScript source directly through jiti.

## Usage

The four `vision_*` tools and `pseudo_vision_convert` are available to the LLM as soon as the extension loads. The `/pseudo-vision` command toggles per-session auto-bridging:

```
/pseudo-vision              # equivalent to "status": print current state
/pseudo-vision on           # turn auto-bridge on for this session
/pseudo-vision off          # turn auto-bridge off for this session
/pseudo-vision <path>       # one-shot: convert a local image and inject as follow-up
```

**Auto-bridge is off for every provider by default** — so the long-standing irritation of "native vision models silently getting demoted to pseudo-vision" never happens. To bridge a specific text-only provider, opt in explicitly via `bridgeProviders`:

```json
{
  "extensions": ["..."],
  "pi-pseudo-vision": {
    "bridgeProviders": ["kimi-for-coding"],
    "ocrBudget": "auto",
    "ocrNoResize": false,
    "maxImages": 8,
    "langs": "chi_sim+eng",
    "cacheDir": ""
  }
}
```

Or for a single session: `/pseudo-vision on`.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `bridgeProviders` | `[]` | Provider whitelist (empty = **no** auto-bridge by default) |
| `bypassCache` | `false` | `true` forces recomputation, ignoring the on-disk cache |
| `maxImages` | `8` | Maximum images converted per request |
| `langs` | `chi_sim+eng` | Tesseract language pack |
| `ocrBudget` | `auto` | `auto` / `small` / `normal` / `large` / `mega` |
| `ocrNoResize` | `false` | `true` skips budget resize/upscale but still runs greyscale / contrast / sharpen / white-border |
| `cacheDir` | `~/.pi/agent/cache/pi-pseudo-vision` | OCR result cache directory |

`auto` is the safe default; switch to `large` / `mega` for dense tables / small fonts, `small` to bound local CPU/memory. `ocrNoResize: true` skips the budget resize but still runs the OCR enhancement pipeline; colour stats / pixel scan / meta always read the original image.

## Effect example

A pure-text `kimi-for-coding/kimi-k2-thinking` model, with a PowerShell screenshot attached, receives this evidence:

```
[pi-pseudo-vision] sha256=b290f3d7e212 budget=normal 原图:image/png 187415B 预处理:灰度+反色 1196×636 238744B
[OCR chi_sim+eng] 12 行
  · "dsh web: http://127.0.0.1:3080"  x=0.128 y=0.230
  · "dsh web: opening the default browser; pass --no-open to disable"  x=0.251 y=0.262
  · …
[数字复核 2 处]
  · y=0.230 "http://127.6.6.1:3080" → "http://127.0.0.1:3080"（置信度 34→66）
  · y=0.413 "http://127.9.6.1:3689" → "http://127.0.0.1:3080"（置信度 38→85）
[颜色统计] 总像素 760896  · 平均亮度 57.5/255  · grey 94.3%  · white 4.9%
[像素扫描] 476×512 背景豁免:grey 27 条命中（行 14 / 列 13）
  · 行 y=0.0%  white  99.8%  · 列 x=0.2%  white  71.4%  · …
[元信息] 尺寸 1184×608  png  sRGB
  · [TL] #282c34 (深灰)  · [C] #282c34 (深灰)  · …
```

The model synthesises a full description purely from this structured evidence — the `[数字复核]` block records OCR misreads and corrections, every step fully auditable.

## Permissions

- Reads image attachments from the conversation history (base64-decoded in-memory)
- Writes cache files to `~/.pi/agent/cache/pi-pseudo-vision/` (key: sha256 + budget + langs/no-resize flags + OCR pipeline version + scan version)
- In-process `tesseract.js` OCR + `sharp` (first run downloads language pack from the tesseract CDN, then offline)
- Modifies outgoing message context non-destructively via the `context` event hook (only when an opt-in provider is selected AND the model is text-only)

**Does NOT**: upload images to any external API / modify Pi core / override any built-in tool / change native-vision model routing.

## Known limits

- Complex spatial relations / real photos: description precision is limited; pseudo-vision evidence ≠ real multimodal understanding
- OCR may still misread text other than digit-critical tokens (the verification pass covers IP / URL / port / long numbers)
- Colour stats give shares only — no layout / icon reconstruction
- Large images: OCR is processed within `ocrBudget`; tall screenshots (height > 3000px) are first chunked, colour / pixel / meta still read from the original
- Low-confidence retry covers at most 3 regions; it improves small-text readability but is not image super-resolution
- **Explicitly NOT planned**: embeddings / external Vision API (violates the "no model" red line) / auto-route to pseudo-vision (must be picked explicitly, never by default) / npm publish (still installed via `pi install`)

Full version history in [CHANGELOG.md](./CHANGELOG.md) (TBD). Related: [dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision) (same upstream, DeepSeek Harness); architectural inspiration [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision) (external-API route).

## License

MIT