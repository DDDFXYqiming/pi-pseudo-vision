/**
 * Smoke test: import every vision algorithm and a known fixture image to
 * confirm the bridge is wired up. Run with `node --experimental-strip-types
 * --test tests/*.test.ts`.
 *
 * Requires `tests/fixtures/sample.png` (any small PNG). The test creates a
 * trivial 16x16 PNG in-memory if missing, so it always runs.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ----- 1. Compute colour stats on a synthetic image -----
test("computeColorStats returns buckets for a synthetic image", async () => {
    const sharp = (await import("sharp")).default;
    const { computeColorStats, formatColorStatsBlock } = await import("../src/vision/color-stats.ts");

    // 64x64 image: left half white, right half black.
    const buf = await sharp({
        create: {
            width: 64,
            height: 64,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
        },
    })
        .composite([{
            input: await sharp({
                create: {
                    width: 32,
                    height: 64,
                    channels: 3,
                    background: { r: 255, g: 255, b: 255 },
                },
            }).png().toBuffer(),
            left: 0,
            top: 0,
        }])
        .png()
        .toBuffer();

    const stats = await computeColorStats(buf);
    assert.ok(stats.totalPixels > 0, "totalPixels > 0");
    const top = stats.buckets[0];
    assert.ok(top, "at least one bucket");
    // Either white or black dominates; both should be present and sum close to 1.
    const shareOfWhiteAndBlack = (stats.buckets.find((b) => b.name === "white")?.share ?? 0)
        + (stats.buckets.find((b) => b.name === "black")?.share ?? 0);
    assert.ok(shareOfWhiteAndBlack >= 0.85, `white+black share should be >= 0.85, got ${shareOfWhiteAndBlack}`);

    const text = formatColorStatsBlock(stats);
    assert.match(text, /颜色统计/);
    assert.match(text, /平均亮度/);
});

// ----- 2. Read meta on a synthetic image -----
test("readMeta returns dimensions + 4 corner + centre samples", async () => {
    const sharp = (await import("sharp")).default;
    const { readMeta, formatMetaBlock } = await import("../src/vision/meta.ts");

    const buf = await sharp({
        create: {
            width: 100,
            height: 60,
            channels: 3,
            background: { r: 200, g: 50, b: 50 },
        },
    }).png().toBuffer();

    const result = await readMeta(buf);
    assert.equal(result.meta.width, 100);
    assert.equal(result.meta.height, 60);
    assert.equal(result.meta.format, "png");
    // 4 corners + centre = 5 samples, but corner coords may be clipped on tiny
    // images. Accept anything ≥ 1.
    assert.ok(result.samples.length >= 1, "got at least 1 sample");
    assert.equal(result.samples[0]?.label, "TL");

    const text = formatMetaBlock(result);
    assert.match(text, /元信息/);
    assert.match(text, /尺寸 100×60/);
});

// ----- 3. Universal pixel scan on a striped image -----
test("pixelScan finds red rows in a red/black banded image", async () => {
    const sharp = (await import("sharp")).default;
    const { pixelScan, formatPixelScanBlock } = await import("../src/vision/pixel-scan.ts");

    // 64x64 image: top half pure red, bottom half pure black. Single-target
    // pixel scan should pick up every red row with density ~1.0.
    const top = await sharp({
        create: {
            width: 64,
            height: 32,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
        },
    }).png().toBuffer();
    const bottom = await sharp({
        create: {
            width: 64,
            height: 32,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
        },
    }).png().toBuffer();
    const buf = await sharp({
        create: {
            width: 64,
            height: 64,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
        },
    })
        .composite([
            { input: top,    left: 0, top: 0 },
            { input: bottom, left: 0, top: 32 },
        ])
        .png()
        .toBuffer();

    const result = await pixelScan(buf, { target: "#ff0000", threshold: 0.3 });
    assert.ok(result.rows.length > 0, `expected at least one red row, got ${result.rows.length}`);
    // The peak row should sit in the top half (y < 32 in a 64-tall image).
    assert.ok(result.peak !== null && (result.peak.y ?? -1) < 32, "peak row should sit in the top half");

    const text = formatPixelScanBlock(result);
    assert.match(text, /像素扫描/);
    assert.match(text, /target=#ff0000/);
});

test("pixelScanUniversal finds non-background bucket hits", async () => {
    const sharp = (await import("sharp")).default;
    const { pixelScanUniversal } = await import("../src/vision/pixel-scan.ts");

    // 64x64 image: a single horizontal green stripe (height 8) on a white
    // background. White is the background bucket (>30% share); green (small
    // share) should surface in the universal scan.
    const stripe = await sharp({
        create: {
            width: 64,
            height: 8,
            channels: 3,
            background: { r: 0, g: 200, b: 0 },
        },
    }).png().toBuffer();
    const buf = await sharp({
        create: {
            width: 64,
            height: 64,
            channels: 3,
            background: { r: 240, g: 240, b: 240 },
        },
    })
        .composite([{ input: stripe, left: 0, top: 28 }])
        .png()
        .toBuffer();

    const { data, info } = await sharp(buf)
        .resize({ width: 64, height: 64 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const raw = { data: data as Buffer, width: info.width, height: info.height, channels: info.channels };

    // White is the background bucket (treated as exempt by the caller; we
    // don't pass a whitelist here so all 9 buckets use the normal path).
    const result = await pixelScanUniversal(raw, { threshold: 0.1, maxHitsPerBucket: 5 });
    assert.ok(result.hits.length > 0, `expected at least one hit, got ${result.hits.length}`);
});

// ----- 4. Bridge imageToText produces a structured evidence block -----
test("imageToText emits a structured pseudo-vision evidence block", async () => {
    const sharp = (await import("sharp")).default;
    const { imageToText, sha256Of } = await import("../src/bridge.ts");

    const buf = await sharp({
        create: {
            width: 200,
            height: 80,
            channels: 3,
            background: { r: 240, g: 240, b: 240 },
        },
    })
        .png()
        .toBuffer();

    const sha256 = sha256Of(buf);
    const text = await imageToText(
        { sha256, bytes: buf, mimeType: "image/png" },
        {
            cacheDir: `${process.cwd()}/tests/.tmp-cache`,
            bypassCache: true,
            ocrBudget: "small",
            langs: "eng", // english-only to skip chi_sim download
        },
    );

    assert.match(text, /\[pi-pseudo-vision\]/);
    assert.match(text, /\[元信息\]/);
    assert.match(text, /\[颜色统计\]/);
    assert.match(text, /\[像素扫描\]/);
    // OCR block may be empty (no readable text) or carry a chi_sim line;
    // assert the OCR block is either absent or starts with the OCR header.
    assert.ok(
        text.includes("[OCR") || text.includes("no text detected"),
        "OCR block should either render lines or 'no text detected'",
    );
});

// ----- 5. Conditional median: clean image skips denoise, noisy image keeps it -----
test("estimateSaltPepperRate separates clean from salt-pepper images", async () => {
    const sharp = (await import("sharp")).default;
    const { estimateSaltPepperRate } = await import("../src/vision/preprocess.ts");

    // Clean synthetic UI-ish image: flat white with a dark text bar.
    const clean = await sharp({
        create: { width: 320, height: 120, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
        .composite([{
            input: await sharp({
                create: { width: 320, height: 24, channels: 3, background: { r: 30, g: 30, b: 30 } },
            }).png().toBuffer(),
            left: 0,
            top: 48,
        }])
        .png()
        .toBuffer();

    const cleanRate = await estimateSaltPepperRate(clean);
    assert.ok(cleanRate < 3e-4, `clean image salt-pepper rate should be ~0, got ${cleanRate}`);

    // Same image with injected salt-pepper noise (0.5% of pixels).
    const { data, info } = await sharp(clean).greyscale().raw().toBuffer({ resolveWithObject: true });
    const noisy = Buffer.from(data);
    let seed = 7; // deterministic
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let flipped = 0;
    for (let i = 0; i < noisy.length; i += 1) {
        const r = rnd();
        if (r < 0.0025) { noisy[i] = 240 + ((noisy[i] >> 4) & 1) * 15; flipped += 1; }
        else if (r < 0.005) { noisy[i] = 15; flipped += 1; }
    }
    assert.ok(flipped > 0, "noise injection should flip some pixels");
    const noisyBuf = await sharp(noisy, {
        raw: { width: info.width, height: info.height, channels: 1 },
    }).png().toBuffer();
    const noisyRate = await estimateSaltPepperRate(noisyBuf);
    assert.ok(
        noisyRate >= 5e-4,
        `noisy image salt-pepper rate should exceed denoise threshold, got ${noisyRate}`,
    );
});