# pi-pseudo-vision

> Local OCR + color-statistics + pixel-scan + metadata bridge for text-only **Pi Coding Agent** models. No external vision API.

A Pi Coding Agent extension that lets **any text-only model** "see" image attachments. When the active model declares `input: ["text"]` and a `UserMessage` carries an `ImageContent` block, this extension swaps that block for a structured **local** evidence block built from four vision tools (`vision_ocr` / `vision_color_stats` / `vision_pixel_scan` / `vision_meta`). The model then describes the image from the evidence — same as DeepSeek users do today with `dsh-pseudo-vision`, but on Pi.

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line (with normalized coordinates); includes a digit verification pass for IP / URL / port / long numbers | `tesseract.js` (chi_sim + eng) |
| `vision_color_stats` | 9-bucket pixel share (white / black / grey / red / green / blue / yellow / cyan / magenta / other) + average luminance | `sharp` histogram |
| `vision_pixel_scan` | Row + column multi-bucket scan; background buckets suppressed at `≥90%`, partial bands in `[0.15, 0.90)` still surfaced; up to 5 rows + 5 cols per bucket | `sharp` raw pixel access |
| `vision_meta` | Dimensions, format, color space, 4-corner + center samples | `sharp` metadata |

The four `vision_*` tools are registered with Pi's `registerTool()` so the LLM can call them on demand when it has a file path. A `pseudo_vision_convert` tool aggregates them and returns the same evidence block used by the auto-bridge. The `context` event hook automatically converts images for text-only models when an opt-in provider is active.

## Install

```bash
pi install git:github.com:DDDFXYqiming/pi-pseudo-vision
# or, for local development:
pi install <local absolute path>
```

## Usage

Out of the box, the four `vision_*` tools are available to the LLM. Auto-conversion is **off by default** (so native vision models stay native) — opt in per session:

```
/pseudo-vision on
```

By default, auto-conversion only runs for the active provider's text-only models. To bridge additional providers explicitly, edit `settings.json`:

```json
{
  "extensions": [...],
  "pi-pseudo-vision": {
    "bridgeProviders": ["kimi-for-coding", "openai-completions"],
    "ocrBudget": "auto",
    "ocrNoResize": false,
    "maxImages": 8,
    "langs": "chi_sim+eng",
    "cacheDir": ""
  }
}
```

`auto` is the safe default; switch to `large`/`mega` for dense tables / small fonts, `small` to bound local CPU/memory. `ocrNoResize: true` skips budget resize but still runs grayscale / contrast / sharpen / white-border; color stats / pixel scan / meta always read the original image.

## Effect example

A pure-text model (e.g. text-only `kimi-for-coding/kimi-k2-thinking`), with a PowerShell screenshot attached, receives this evidence:

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

The model synthesizes a full description from this structured evidence. The `[数字复核]` block records OCR misreads and corrections — every step fully auditable.

## Architecture

```
UserMessage[ImageContent, …]
        │
        │  context event hook
        ▼
pi-pseudo-vision/imageToText() ────► [OCR + color-stats + pixel-scan + meta blocks]
        │
        ▼
UserMessage[TextContent("<pseudo-vision-context>…"), …]
        │
        ▼
text-only model reads evidence, describes image
```

The `ImageContent` block is never sent to the model. The text-only model only sees the synthesized text evidence.

## Permissions

- Reads image attachments from the conversation history (base64-decoded in-memory)
- Writes a cache file per image to `~/.pi/agent/cache/pi-pseudo-vision/` (key: sha256 + budget + langs/no-resize + OCR pipeline version + scan version)
- Spawns `tesseract.js` in-process; first run downloads language packs from the tesseract CDN, subsequent runs are fully offline
- Modifies outgoing message context non-destructively via the `context` event hook (only when an opt-in provider is selected and the model is text-only)

**Does NOT**: upload images to any external API / modify Pi core code / override any built-in tool / change native vision model behavior.

## Known limits

- Complex spatial relations / real photos: description precision is limited; pseudo-vision evidence ≠ real multimodal understanding
- OCR may still misread text other than digit-critical tokens (the verification pass covers IP / URL / port / long numbers)
- Color stats give shares only — no layout / icon reconstruction
- Large images: OCR is processed within `ocrBudget`; tall screenshots (height > 3000px) are first chunked, color / pixel / meta still read from the original
- Low-confidence retry covers at most 3 regions; it improves small-text readability but isn't image super-resolution

**Explicitly NOT planned**: embeddings / external Vision API (violates the "no model" red line) / npm publish (still installed via `pi install`) / override native vision model routing (auto-bridge is opt-in, never by default).

## License

MIT — derived from [`dsh-pseudo-vision`](https://github.com/DDDFXYqiming/dsh-pseudo-vision) for DeepSeek Harness by the same author. Vision algorithms (color stats / pixel scan / meta / OCR + digit verification + chunked OCR) are ported with minimal changes.