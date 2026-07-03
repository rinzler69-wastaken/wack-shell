import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getLuminance, parseColorStringToRgb } from './constants.js';

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-shell-gradient-cache-${userName}.json`;
const _cache = new Map();
let _loaded = false;
let _loadPromise = null;

export function initCache() {
    if (_loadPromise)
        return _loadPromise;

    _loadPromise = new Promise((resolve) => {
        if (_loaded) {
            resolve();
            return;
        }
        _loaded = true;

        const file = Gio.File.new_for_path(CACHE_FILE);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [success, contents] = file.load_contents_finish(res);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data && data.__version__ === 'v1') {
                        for (const [k, v] of Object.entries(data)) {
                            if (k !== '__version__')
                                _cache.set(k, v);
                        }
                    } else {
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                }
            } catch (e) {
                // File does not exist or JSON parsing failed; ignore.
            }
            resolve();
        });
    });

    return _loadPromise;
}

function saveCache() {
    try {
        const obj = { __version__: 'v1' };
        for (const [k, v] of _cache.entries())
            obj[k] = v;
        const data = JSON.stringify(obj);
        const file = Gio.File.new_for_path(CACHE_FILE);
        const bytes = new TextEncoder().encode(data);
        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null,
            (obj2, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    logError(e, 'WACK Shell/ColorManager: Failed to save persistent cache');
                }
            }
        );
    } catch (e) {
        logError(e, 'WACK Shell/ColorManager: Failed to save persistent cache');
    }
}


function sampleRegion(pixels, channels, rowstride, xStart, xEnd, yStart, yEnd) {
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
            const offset = y * rowstride + x * channels;
            rSum += pixels[offset];
            gSum += pixels[offset + 1];
            bSum += pixels[offset + 2];
            count++;
        }
    }
    if (count === 0)
        return { r: 40, g: 40, b: 40 };

    return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
    };
}

function getOverallAverageColor(pixels, channels, rowstride, visibleX, visibleY, visibleW, visibleH) {
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    const yStart = Math.round(visibleY);
    const yEnd = Math.round(visibleY + visibleH);
    const xStart = Math.round(visibleX);
    const xEnd = Math.round(visibleX + visibleW);

    for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
            const offset = y * rowstride + x * channels;
            rSum += pixels[offset];
            gSum += pixels[offset + 1];
            bSum += pixels[offset + 2];
            count++;
        }
    }
    if (count === 0) return { r: 128, g: 128, b: 128 };
    return {
        r: rSum / count,
        g: gSum / count,
        b: bSum / count
    };
}

/**
 * Extract panel background colors from the current desktop wallpaper.
 * Samples left-most, right-most, and center-most regions at the top of the wallpaper.
 */
export async function getPanelColors() {
    const bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
    const interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });

    const isDark = interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    const uri = bgSettings.get_string(isDark ? 'picture-uri-dark' : 'picture-uri');
    const isColor = bgSettings.get_string('picture-options') === 'none';
    const primaryColor = bgSettings.get_string('primary-color');
    const secondaryColor = bgSettings.get_string('secondary-color');
    const shadingType = bgSettings.get_enum('color-shading-type');

    let targetUri = uri;
    let targetFilePath = null;

    if (uri && uri.startsWith('file://')) {
        targetFilePath = Gio.File.new_for_uri(uri).get_path();
    }

    await initCache();

    const cacheKey = `${targetUri}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}`;
    if (_cache.has(cacheKey))
        return _cache.get(cacheKey);

    let left = { r: 40, g: 40, b: 40 };
    let right = { r: 40, g: 40, b: 40 };
    let center = { r: 40, g: 40, b: 40 };
    let overallL = 0.5;
    let overallChroma = 0.0;
    let rawColSamples = null;
    let dynamicStops = [];

    if (isColor) {
        const c1 = parseColorStringToRgb(primaryColor);
        const c2 = parseColorStringToRgb(secondaryColor);
        if (shadingType === 0) { // Solid
            left = right = center = c1;
        } else if (shadingType === 1) { // Vertical
            // Top of the vertical shading is always primary color c1
            left = right = center = c1;
        } else { // Horizontal
            left = c1;
            right = c2;
            center = {
                r: Math.round((c1.r + c2.r) / 2),
                g: Math.round((c1.g + c2.g) / 2),
                b: Math.round((c1.b + c2.b) / 2)
            };
        }

        // Generate 5 stops for color mode
        if (shadingType === 0 || shadingType === 1) {
            for (let i = 0; i < 5; i++) {
                dynamicStops.push({ offset: i / 4, color: c1 });
            }
        } else {
            for (let i = 0; i < 5; i++) {
                const pct = i / 4;
                const c = {
                    r: Math.round((1 - pct) * c1.r + pct * c2.r),
                    g: Math.round((1 - pct) * c1.g + pct * c2.g),
                    b: Math.round((1 - pct) * c1.b + pct * c2.b)
                };
                dynamicStops.push({ offset: pct, color: c });
            }
        }

        const avgR = (left.r + right.r + center.r) / 3;
        const avgG = (left.g + right.g + center.g) / 3;
        const avgB = (left.b + right.b + center.b) / 3;
        overallL = getLuminance(avgR, avgG, avgB);
        const maxVal = Math.max(avgR, avgG, avgB);
        const minVal = Math.min(avgR, avgG, avgB);
        overallChroma = (maxVal - minVal) / 255.0;
    } else if (targetFilePath) {
        try {
            const file = Gio.File.new_for_path(targetFilePath);
            const pixbuf = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (fileObj, readRes) => {
                    try {
                        const stream = file.read_finish(readRes);
                        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                            stream,
                            160,
                            160,
                            true,
                            null,
                            (streamObj, pixRes) => {
                                try {
                                    const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(pixRes);
                                    stream.close(null);
                                    resolve(pb);
                                } catch (e) {
                                    stream.close(null);
                                    reject(e);
                                }
                            }
                        );
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            const pbWidth = pixbuf.get_width();
            const pbHeight = pixbuf.get_height();
            const pixels = pixbuf.get_pixels();
            const channels = pixbuf.get_n_channels();
            const rowstride = pixbuf.get_rowstride();

            const pictureOptions = bgSettings.get_string('picture-options');
            let visibleX = 0, visibleY = 0, visibleW = pbWidth, visibleH = pbHeight;

            if (pictureOptions === 'zoom') {
                const monitor = Main.layoutManager?.primaryMonitor || { width: 1920, height: 1080 };
                const monitorWidth = monitor.width;
                const monitorHeight = monitor.height;
                const monitorAspect = monitorWidth / monitorHeight;
                const pbAspect = pbWidth / pbHeight;

                if (pbAspect > monitorAspect) {
                    visibleW = pbHeight * monitorAspect;
                    visibleX = (pbWidth - visibleW) / 2;
                } else if (pbAspect < monitorAspect) {
                    visibleH = pbWidth / monitorAspect;
                    visibleY = (pbHeight - visibleH) / 2;
                }
            }

            // Top panel sits at the very top of the visible screen.
            // Sample the top 5% of the visible area.
            const panelHeight = visibleH * 0.05;
            const yStart = visibleY;
            const yEnd = visibleY + panelHeight;

            // Left region: leftmost 25% of visible width
            const leftXStart = visibleX;
            const leftXEnd = visibleX + visibleW * 0.25;

            // Right region: rightmost 25% of visible width
            const rightXStart = visibleX + visibleW * 0.75;
            const rightXEnd = visibleX + visibleW;

            // Center region: middle 20%
            const centerXStart = visibleX + visibleW * 0.40;
            const centerXEnd = visibleX + visibleW * 0.60;

            left = sampleRegion(pixels, channels, rowstride, leftXStart, leftXEnd, yStart, yEnd);
            right = sampleRegion(pixels, channels, rowstride, rightXStart, rightXEnd, yStart, yEnd);
            center = sampleRegion(pixels, channels, rowstride, centerXStart, centerXEnd, yStart, yEnd);

            rawColSamples = [];
            for (let i = 0; i < 10; i++) {
                const xPct = i / 9;
                const xStart = Math.round(visibleX + xPct * (visibleW - 1));
                const colW = Math.max(1, Math.round(visibleW * 0.05));
                const sampleXStart = Math.max(visibleX, xStart - colW / 2);
                const sampleXEnd = Math.min(visibleX + visibleW, xStart + colW / 2);
                rawColSamples.push(sampleRegion(pixels, channels, rowstride, sampleXStart, sampleXEnd, yStart, yEnd));
            }

            const avgColor = getOverallAverageColor(pixels, channels, rowstride, visibleX, visibleY, visibleW, visibleH);
            overallL = getLuminance(avgColor.r, avgColor.g, avgColor.b);
            const maxVal = Math.max(avgColor.r, avgColor.g, avgColor.b);
            const minVal = Math.min(avgColor.r, avgColor.g, avgColor.b);
            overallChroma = (maxVal - minVal) / 255.0;

        } catch (e) {
            logError(e, 'WACK Shell/ColorManager: Failed to extract colors from wallpaper');
            throw e;
        }
    }

    // Color scattering/blending (mixFactor)
    const mixFactor = 0.15;
    const baseLeft = {
        r: (1 - mixFactor) * left.r + mixFactor * right.r,
        g: (1 - mixFactor) * left.g + mixFactor * right.g,
        b: (1 - mixFactor) * left.b + mixFactor * right.b
    };
    const baseRight = {
        r: (1 - mixFactor) * right.r + mixFactor * left.r,
        g: (1 - mixFactor) * right.g + mixFactor * left.g,
        b: (1 - mixFactor) * right.b + mixFactor * left.b
    };

    // Dynamic tinting based on overall wallpaper luminance and chroma score.
    // Saturated wallpapers (high chroma) score lower, leaning to mid-dark/colorful.
    const brightnessScore = overallL * (1.0 - 0.5 * overallChroma);

    // Scale down the tinting intensity for highly chromatic/saturated wallpapers to preserve their rich raw hues.
    let tintAmount = Math.abs(brightnessScore - 0.5) * 0.4; // Up to 20% base tinting
    tintAmount *= (1.0 - 0.6 * overallChroma); // Scale down by up to 60% for pure saturation

    const tintColor = brightnessScore >= 0.5 ? 255 : 0;

    const blendedLeft = {
        r: Math.round(baseLeft.r * (1 - tintAmount) + tintColor * tintAmount),
        g: Math.round(baseLeft.g * (1 - tintAmount) + tintColor * tintAmount),
        b: Math.round(baseLeft.b * (1 - tintAmount) + tintColor * tintAmount)
    };

    const blendedRight = {
        r: Math.round(baseRight.r * (1 - tintAmount) + tintColor * tintAmount),
        g: Math.round(baseRight.g * (1 - tintAmount) + tintColor * tintAmount),
        b: Math.round(baseRight.b * (1 - tintAmount) + tintColor * tintAmount)
    };

    const blendedCenter = {
        r: Math.round(center.r * (1 - tintAmount) + tintColor * tintAmount),
        g: Math.round(center.g * (1 - tintAmount) + tintColor * tintAmount),
        b: Math.round(center.b * (1 - tintAmount) + tintColor * tintAmount)
    };

    // Process rawColSamples into dynamic stops
    if (rawColSamples) {
        const colors = rawColSamples.map(rawColor => ({
            r: Math.round(rawColor.r * (1 - tintAmount) + tintColor * tintAmount),
            g: Math.round(rawColor.g * (1 - tintAmount) + tintColor * tintAmount),
            b: Math.round(rawColor.b * (1 - tintAmount) + tintColor * tintAmount)
        }));

        const xOffsets = [];
        for (let i = 0; i < 10; i++) {
            xOffsets.push(i / 9);
        }

        // Calculate cumulative distances
        const cumDist = [0];
        let totalDist = 0;
        for (let i = 0; i < 9; i++) {
            const rDiff = colors[i+1].r - colors[i].r;
            const gDiff = colors[i+1].g - colors[i].g;
            const bDiff = colors[i+1].b - colors[i].b;
            const d = Math.sqrt(rDiff*rDiff + gDiff*gDiff + bDiff*bDiff);
            totalDist += d;
            cumDist.push(totalDist);
        }

        // Stop 0
        dynamicStops.push({ offset: 0.0, color: colors[0] });

        if (totalDist === 0) {
            for (let p = 1; p <= 3; p++) {
                const pct = p / 4;
                const idx = pct * 9;
                const idxFloor = Math.floor(idx);
                const idxCeil = Math.ceil(idx);
                const t = idx - idxFloor;
                const c = {
                    r: Math.round((1 - t) * colors[idxFloor].r + t * colors[idxCeil].r),
                    g: Math.round((1 - t) * colors[idxFloor].g + t * colors[idxCeil].g),
                    b: Math.round((1 - t) * colors[idxFloor].b + t * colors[idxCeil].b)
                };
                dynamicStops.push({ offset: pct, color: c });
            }
        } else {
            for (let p = 1; p <= 3; p++) {
                const target = (p / 4) * totalDist;
                let k = 0;
                for (let i = 0; i < 9; i++) {
                    if (cumDist[i] <= target && target <= cumDist[i+1]) {
                        k = i;
                        break;
                    }
                }
                const denom = cumDist[k+1] - cumDist[k];
                const t = denom > 0 ? (target - cumDist[k]) / denom : 0;
                
                const offset = xOffsets[k] + t * (xOffsets[k+1] - xOffsets[k]);
                const color = {
                    r: Math.round((1 - t) * colors[k].r + t * colors[k+1].r),
                    g: Math.round((1 - t) * colors[k].g + t * colors[k+1].g),
                    b: Math.round((1 - t) * colors[k].b + t * colors[k+1].b)
                };
                dynamicStops.push({ offset, color });
            }
        }

        // Stop 4
        dynamicStops.push({ offset: 1.0, color: colors[9] });
    } else if (dynamicStops.length === 0) {
        // Fallback for image-based backgrounds if rawColSamples wasn't generated
        dynamicStops.push({ offset: 0.0, color: blendedLeft });
        dynamicStops.push({
            offset: 0.25,
            color: {
                r: Math.round(blendedLeft.r * 0.5 + blendedCenter.r * 0.5),
                g: Math.round(blendedLeft.g * 0.5 + blendedCenter.g * 0.5),
                b: Math.round(blendedLeft.b * 0.5 + blendedCenter.b * 0.5)
            }
        });
        dynamicStops.push({ offset: 0.5, color: blendedCenter });
        dynamicStops.push({
            offset: 0.75,
            color: {
                r: Math.round(blendedCenter.r * 0.5 + blendedRight.r * 0.5),
                g: Math.round(blendedCenter.g * 0.5 + blendedRight.g * 0.5),
                b: Math.round(blendedCenter.b * 0.5 + blendedRight.b * 0.5)
            }
        });
        dynamicStops.push({ offset: 1.0, color: blendedRight });
    }

    const result = {
        left: blendedLeft,
        right: blendedRight,
        center: blendedCenter,
        leftLuminance: getLuminance(blendedLeft.r, blendedLeft.g, blendedLeft.b),
        rightLuminance: getLuminance(blendedRight.r, blendedRight.g, blendedRight.b),
        centerLuminance: getLuminance(blendedCenter.r, blendedCenter.g, blendedCenter.b),
        stops: dynamicStops
    };

    _cache.set(cacheKey, result);
    saveCache();
    return result;
}

export function clearCache() {
    _cache.clear();
    _loaded = false;
    _loadPromise = null;
}
