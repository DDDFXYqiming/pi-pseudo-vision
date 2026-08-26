/**
 * pi-pseudo-vision — local OCR + color-stats + pixel-scan + metadata bridge
 * for text-only Pi Coding Agent models.
 *
 * Strategy:
 *  - Register four `vision_*` tools so the LLM can call them directly on a
 *    file path (no auto-conversion needed; the model opts in per call).
 *  - Register a `pseudo_vision_convert` tool that aggregates the four tools
 *    and returns a single structured evidence block (same shape used by the
 *    auto-bridge path).
 *  - Opt-in auto-conversion: a `context` event hook swaps `ImageContent`
 *    blocks for `<pseudo-vision-context>` text blocks ONLY when:
 *      1) `/pseudo-vision on` has been issued this session, OR
 *         `bridgeProviders` config explicitly contains the current provider, AND
 *      2) the active model declares `input: ["text"]` (no native vision).
 *  - Native-vision models are NEVER touched (this is the whole point).
 *
 * Ported from dsh-pseudo-vision by the same author.
 */

import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/** Local alias for the messages list shape we walk in the context event. */
type MsgLike = {
    role: string;
    content: string | ReadonlyArray<{ type: string }>;
    timestamp?: number;
    [key: string]: unknown;
};

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { imageToText, sha256Of } from "./bridge.ts";
import { disposeOcr } from "./vision/ocr.ts";
import { computeColorStats, formatColorStatsBlock } from "./vision/color-stats.ts";
import { readMeta, formatMetaBlock } from "./vision/meta.ts";
import { pixelScan, formatPixelScanBlock, pixelScanUniversal, formatUniversalScanBlock } from "./vision/pixel-scan.ts";
import {
    collectImagePayloads,
    imageKey,
    replaceImagesInMessages,
    appendVisionContext,
    latestUserTask,
} from "./content.ts";

/** Per-session mutable state. */
interface SessionState {
    /** `/pseudo-vision on` was issued this session. */
    autoConvert: boolean;
    /** Converted at most this many images in the current request. */
    lastRequestCount: number;
}

const sessionStates = new WeakMap<object, SessionState>();

function getState(pi: ExtensionAPI): SessionState {
    let state = sessionStates.get(pi as unknown as object);
    if (state === undefined) {
        state = { autoConvert: false, lastRequestCount: 0 };
        sessionStates.set(pi as unknown as object, state);
    }
    return state;
}

interface PiPseudoVisionConfig {
    /** Whitelist of provider ids whose text-only models get pseudo-vision auto-bridging. Empty by default. */
    bridgeProviders?: string[];
    /** Re-run the vision tools even when a cached conversion exists. */
    bypassCache?: boolean;
    /** Max images converted per request. */
    maxImages?: number;
    /** Tesseract language pack. */
    langs?: string;
    /** OCR resolution budget: auto | small | normal | large | mega. */
    ocrBudget?: string;
    /** Skip budget resize/upscale. */
    ocrNoResize?: boolean;
    /** Cache directory. Default ~/.pi/agent/cache/pi-pseudo-vision. */
    cacheDir?: string;
}

function readConfig(pi: ExtensionAPI): PiPseudoVisionConfig {
    // Pi loads settings.json extensions via the SDK; the extension does not
    // own its own schema, so look for a top-level `pi-pseudo-vision` field.
    // We tolerate it being absent (all defaults).
    const settings = pi as unknown as { settings?: { get?: (key: string) => unknown } };
    const raw = settings.settings?.get?.("pi-pseudo-vision");
    if (raw && typeof raw === "object") return raw as PiPseudoVisionConfig;
    return {};
}

function defaultCacheDir(override?: string): string {
    if (override && override.length > 0) return override;
    return join(homedir(), ".pi", "agent", "cache", "pi-pseudo-vision");
}

async function convertOneImage(
    payload: { bytes: Buffer; mimeType: string },
    cacheDir: string,
    config: PiPseudoVisionConfig,
): Promise<string> {
    const sha256 = sha256Of(payload.bytes);
    return imageToText(
        { sha256, bytes: payload.bytes, mimeType: payload.mimeType },
        {
            cacheDir,
            bypassCache: config.bypassCache ?? false,
            ocrBudget: config.ocrBudget ?? "auto",
            langs: config.langs ?? "chi_sim+eng",
            ocrNoResize: config.ocrNoResize ?? false,
        },
    );
}

function modelSupportsVision(model: { input?: readonly string[] } | undefined): boolean {
    if (!model || !Array.isArray(model.input)) return false;
    return model.input.includes("image");
}

function providerInWhitelist(
    providerId: string | undefined,
    whitelist: readonly string[],
): boolean {
    if (!providerId) return false;
    return whitelist.includes(providerId);
}

export default function (pi: ExtensionAPI) {
    const state = getState(pi);
    const config = readConfig(pi);
    const cacheDir = defaultCacheDir(config.cacheDir);

    // ------------------------------------------------------------------ //
    // vision_color_stats — bucket every pixel into coarse colour classes   //
    // ------------------------------------------------------------------ //
    pi.registerTool({
        name: "vision_color_stats",
        label: "Color Stats",
        description:
            "Bucket every pixel of an image into 9 coarse colour categories (white/black/grey/red/green/blue/yellow/cyan/magenta/other) and report each bucket's share plus average luminance. Pure local sharp work, no network.",
        promptSnippet: "Compute pixel-ratio colour buckets (white/black/grey/red/green/blue/…) for an image.",
        parameters: Type.Object({
            file_path: Type.String({ description: "PNG/JPEG/WebP/GIF path on disk." }),
        }),
        async execute(_id, params) {
            const bytes = await readFile(params.file_path);
            const stats = await computeColorStats(bytes);
            return {
                content: [{ type: "text", text: formatColorStatsBlock(stats) }],
                details: { totalPixels: stats.totalPixels },
            };
        },
    });

    // ------------------------------------------------------------------ //
    // vision_meta — dimensions, format, colour space, 4-corner samples     //
    // ------------------------------------------------------------------ //
    pi.registerTool({
        name: "vision_meta",
        label: "Image Meta",
        description:
            "Read image metadata (dimensions, format, colour space, byte size) and sample the colour at the four corners + centre. Useful for layout inferences (e.g. white TL/TR/BL/BR ⇒ light theme). Pure local sharp work.",
        promptSnippet: "Read image dimensions, format, colour space, and corner/centre colour samples.",
        parameters: Type.Object({
            file_path: Type.String({ description: "PNG/JPEG/WebP/GIF path on disk." }),
        }),
        async execute(_id, params) {
            const bytes = await readFile(params.file_path);
            const result = await readMeta(bytes);
            return {
                content: [{ type: "text", text: formatMetaBlock(result) }],
                details: { width: result.meta.width, height: result.meta.height, samples: result.samples.length },
            };
        },
    });

    // ------------------------------------------------------------------ //
    // vision_pixel_scan — row scan for a target colour / universal scan    //
    // ------------------------------------------------------------------ //
    pi.registerTool({
        name: "vision_pixel_scan",
        label: "Pixel Scan",
        description:
            "Walk every row (and column in universal mode) of the image and report positions where the target colour's pixel density exceeds the threshold. The universal mode buckets every pixel into the same 9 colour classes as colour_stats and reports rows+columns whose non-background density is in [0.15, 0.90). Pure local sharp work.",
        promptSnippet: "Find rows / columns of a target colour or any non-background colour in an image.",
        parameters: Type.Object({
            file_path: Type.String({ description: "PNG/JPEG/WebP/GIF path on disk." }),
            mode: Type.Optional(StringEnum(["target", "universal"] as const)),
            target: Type.Optional(Type.String({ description: "Hex colour #RRGGBB (default red #ff0000). Used by mode=target." })),
            threshold: Type.Optional(Type.Number({ description: "Minimum row/column density 0..1 (default 0.05 for target, 0.15 for universal)." })),
        }),
        async execute(_id, params) {
            const bytes = await readFile(params.file_path);
            const mode = params.mode ?? "target";
            if (mode === "universal") {
                // Reuse the colour-stats decode so we see the same pixels.
                const sharp = (await import("sharp")).default;
                const { data, info } = await sharp(bytes)
                    .resize({ width: 512, height: 512, fit: "inside" })
                    .removeAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                const raw = { data: data as Buffer, width: info.width, height: info.height, channels: info.channels };
                const { computeColorStats } = await import("./vision/color-stats.ts");
                const stats = await computeColorStats(bytes);
                const backgroundBuckets = stats.buckets.filter((b) => b.share >= 0.30).map((b) => b.name);
                const result = await pixelScanUniversal(raw, {
                    backgroundBuckets,
                    threshold: params.threshold ?? 0.15,
                    backgroundCap: 0.9,
                    maxHitsPerBucket: 5,
                });
                return {
                    content: [{ type: "text", text: formatUniversalScanBlock(result) }],
                    details: {
                        mode: "universal",
                        rowHits: result.rowHitCount,
                        colHits: result.colHitCount,
                        hits: 0,
                        peak: null,
                    },
                };
            }
            const result = await pixelScan(bytes, {
                target: params.target ?? "#ff0000",
                threshold: params.threshold ?? 0.05,
            });
            return {
                content: [{ type: "text", text: formatPixelScanBlock(result) }],
                details: {
                    mode: "target",
                    rowHits: 0,
                    colHits: 0,
                    hits: result.rows.length,
                    peak: result.peak?.y ?? null,
                },
            };
        },
    });

    // ------------------------------------------------------------------ //
    // vision_ocr — tesseract.js with digit verification                    //
    // ------------------------------------------------------------------ //
    pi.registerTool({
        name: "vision_ocr",
        label: "Vision OCR",
        description:
            "Run tesseract.js (chi_sim+eng) against the image and return every recognised line with a normalised bounding box. Includes a digit verification pass for IP / URL / port / long-number tokens (whitelist re-OCR). First invocation downloads the language pack (~10MB) then works offline.",
        promptSnippet: "Extract every text line from an image via local tesseract OCR, with digit verification.",
        parameters: Type.Object({
            file_path: Type.String({ description: "PNG/JPEG/WebP/GIF path on disk." }),
            langs: Type.Optional(Type.String({ description: "Tesseract languages, default chi_sim+eng." })),
        }),
        async execute(_id, params) {
            const langs = params.langs ?? config.langs ?? "chi_sim+eng";
            const bytes = await readFile(params.file_path);
            const sharp = (await import("sharp")).default;
            const { preprocessForOcr } = await import("./vision/preprocess.ts");
            const { ocrWithLowConfidenceRetry, formatOcrBlock, formatOcrRetryBlock, formatDigitFixBlock } = await import("./vision/ocr.ts");
            const pre = await preprocessForOcr(bytes, config.ocrBudget ?? "auto", undefined, config.ocrNoResize ?? false);
            const ocr = await ocrWithLowConfidenceRetry(pre.bytes, langs, {
                threshold: 60,
                maxRegions: 3,
                upscale: 2,
            });
            const blocks = [
                formatOcrBlock(ocr.initial),
                formatOcrRetryBlock(ocr),
                formatDigitFixBlock(ocr.digitFixes),
            ].filter((block) => block.length > 0);
            return {
                content: [{ type: "text", text: blocks.join("\n") }],
                details: {
                    lines: ocr.initial.lines.length,
                    retries: ocr.retries.length,
                    digitFixes: ocr.digitFixes.length,
                    budget: pre.budget,
                    preprocessedBytes: pre.bytes.length,
                },
            };
        },
    });

    // ------------------------------------------------------------------ //
    // pseudo_vision_convert — aggregate all four tools into one block      //
    // ------------------------------------------------------------------ //
    pi.registerTool({
        name: "pseudo_vision_convert",
        label: "Pseudo-Vision Convert",
        description:
            "Aggregate the four vision tools into a single `<pseudo-vision-context>` evidence block: preprocessed OCR + digit verification + colour-stats + universal pixel scan + image meta. Use this when you want the full evidence pipeline in one call.",
        promptSnippet: "Run the full OCR + colour-stats + pixel-scan + meta pipeline and return one evidence block.",
        parameters: Type.Object({
            file_path: Type.String({ description: "PNG/JPEG/WebP/GIF path on disk." }),
        }),
        async execute(_id, params) {
            const bytes = await readFile(params.file_path);
            const sha256 = sha256Of(bytes);
            const text = await imageToText(
                { sha256, bytes, mimeType: "image/png" },
                {
                    cacheDir,
                    bypassCache: config.bypassCache ?? false,
                    ocrBudget: config.ocrBudget ?? "auto",
                    langs: config.langs ?? "chi_sim+eng",
                    ocrNoResize: config.ocrNoResize ?? false,
                },
            );
            return {
                content: [{ type: "text", text }],
                details: { sha256: sha256.slice(0, 12), bytes: bytes.length },
            };
        },
    });

    // ------------------------------------------------------------------ //
    // /pseudo-vision command — manual override + on-demand convert          //
    // ------------------------------------------------------------------ //
    pi.registerCommand("pseudo-vision", {
        description: "Toggle auto-bridge for images, or convert a single image. Usage: /pseudo-vision [on|off|status|<path>]",
        handler: async (rawArgs, ctx) => {
            const args = (rawArgs ?? "").trim();
            if (args === "" || args === "status") {
                const whitelist = config.bridgeProviders ?? [];
                const model = ctx.model;
                const providerId = model?.provider;
                const visionNative = modelSupportsVision(model);
                ctx.ui.notify(
                    `pseudo-vision auto-convert: ${state.autoConvert ? "on" : "off"} · `
                    + `model=${providerId ?? "?"}/${model?.id ?? "?"} `
                    + `nativeVision=${visionNative} `
                    + `bridgeWhitelist=[${whitelist.join(", ") || "—"}]`,
                    "info",
                );
                return;
            }
            if (args === "on") {
                state.autoConvert = true;
                ctx.ui.notify("pseudo-vision: auto-convert ON for this session", "info");
                return;
            }
            if (args === "off") {
                state.autoConvert = false;
                ctx.ui.notify("pseudo-vision: auto-convert OFF for this session", "info");
                return;
            }
            // One-shot conversion of a file path
            const path = args.replace(/^["']|["']$/g, "");
            if (!existsSync(path)) {
                ctx.ui.notify(`pseudo-vision: file not found: ${path}`, "error");
                return;
            }
            const bytes = await readFile(path);
            const sha256 = sha256Of(bytes);
            const text = await imageToText(
                { sha256, bytes, mimeType: "image/png" },
                {
                    cacheDir,
                    bypassCache: config.bypassCache ?? false,
                    ocrBudget: config.ocrBudget ?? "auto",
                    langs: config.langs ?? "chi_sim+eng",
                    ocrNoResize: config.ocrNoResize ?? false,
                },
            );
            // Inject as a user follow-up so the next LLM turn picks it up.
            pi.sendUserMessage(`[pi-pseudo-vision evidence for ${path}]\n\n${text}`, { deliverAs: "followUp" });
            ctx.ui.notify(`pseudo-vision: evidence queued for ${path}`, "info");
        },
    });

    // ------------------------------------------------------------------ //
    // Auto-bridge: rewrite outgoing context when an image-only model is in //
    // use AND autoConvert is on (or the provider is in the whitelist).    //
    // ------------------------------------------------------------------ //
    // The context handler is typed against ContextEvent explicitly to keep TS
    // overload resolution happy. The handler walks event.messages, walks image
    // blocks, swaps placeholders, and appends a `custom` observation message.
    (pi.on as (event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages: MsgLike[] } | void>) => void)("context", async (event: ContextEvent, ctx: ExtensionContext) => {
        const model = ctx.model;
        const providerId = model?.provider;
        if (modelSupportsVision(model)) {
            return; // native vision model — leave it alone
        }
        const whitelist = config.bridgeProviders ?? [];
        const whitelisted = providerInWhitelist(providerId, whitelist);
        if (!state.autoConvert && !whitelisted) {
            return; // opt-in only
        }
        const payloads = collectImagePayloads(event.messages as MsgLike[]);
        if (payloads.length === 0) return;
        const max = config.maxImages ?? 8;
        const slice = payloads.slice(0, max);

        const observations: string[] = [];
        const replacements = new Map<string, number>();
        let index = 0;
        for (const { payload } of slice) {
            index += 1;
            const key = imageKey(payload);
            replacements.set(key, index);
            try {
                const text = await convertOneImage(payload, cacheDir, config);
                observations.push(text);
            } catch (error) {
                observations.push(`[图片 ${index} 转换失败：${(error as Error).message}]`);
            }
        }
        state.lastRequestCount = slice.length;

        const task = latestUserTask(event.messages as MsgLike[], slice.length);
        const observationBlock = appendVisionContext(undefined, observations.join("\n\n---\n\n"), slice.length, task);

        // Replace image blocks with placeholders. The shape is treated as a
        // plain mutable list of role/content objects since we read & write only
        // those fields, leaving the rest of the discriminated union intact.
        const rewritten = replaceImagesInMessages(
            event.messages as MsgLike[],
            replacements,
        );

        // Append the vision observation as a `custom` user message just before
        // the most recent user turn. customType identifies it for downstream
        // / debugging; display=true renders it in the TUI transcript.
        const observationMessage = {
            role: "custom" as const,
            customType: "pi-pseudo-vision-context",
            content: observationBlock,
            display: true,
            timestamp: Date.now(),
        };

        return {
            messages: [...rewritten, observationMessage as unknown as MsgLike],
        };
    });

    // ------------------------------------------------------------------ //
    // Lifecycle: dispose OCR workers on shutdown to release the tesseract  //
    // worker pool cleanly across /reload cycles.                           //
    // ------------------------------------------------------------------ //
    pi.on("session_shutdown", async () => {
        await disposeOcr().catch(() => undefined);
    });
}