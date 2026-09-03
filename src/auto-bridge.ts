/**
 * Auto-bridge orchestration: the tiered, budgeted context rewrite used by
 * the pi `context` hook. Pure module — no pi imports — so it runs under
 * `node --test` without the agent runtime.
 *
 * Budgeted, tiered request transformation. Images of the recent user turns
 * (fullEvidenceTurns) get the full local evidence pipeline, each image
 * capped at MAX_EVIDENCE_CHARS and the whole request additionally capped at
 * maxTotalEvidenceChars. Older-turn images degrade to compact evidence
 * (metadata + colour + scan, OCR folded to a re-fetch pointer). Only images
 * beyond the count/budget caps are skipped, and every skipped image keeps
 * an explicit placeholder plus a summary line, so nothing disappears
 * silently. The request never fails because too many images were attached.
 *
 * Ported from dsh-pseudo-vision v0.6.0 (same author).
 */

import { imageToCompactText, imageToText, sha256Of } from "./bridge.ts";
import {
    appendVisionContext,
    collectImagePayloadsWithOrigin,
    latestUserTask,
    replaceImagesInMessages,
    type AgentMessageLike,
} from "./content.ts";

export interface AutoBridgeOptions {
    cacheDir: string;
    /** Full-tier image count cap per request (OCR wall-time guard). */
    maxImages: number;
    /** Combined evidence character cap per request (context guard). */
    maxTotalEvidenceChars: number;
    /** Recent user turns whose images keep full evidence. */
    fullEvidenceTurns: number;
    bypassCache: boolean;
    ocrBudget: string;
    langs: string;
    ocrNoResize: boolean;
}

export interface AutoBridgeResult {
    messages: AgentMessageLike[];
    observation: string;
    convertedCount: number;
}

type Tier = "full" | "compact" | "skipped";

export async function buildAutoBridgeContext(
    messages: readonly AgentMessageLike[],
    options: AutoBridgeOptions,
): Promise<AutoBridgeResult | null> {
    const entries = collectImagePayloadsWithOrigin(messages);
    if (entries.length === 0) return null;

    const total = entries.length;
    const totalBudget = options.maxTotalEvidenceChars;

    // Turn boundary: the message index of the fullEvidenceTurns-th user
    // message from the end. An image whose LATEST appearance is before it is
    // history-tier; re-attaching an image in a newer turn restores full tier.
    const userIdx: number[] = [];
    messages.forEach((message, index) => {
        if (message.role === "user") userIdx.push(index);
    });
    const boundary = userIdx.length >= options.fullEvidenceTurns
        ? (userIdx[userIdx.length - options.fullEvidenceTurns] ?? 0)
        : 0;

    const tiers = new Map<string, Tier>();
    const labels = new Map<string, number>();
    const texts = new Map<string, string>();
    let usedChars = 0;
    let fullCount = 0;

    // Pass 1: current-turn images → full evidence (count + budget capped).
    for (let index = 0; index < total; index += 1) {
        const entry = entries[index]!;
        const label = index + 1;
        labels.set(entry.key, label);
        if (entry.lastIndex < boundary) continue;
        if (fullCount >= options.maxImages || usedChars >= totalBudget) {
            tiers.set(entry.key, "skipped");
            continue;
        }
        let text: string;
        try {
            text = await imageToText(
                {
                    sha256: sha256Of(entry.payload.bytes),
                    bytes: entry.payload.bytes,
                    mimeType: entry.payload.mimeType,
                },
                {
                    cacheDir: options.cacheDir,
                    bypassCache: options.bypassCache,
                    ocrBudget: options.ocrBudget,
                    langs: options.langs,
                    ocrNoResize: options.ocrNoResize,
                },
            );
        } catch (error) {
            // A failed conversion stays visible in the evidence instead of
            // aborting the whole turn: the model sees why the image is blank.
            text = "[图片 " + label + " 转换失败：" + ((error as Error)?.message ?? String(error)) + "]";
        }
        // The first included image is never dropped for being over budget on
        // its own: some evidence beats none, and capEvidence already bounds
        // it. Subsequent images must fit the remaining budget.
        if (usedChars > 0 && usedChars + text.length > totalBudget) {
            tiers.set(entry.key, "skipped");
            continue;
        }
        usedChars += text.length;
        fullCount += 1;
        tiers.set(entry.key, "full");
        texts.set(entry.key, "===== 图片 " + label + "（" + entry.payload.mimeType + "）=====\n" + text);
    }

    // Pass 2: history images → compact evidence, newest first, filling the
    // remaining budget. Cheap enough that old images effectively never vanish.
    let compactCount = 0;
    for (let index = total - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        const label = index + 1;
        if (entry.lastIndex >= boundary) continue;
        if (usedChars >= totalBudget) {
            tiers.set(entry.key, "skipped");
            continue;
        }
        const text = await imageToCompactText(
            {
                sha256: sha256Of(entry.payload.bytes),
                bytes: entry.payload.bytes,
                mimeType: entry.payload.mimeType,
            },
            {
                cacheDir: options.cacheDir,
                ocrBudget: options.ocrBudget,
                langs: options.langs,
                noResize: options.ocrNoResize,
            },
        );
        if (usedChars > 0 && usedChars + text.length > totalBudget) {
            tiers.set(entry.key, "skipped");
            continue;
        }
        usedChars += text.length;
        compactCount += 1;
        tiers.set(entry.key, "compact");
        texts.set(entry.key, "===== 图片 " + label + "（" + entry.payload.mimeType + "·历史·紧凑）=====\n" + text);
    }

    const skippedLabels: number[] = [];
    const observations: string[] = [];
    for (let index = 0; index < total; index += 1) {
        const entry = entries[index]!;
        const text = texts.get(entry.key);
        if (text !== undefined) {
            observations.push(text);
        } else if (tiers.get(entry.key) === "skipped") {
            skippedLabels.push(index + 1);
        }
    }
    if (compactCount > 0 || skippedLabels.length > 0) {
        const parts = [
            "本次请求共 " + total + " 张图片：全量证据 " + fullCount + " 张",
            "紧凑证据（历史轮次，OCR 已折叠可按指针回读）" + compactCount + " 张",
        ];
        if (skippedLabels.length > 0) {
            parts.push("未转换 " + skippedLabels.length + " 张（图片编号 " + skippedLabels.join("、") + "，超出张数上限 " + options.maxImages + " 或证据预算）");
        }
        const advice = skippedLabels.length > 0
            ? "。请在回答中明确告知用户哪些图片未生效，并建议其把未生效的图片单独发送"
            : "";
        observations.push("[⚠️ 图片处理摘要] " + parts.join("；") + advice + "。");
    }

    const task = latestUserTask(messages, total);
    const rewritten = replaceImagesInMessages(messages as AgentMessageLike[], (key) => {
        const tier = tiers.get(key);
        const label = labels.get(key) ?? 0;
        if (tier === "compact") {
            return "[图片 " + label + " 为历史轮次图片，本次仅注入紧凑视觉证据（颜色/扫描/元信息，OCR 已折叠可回读），见本次请求的伪视觉上下文]";
        }
        if (tier === "skipped") {
            return "[图片 " + label + " 未转换（本次请求共 " + total + " 张，超出张数上限 " + options.maxImages + " 或证据预算），请提示用户重新单独发送该图片]";
        }
        return "[图片 " + label + " 已由 pi-pseudo-vision 解析，观察数据位于本次请求的伪视觉上下文中]";
    });

    return {
        messages: rewritten,
        observation: appendVisionContext(undefined, observations.join("\n\n---\n\n"), total, task),
        convertedCount: fullCount + compactCount,
    };
}
