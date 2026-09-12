import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

function fastBoxBlur(srcPixels, w, h, stride, channels, r) {
    if (r <= 0 || w <= 0 || h <= 0)
        return srcPixels;

    const total = w * h * channels;
    const temp = new Uint8Array(total);
    const out = new Uint8Array(total);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
        const rowOffset = y * stride;
        const tempRowOffset = y * w * channels;
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let x = -r; x <= r; x++) {
                const sx = Math.max(0, Math.min(w - 1, x));
                sum += srcPixels[rowOffset + sx * channels + c];
            }
            const count = 2 * r + 1;
            temp[tempRowOffset + c] = Math.round(sum / count);

            for (let x = 1; x < w; x++) {
                const addX = Math.min(w - 1, x + r);
                const subX = Math.max(0, x - r - 1);
                sum += srcPixels[rowOffset + addX * channels + c] - srcPixels[rowOffset + subX * channels + c];
                temp[tempRowOffset + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    // Vertical pass
    for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let y = -r; y <= r; y++) {
                const sy = Math.max(0, Math.min(h - 1, y));
                sum += temp[sy * w * channels + x * channels + c];
            }
            const count = 2 * r + 1;
            out[x * channels + c] = Math.round(sum / count);

            for (let y = 1; y < h; y++) {
                const addY = Math.min(h - 1, y + r);
                const subY = Math.max(0, y - r - 1);
                sum += temp[addY * w * channels + x * channels + c] - temp[subY * w * channels + x * channels + c];
                out[y * w * channels + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    return out;
}

/**
 * Samples a rectangular region from a source wallpaper pixbuf and computes its average color.
 *
 * @param {GdkPixbuf.Pixbuf} srcPixbuf Source wallpaper pixbuf
 * @param {object} bounds Normalized crop coordinates { x1, x2, y1, y2 }
 * @returns {{r: number, g: number, b: number}|null}
 */
export function sampleRegionAverageColor(srcPixbuf, bounds) {
    if (!srcPixbuf || !bounds)
        return null;

    const pbWidth = srcPixbuf.get_width();
    const pbHeight = srcPixbuf.get_height();

    const startX = Math.max(0, Math.min(pbWidth - 1, Math.floor(bounds.x1 * pbWidth)));
    const endX = Math.max(1, Math.min(pbWidth, Math.ceil(bounds.x2 * pbWidth)));
    const startY = Math.max(0, Math.min(pbHeight - 1, Math.floor(bounds.y1 * pbHeight)));
    const endY = Math.max(1, Math.min(pbHeight, Math.ceil(bounds.y2 * pbHeight)));

    const cropW = endX - startX;
    const cropH = endY - startY;
    if (cropW <= 0 || cropH <= 0)
        return null;

    const rawPix = srcPixbuf.new_subpixbuf(startX, startY, cropW, cropH);
    const pixels = rawPix.get_pixels();
    const nChannels = rawPix.get_n_channels();
    const stride = rawPix.get_rowstride();

    let sumR = 0, sumG = 0, sumB = 0;
    const stepX = Math.max(1, Math.floor(cropW / 32));
    const stepY = Math.max(1, Math.floor(cropH / 32));
    let samples = 0;

    for (let y = 0; y < cropH; y += stepY) {
        const rowOff = y * stride;
        for (let x = 0; x < cropW; x += stepX) {
            const off = rowOff + x * nChannels;
            sumR += pixels[off];
            sumG += pixels[off + 1];
            sumB += pixels[off + 2];
            samples++;
        }
    }

    if (samples === 0)
        return null;

    return {
        r: Math.round(sumR / samples),
        g: Math.round(sumG / samples),
        b: Math.round(sumB / samples),
    };
}



/**
 * Create a static blurred strip for the top panel.
 *
 * The returned pixbuf is already at physical output resolution. The caller
 * should use the corresponding logical dimensions in St CSS.
 *
 * @param {GdkPixbuf.Pixbuf|object} srcPixbufOrParams Source pixbuf or options object
 * @param {object} monitorBounds Monitor geometry: {x, y, width, height, pictureOptions}
 * @param {number} stripWidth Output width in physical pixels
 * @param {number} stripHeight Output backdrop height in physical pixels. This is
 *   intentionally independent of the panel actor's allocation; CSS clips it.
 * @param {number} blurRadius Blur radius in physical pixels
 * @param {number} brightness Multiplicative brightness factor
 * @param {{r:number,g:number,b:number}|null} blendColor Optional post-blur blend color
 * @param {number} blendAlpha Optional post-blur blend alpha (0.0 - 1.0)
 * @returns {GdkPixbuf.Pixbuf|null}
 */
export function createBlurredPanelStrip(
    srcPixbufOrParams,
    monitorBounds,
    stripWidth,
    stripHeight,
    blurRadius,
    brightness,
    blendColor = null,
    blendAlpha = 0,
) {
    const params = srcPixbufOrParams && typeof srcPixbufOrParams === 'object' &&
        typeof srcPixbufOrParams.get_width !== 'function'
        ? srcPixbufOrParams
        : {
            pixbuf: srcPixbufOrParams,
            monitorBounds,
            stripWidth,
            stripHeight,
            blurRadius,
            brightness,
            blendColor,
            blendAlpha,
        };

    const srcPixbuf = params.pixbuf;
    const bounds = params.monitorBounds ?? {};
    const outW = Math.max(1, Math.round(params.stripWidth ?? 1));
    const outH = Math.max(1, Math.round(params.stripHeight ?? 1));
    const radius = Math.max(0, Math.round(params.blurRadius ?? 0));
    const bFactor = Math.max(0, Number(params.brightness ?? 1));
    const blend = params.blendColor;
    const aBlend = Math.max(0, Math.min(1, Number(params.blendAlpha ?? 0)));
    const pictureOptions = bounds.pictureOptions ?? 'zoom';

    if (!srcPixbuf)
        return null;

    const srcW = srcPixbuf.get_width();
    const srcH = srcPixbuf.get_height();
    if (srcW <= 0 || srcH <= 0)
        return null;

    // Resolve the portion of the source that corresponds to the visible
    // monitor. The manager normally loads the wallpaper to the monitor's
    // target geometry first, so this also handles the common zoom case cleanly.
    let x = 0;
    let y = 0;
    let w = srcW;
    let h = srcH;

    const monitorW = Math.max(1, Number(bounds.width ?? outW));
    const monitorH = Math.max(1, Number(bounds.height ?? outH));
    const sourceAspect = srcW / srcH;
    const monitorAspect = monitorW / monitorH;

    if (pictureOptions === 'zoom' || pictureOptions === 'spanned') {
        if (sourceAspect > monitorAspect) {
            w = Math.max(1, Math.round(srcH * monitorAspect));
            x = Math.max(0, Math.floor((srcW - w) / 2));
        } else if (sourceAspect < monitorAspect) {
            h = Math.max(1, Math.round(srcW / monitorAspect));
            y = Math.max(0, Math.floor((srcH - h) / 2));
        }
    } else if (pictureOptions === 'scaled') {
        // Preserve the source's aspect ratio and use its centered placement.
        // If the image is letterboxed, the top strip is represented by the
        // nearest image row rather than synthesizing a separate color surface.
        if (sourceAspect > monitorAspect) {
            h = Math.min(srcH, Math.max(1, Math.round(srcW / monitorAspect)));
            y = Math.max(0, Math.floor((srcH - h) / 2));
        } else if (sourceAspect < monitorAspect) {
            w = Math.min(srcW, Math.max(1, Math.round(srcH * monitorAspect)));
            x = Math.max(0, Math.floor((srcW - w) / 2));
        }
    } else if (pictureOptions === 'centered') {
        // Native-size centered wallpaper. The monitor top maps to the source
        // position implied by the centered placement.
        const offsetX = Math.round((monitorW - srcW) / 2);
        const offsetY = Math.round((monitorH - srcH) / 2);
        x = Math.max(0, -offsetX);
        y = Math.max(0, -offsetY);
        w = Math.min(srcW - x, monitorW);
        h = Math.min(srcH - y, monitorH);
    } else if (pictureOptions === 'wallpaper') {
        // Tiled wallpaper starts at the monitor's top-left. Keep the source
        // origin so the strip samples the same tile phase.
        w = Math.min(srcW, Math.max(1, Math.round(outW)));
        h = Math.min(srcH, Math.max(1, Math.round(outH)));
    }

    w = Math.max(1, Math.min(srcW - x, w));
    h = Math.max(1, Math.min(srcH - y, h));

    // Build the strip from the TOP of the visible monitor image.
    //
    // The blur needs vertical context, but that context must sit BELOW the
    // actual panel region. The old implementation cropped exactly to the
    // output height before blurring, which meant a large radius effectively
    // averaged the entire strip and made the result look like a centre sample.
    // Keep the output anchored at source y, then blur a taller source window
    // and extract the top output rows afterwards.
    const sourcePixelsPerOutputPixel = Math.max(1, w / outW);
    const contextSourceHeight = Math.min(
        h,
        Math.max(
            Math.ceil(outH * sourcePixelsPerOutputPixel),
            Math.ceil((radius * 2 + outH) * sourcePixelsPerOutputPixel),
        ),
    );
    const crop = srcPixbuf.new_subpixbuf(x, y, w, Math.max(1, contextSourceHeight));

    const scale = outW / w;
    const workW = Math.max(2, Math.round(w * scale));
    const workH = Math.max(2, Math.round(contextSourceHeight * scale));
    const working = crop.scale_simple(workW, workH, GdkPixbuf.InterpType.BILINEAR);
    if (!working)
        return null;

    const pixels = working.get_pixels();
    const channels = working.get_n_channels();
    const stride = working.get_rowstride();

    // Downsample for large radii. The box blur itself is O(pixels), so the
    // radius does not turn into a per-frame cost (and this runs only on regen).
    const dsFactor = radius >= 32 ? 2 : 1;
    const dsW = Math.max(2, Math.round(workW / dsFactor));
    const dsH = Math.max(2, Math.round(workH / dsFactor));
    const dsPix = dsFactor > 1
        ? working.scale_simple(dsW, dsH, GdkPixbuf.InterpType.BILINEAR)
        : working;
    if (!dsPix)
        return null;

    const dsRadius = Math.max(1, Math.round((radius / dsFactor) * 0.7));
    let blurred = dsPix.get_pixels();
    if (radius > 0) {
        blurred = fastBoxBlur(blurred, dsW, dsH, dsPix.get_rowstride(), channels, dsRadius);
        blurred = fastBoxBlur(blurred, dsW, dsH, dsW * channels, channels, dsRadius);
    }

    // Extract the top-left output region. The source was deliberately made
    // taller than the requested strip, so the blur has vertical headroom.
    const cropW = Math.min(dsW, Math.max(1, Math.round(outW / dsFactor)));
    const cropH = Math.min(dsH, Math.max(1, Math.round(outH / dsFactor)));
    // First build the final blurred + brightness-processed image.
    // The white/black treatment is deliberately NOT done here: it belongs
    // after the final output scaling so the blend is baked into the exact
    // pixels that will be written to the static cache.
    const bytes = new Uint8Array(cropW * cropH * channels);

    for (let yy = 0; yy < cropH; yy++) {
        for (let xx = 0; xx < cropW; xx++) {
            const srcOff = yy * dsW * channels + xx * channels;
            const dstOff = (yy * cropW + xx) * channels;
            bytes[dstOff] = Math.max(0, Math.min(255, Math.round(blurred[srcOff] * bFactor)));
            bytes[dstOff + 1] = Math.max(0, Math.min(255, Math.round(blurred[srcOff + 1] * bFactor)));
            bytes[dstOff + 2] = Math.max(0, Math.min(255, Math.round(blurred[srcOff + 2] * bFactor)));
            if (channels === 4)
                bytes[dstOff + 3] = blurred[srcOff + 3];
        }
    }

    const resultBytes = GLib.Bytes.new(bytes);
    const result = GdkPixbuf.Pixbuf.new_from_bytes(
        resultBytes,
        GdkPixbuf.Colorspace.RGB,
        channels === 4,
        8,
        cropW,
        cropH,
        cropW * channels,
    );

    const finalImage = (cropW !== outW || cropH !== outH)
        ? result.scale_simple(outW, outH, GdkPixbuf.InterpType.BILINEAR)
        : result;

    if (!finalImage || !blend || aBlend <= 0)
        return finalImage;

    // Bake the style treatment into the FINAL processed pixels. There is no
    // overlay actor involved: Ventura's white glass and the standard panel's
    // subtle darkening become part of the cached PNG itself.
    const finalW = finalImage.get_width();
    const finalH = finalImage.get_height();
    const finalChannels = finalImage.get_n_channels();
    const finalStride = finalImage.get_rowstride();
    const finalPixels = finalImage.get_pixels();
    const baked = new Uint8Array(finalW * finalH * finalChannels);

    for (let yy = 0; yy < finalH; yy++) {
        for (let xx = 0; xx < finalW; xx++) {
            const srcOff = yy * finalStride + xx * finalChannels;
            const dstOff = (yy * finalW + xx) * finalChannels;
            baked[dstOff] = Math.max(0, Math.min(255, Math.round(
                finalPixels[srcOff] + (blend.r - finalPixels[srcOff]) * aBlend)));
            baked[dstOff + 1] = Math.max(0, Math.min(255, Math.round(
                finalPixels[srcOff + 1] + (blend.g - finalPixels[srcOff + 1]) * aBlend)));
            baked[dstOff + 2] = Math.max(0, Math.min(255, Math.round(
                finalPixels[srcOff + 2] + (blend.b - finalPixels[srcOff + 2]) * aBlend)));
            if (finalChannels === 4)
                baked[dstOff + 3] = finalPixels[srcOff + 3];
        }
    }

    return GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(baked),
        GdkPixbuf.Colorspace.RGB,
        finalChannels === 4,
        8,
        finalW,
        finalH,
        finalW * finalChannels,
    );
}
