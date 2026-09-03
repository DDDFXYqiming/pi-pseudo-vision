/**
 * v0.2.0 auto-bridge regressions: overflow partial conversion (no silent
 * drop), turn tiering (compact history + full current), total character
 * budget, re-attach restoring the full tier, and placeholder-key matching.
 * Run with `node --experimental-strip-types --test tests/auto-bridge.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAutoBridgeContext, type AutoBridgeOptions } from "../src/auto-bridge.ts";
import { buildVisionCacheKey } from "../src/bridge.ts";
import type { AgentMessageLike } from "../src/content.ts";

async function makeImage(w: number, h: number, color: { r: number; g: number; b: number }): Promise<string> {
    const sharp = (await import("sharp")).default;
    const buf = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
    return buf.toString("base64");
}

function digestOf(b64: string): string {
    return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
}

function userMsg(text: string, images: string[]): AgentMessageLike {
    return {
        role: "user",
        content: [
            { type: "text", text },
            ...images.map((data) => ({ type: "image", data, mimeType: "image/png" })),
        ],
    } as unknown as AgentMessageLike;
}

function assistantMsg(text: string): AgentMessageLike {
    return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessageLike;
}

function opts(cacheDir: string, over: Partial<AutoBridgeOptions> = {}): AutoBridgeOptions {
    return {
        cacheDir,
        maxImages: 8,
        maxTotalEvidenceChars: 96_000,
        fullEvidenceTurns: 2,
        bypassCache: false,
        ocrBudget: "auto",
        langs: "chi_sim+eng",
        ocrNoResize: false,
        ...over,
    };
}

function seedCache(cacheDir: string, b64: string, text: string): void {
    writeFileSync(join(cacheDir, buildVisionCacheKey(digestOf(b64), "normal")), JSON.stringify({ text }));
}

test("the read-tool omitted-notice is rewritten once the bridge handles the image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-notice-"));
    try {
        const a = await makeImage(1, 1, { r: 255, g: 0, b: 0 });
        seedCache(dir, a, "cached evidence A");
        const toolResult = {
            role: "toolResult",
            content: [
                { type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]" },
                { type: "image", data: a, mimeType: "image/png" },
            ],
        } as unknown as AgentMessageLike;
        const result = await buildAutoBridgeContext([userMsg("看图", []), toolResult], opts(dir));
        assert.ok(result);
        const wire = JSON.stringify(result.messages);
        assert.ok(!wire.includes("will be omitted"), "contradictory notice must be rewritten");
        assert.match(wire, /handled by pi-pseudo-vision/);
        assert.match(result.observation, /cached evidence A/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no images returns null (hook stays out of the way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-null-"));
    try {
        const result = await buildAutoBridgeContext([userMsg("hi", [])], opts(dir));
        assert.equal(result, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("overflow converts the current prefix and marks the rest instead of silently dropping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-ov-"));
    try {
        const a = await makeImage(1, 1, { r: 255, g: 0, b: 0 });
        const b = await makeImage(2, 1, { r: 0, g: 255, b: 0 });
        const c = await makeImage(1, 2, { r: 0, g: 0, b: 255 });
        const d = await makeImage(2, 2, { r: 255, g: 255, b: 0 });
        seedCache(dir, a, "cached evidence A");
        seedCache(dir, b, "cached evidence B");
        const result = await buildAutoBridgeContext(
            [userMsg("四张图", [a, b, c, d])],
            opts(dir, { maxImages: 2 }),
        );
        assert.ok(result);
        assert.match(result.observation, /===== 图片 1（image\/png）=====[\s\S]*cached evidence A/);
        assert.match(result.observation, /cached evidence B/);
        assert.doesNotMatch(result.observation, /===== 图片 3（/);
        assert.match(result.observation, /\[⚠️ 图片处理摘要\][\s\S]*未转换 2 张（图片编号 3、4/);
        const wire = JSON.stringify(result.messages);
        assert.ok(!wire.includes("图片 0"), "placeholder keys must match (no 图片 0)");
        assert.match(wire, /图片 1 已由 pi-pseudo-vision 解析/);
        assert.match(wire, /图片 3 未转换/);
        assert.match(wire, /图片 4 未转换/);
        assert.equal(result.convertedCount, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("history-turn images degrade to compact evidence while current-turn images stay full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-tier-"));
    try {
        const a = await makeImage(1, 1, { r: 255, g: 0, b: 0 });
        const b = await makeImage(2, 1, { r: 0, g: 255, b: 0 });
        seedCache(dir, a, "cached evidence A");
        seedCache(dir, b, "cached evidence B");
        const result = await buildAutoBridgeContext(
            [userMsg("第一轮", [a]), assistantMsg("好的"), userMsg("第二轮", [b])],
            opts(dir, { fullEvidenceTurns: 1 }),
        );
        assert.ok(result);
        assert.match(result.observation, /===== 图片 1（image\/png·历史·紧凑）=====/);
        assert.match(result.observation, /\[OCR 已折叠\][\s\S]*read 工具读取完整证据缓存/);
        assert.match(result.observation, /===== 图片 2（image\/png）=====[\s\S]*cached evidence B/);
        assert.doesNotMatch(result.observation, /cached evidence A/);
        assert.match(result.observation, /全量证据 1 张[\s\S]*紧凑证据（历史轮次[^）]*）1 张/);
        assert.match(JSON.stringify(result.messages), /图片 1 为历史轮次图片/);
        assert.equal(result.convertedCount, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("total evidence budget keeps the first image and skips the overflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-budget-"));
    try {
        const a = await makeImage(1, 1, { r: 255, g: 0, b: 0 });
        const b = await makeImage(2, 1, { r: 0, g: 255, b: 0 });
        seedCache(dir, a, "x".repeat(20_000));
        seedCache(dir, b, "y".repeat(20_000));
        const result = await buildAutoBridgeContext(
            [userMsg("两张大图", [a, b])],
            opts(dir, { maxTotalEvidenceChars: 16_000 }),
        );
        assert.ok(result);
        assert.match(result.observation, /===== 图片 1（/);
        assert.doesNotMatch(result.observation, /===== 图片 2（/);
        assert.match(result.observation, /未转换 1 张（图片编号 2/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("re-attaching a history image in a new turn restores its full tier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ab-reattach-"));
    try {
        const a = await makeImage(1, 1, { r: 255, g: 0, b: 0 });
        seedCache(dir, a, "cached evidence A");
        const result = await buildAutoBridgeContext(
            [userMsg("第一轮", [a]), assistantMsg("好的"), userMsg("再看一次", [a])],
            opts(dir, { fullEvidenceTurns: 1 }),
        );
        assert.ok(result);
        assert.match(result.observation, /===== 图片 1（image\/png）=====[\s\S]*cached evidence A/);
        assert.doesNotMatch(result.observation, /历史·紧凑/);
        assert.equal(result.convertedCount, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
