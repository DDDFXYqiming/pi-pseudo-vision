[简体中文](README.md) | English

# pi-pseudo-vision

> Adds "tool-layer vision" to text-only providers in **Pi Coding Agent**. Image attachments are converted to OCR text + color statistics + pixel scan + metadata on the LLM dispatch path, so any text-only model can "see" the image. Everything runs locally, **no external vision API**.

A **Pi port** of the same author's [dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision) (DeepSeek Harness plugin). All vision algorithms are preserved verbatim (color stats, meta, pixel scan, OCR + digit verification, chunked long-shot OCR); only the host integration is rewritten against Pi's extension API.

## What it does

The extension ships three things.

- Registers four `vision_*` tools (OCR / color stats / pixel scan / meta) for direct LLM use, plus a `pseudo_vision_convert` tool that aggregates them into one evidence block.
- Registers a `/pseudo-vision` command supporting `on` / `off` / `status` / `<path>` (one-shot convert of a local file).
- Provides an optional `context` event hook that swaps every `ImageContent` block in user messages for a `<pseudo-vision-context>` text block. It only acts when two conditions hold at once. `/pseudo-vision on` has been issued this session **or** the active provider is in `bridgeProviders`; and the active model declares `input: ["text"]`. **Native-vision models are never touched.**

## Tools exposed

| Tool | Purpose | Implementation |
|---|---|---|
| `vision_ocr` | Extract every text line in an image, with normalised bounding boxes; includes a digit verification pass for IP / URL / port / long numbers (`0↔6/9/8` glyph re-recognition + punctuation-preserving fusion) | `tesseract.js` (chi_sim + eng) |
| `vision_color_stats` | 9-bucket pixel share (white / black / grey / red / green / blue / yellow / cyan / magenta / other) + average luminance | `sharp` histogram |
| `vision_pixel_scan` | `mode=target` scans for a configurable colour (default red `#ff0000`); `mode=universal` shares the 512px downsample with colour stats and surfaces every non-background bucket; up to 5 rows + 5 cols per bucket | `sharp` raw pixel access |
| `vision_meta` | Dimensions, format, colour space, 4-corner + centre samples | `sharp` metadata |
| `pseudo_vision_convert` | Aggregates the four tools into a single `<pseudo-vision-context>` evidence block (same shape the auto-bridge uses) | `sharp` + `tesseract.js` |

### OCR pipeline (v5, synced with dsh-pseudo-vision)

1. **Preprocessing**. Budget resize (small/normal/large/mega, 28-grid snap) → dark-mode detection (no inversion on light themes) → greyscale → contrast stretch → salt-pepper detection (3×3 median denoise only when noise is present; clean images skip it so 1px thin strokes aren't erased) → light sharpen (σ0.3) → white border
2. **First pass**. Full-page tesseract recognition with per-line confidence; non-text blocks (image/separator) filtered
3. **Low-confidence retry**. Up to 8 regions, **text-like lines ranked first** (icon noise lines no longer exhaust the budget). Each region is cropped, upscaled 3× with Lanczos and re-read in single-block mode (PSM 6). A higher-confidence re-read replaces the main line (the evidence block is still emitted)
4. **CJK post-process**. Inter-character space merge (`通 知` → `通知`), leading icon symbol strip
5. **Digit verification**. IP/URL/port/long-number tokens re-read with an ASCII whitelist + single-line mode; punctuation keeps the first-pass skeleton, only same-length re-reads with confidence gain ≥5 are accepted; `[数字复核 N 处]` audit block

> Verified on a real settings-page screenshot. OCR used to return only the top 3 lines and lost all menu text; after the fix it returns 11 lines, with "通用设置/模型/通知" fully clean. The key fix was passing the tesseract.js PSM as a Number (the string `"3"` breaks full-page detection).

## Install

```bash
# GitHub (recommended)
pi install git:github.com/DDDFXYqiming/pi-pseudo-vision

# Local path when schannel / npm blockers hit on Windows
git clone https://github.com/DDDFXYqiming/pi-pseudo-vision.git
cd pi-pseudo-vision && npm install
pi install <local absolute path>
```

`npm install` pulls `sharp` + `tesseract.js`; no build step is needed. Pi loads TypeScript source directly through jiti.

## Usage

The four `vision_*` tools and `pseudo_vision_convert` are available to the LLM as soon as the extension loads. The `/pseudo-vision` command toggles per-session auto-bridging.

```
/pseudo-vision              # equivalent to "status": print current state
/pseudo-vision on           # turn auto-bridge on for this session
/pseudo-vision off          # turn auto-bridge off for this session
/pseudo-vision <path>       # one-shot: convert a local image and inject as follow-up
```

**Auto-bridge is off for every provider by default**, so the long-standing irritation of "native vision models silently getting demoted to pseudo-vision" never happens. To bridge a specific text-only provider, opt in explicitly via `bridgeProviders`.

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

Or enable it for a single session with `/pseudo-vision on`.

**Evidence is tiered by turn; over-limit requests degrade instead of failing.** Images from the last `fullEvidenceTurns` user turns run the full pipeline (OCR + colour + scan + meta); older-turn images degrade to compact evidence (no OCR, with a `read` pointer to the full on-disk cache); images beyond `maxImages` or the character budget keep explicit placeholders and the context ends with a `[⚠️ 图片处理摘要]` line telling the model which images did not take effect. Re-attaching an old image in a new turn restores its full tier.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `bridgeProviders` | `[]` | Provider whitelist (empty = **no** auto-bridge by default) |
| `bypassCache` | `false` | `true` forces recomputation, ignoring the on-disk cache |
| `maxImages` | `8` | Full-tier image count cap per request (OCR wall-time guard) |
| `maxTotalEvidenceChars` | `96000` | Combined evidence character cap per request (full + compact, ≈24K tokens) |
| `fullEvidenceTurns` | `2` | Recent user turns that keep full evidence; older turns degrade to compact |
| `langs` | `chi_sim+eng` | Tesseract language pack |
| `ocrBudget` | `auto` | `auto` / `small` / `normal` / `large` / `mega` |
| `ocrNoResize` | `false` | `true` skips budget resize/upscale but still runs greyscale / contrast / sharpen / white-border |
| `cacheDir` | `~/.pi/agent/cache/pi-pseudo-vision` | OCR result cache directory |

`auto` is the safe default; switch to `large` / `mega` for dense tables / small fonts, `small` to bound local CPU/memory. `ocrNoResize: true` skips the budget resize but still runs the OCR enhancement pipeline; colour stats / pixel scan / meta always read the original image.

## Effect example

A pure-text `kimi-for-coding/kimi-k2-thinking` model, with a PowerShell screenshot attached, receives this evidence.

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

The model synthesises a full description purely from this structured evidence. The `[数字复核]` block records OCR misreads and corrections, so every step is fully auditable.

## Permissions

- Reads image attachments from the conversation history (base64-decoded in-memory)
- Writes cache files to `~/.pi/agent/cache/pi-pseudo-vision/` (the cache key combines sha256 + budget + langs/no-resize flags + OCR pipeline version + scan version)
- In-process `tesseract.js` OCR + `sharp` (first run downloads language pack from the tesseract CDN, then offline)
- Modifies outgoing message context non-destructively via the `context` event hook (only when an opt-in provider is selected AND the model is text-only)

It never uploads images to any external API. Pi core, built-in tools and native-vision model routing are left untouched.

## Known limits

- Complex spatial relations and real photos get limited description precision; pseudo-vision evidence ≠ real multimodal understanding
- OCR may still misread text other than digit-critical tokens (the verification pass covers IP / URL / port / long numbers)
- Colour stats give shares only; layout and icon details cannot be reconstructed
- For large images, OCR is processed within `ocrBudget`; tall screenshots (height > 3000px) are first chunked, colour / pixel / meta still read from the original
- Low-confidence retry covers at most 3 regions; it improves small-text readability but is not image super-resolution
- Explicitly not planned are embeddings and external Vision APIs (they violate the "no model" red line), auto-routing to pseudo-vision (it must be picked explicitly, never by default), and npm publishing (installation stays via `pi install`)

Full version history in [CHANGELOG.md](./CHANGELOG.md) (TBD). The related project is [dsh-pseudo-vision](https://github.com/DDDFXYqiming/dsh-pseudo-vision) (same upstream, DeepSeek Harness). The architecture took inspiration from [oil-oil/dsh-vision](https://github.com/oil-oil/dsh-vision) (external-API route).

## License

MIT
