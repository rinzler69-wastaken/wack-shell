import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

/**
 * Return the dimensions of an image file without decoding the whole image.
 */
export function getWallpaperFileInfo(filePath) {
    return new Promise((resolve) => {
        if (!filePath) {
            resolve(null);
            return;
        }

        GdkPixbuf.Pixbuf.get_file_info_async(filePath, null, (_source, result) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(result);
                resolve(width > 0 && height > 0 ? { width, height } : null);
            } catch (_e) {
                resolve(null);
            }
        });
    });
}

/**
 * Resolve a GNOME wallpaper URI to the actual image file.
 * Supports regular file:// URIs, absolute paths, and slideshow XML files.
 */
export async function resolveWallpaperSource(uri) {
    let targetUri = uri || '';
    let targetFilePath = null;

    if (uri) {
        let filePath = null;

        try {
            if (uri.startsWith('file://'))
                filePath = Gio.File.new_for_uri(uri).get_path();
            else if (uri.startsWith('/'))
                filePath = uri;
        } catch (e) {
            console.error(`[WACK/WallpaperUtils] Failed to parse wallpaper URI: ${e}`);
        }

        if (filePath) {
            if (filePath.toLowerCase().endsWith('.xml')) {
                const resolvedPath = await resolveSlideshowXml(filePath);
                if (resolvedPath) {
                    targetFilePath = resolvedPath;
                    try {
                        targetUri = GLib.filename_to_uri(resolvedPath, null);
                    } catch (_e) {
                        targetUri = `file://${resolvedPath}`;
                    }
                }
            } else {
                targetFilePath = filePath;
                try {
                    targetUri = GLib.filename_to_uri(filePath, null);
                } catch (_e) {
                    targetUri = `file://${filePath}`;
                }
            }
        }
    }

    return { targetUri, targetFilePath };
}

/**
 * Resolve the currently active image from a GNOME background slideshow XML.
 * This intentionally lives here so Wack Shell does not depend on lockscreen
 * constants or colorUtils.js just to resolve wallpaper files.
 */
async function resolveSlideshowXml(xmlPath) {
    try {
        const file = Gio.File.new_for_path(xmlPath);
        const [, contents] = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (obj, res) => {
                try {
                    resolve(file.load_contents_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        if (!contents)
            return null;

        return resolveSlideshowXmlContent(new TextDecoder('utf-8').decode(contents));
    } catch (e) {
        console.error(`[WACK/WallpaperUtils] Failed to resolve XML slideshow: ${e}`);
        return null;
    }
}

function resolveSlideshowXmlContent(xmlText) {
    if (!xmlText)
        return null;

    const year = xmlText.match(/<year>\s*(\d+)\s*<\/year>/);
    const month = xmlText.match(/<month>\s*(\d+)\s*<\/month>/);
    const day = xmlText.match(/<day>\s*(\d+)\s*<\/day>/);
    const hour = xmlText.match(/<hour>\s*(\d+)\s*<\/hour>/);
    const minute = xmlText.match(/<minute>\s*(\d+)\s*<\/minute>/);
    const second = xmlText.match(/<second>\s*(\d+)\s*<\/second>/);

    if (!year || !month || !day)
        return null;

    const startDate = new Date(
        Number(year[1]),
        Number(month[1]) - 1,
        Number(day[1]),
        hour ? Number(hour[1]) : 0,
        minute ? Number(minute[1]) : 0,
        second ? Number(second[1]) : 0,
    );

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startDate.getTime()) / 1000));
    const items = [];
    const blockRegex = /<(static|transition)[^>]*>([\s\S]*?)<\/\1>/g;
    let match;

    while ((match = blockRegex.exec(xmlText)) !== null) {
        const inner = match[2];
        const durationMatch = inner.match(/<duration>\s*([\d.]+)\s*<\/duration>/);
        const duration = durationMatch ? Number(durationMatch[1]) : 0;

        if (match[1] === 'static') {
            const fileMatch = inner.match(/<file>\s*([^<]+)\s*<\/file>/);
            if (fileMatch)
                items.push({ type: 'static', duration, file: fileMatch[1].trim() });
        } else {
            const fromMatch = inner.match(/<from>\s*([^<]+)\s*<\/from>/);
            const toMatch = inner.match(/<to>\s*([^<]+)\s*<\/to>/);
            if (fromMatch && toMatch)
                items.push({ type: 'transition', duration, from: fromMatch[1].trim(), to: toMatch[1].trim() });
        }
    }

    if (items.length === 0)
        return null;

    let total = 0;
    for (const item of items)
        total += item.duration;

    if (total > 0) {
        const position = elapsedSeconds % total;
        let accumulated = 0;
        for (const item of items) {
            if (position >= accumulated && position < accumulated + item.duration) {
                if (item.type === 'static')
                    return item.file;
                const progress = (position - accumulated) / item.duration;
                return progress < 0.5 ? item.from : item.to;
            }
            accumulated += item.duration;
        }
    }

    // Safe fallback when timing data is malformed.
    for (const item of items) {
        if (item.file)
            return item.file;
        if (item.from)
            return item.from;
    }

    return null;
}

export async function getFileMtimeAndSize(filePath) {
    if (!filePath)
        return { mtime: 0, size: 0 };

    const file = Gio.File.new_for_path(filePath);
    return new Promise((resolve) => {
        file.query_info_async(
            'time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (fileObj, result) => {
                try {
                    const info = file.query_info_finish(result);
                    resolve({
                        mtime: info.get_attribute_uint64('time::modified'),
                        size: info.get_attribute_uint64('standard::size'),
                    });
                } catch (_e) {
                    resolve({ mtime: 0, size: 0 });
                }
            },
        );
    });
}

export async function loadScaledWallpaperPixbuf(targetFilePath, width, height, preserveAspectRatio = false) {
    const file = Gio.File.new_for_path(targetFilePath);
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (fileObj, readResult) => {
            let stream;
            try {
                stream = file.read_finish(readResult);
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                    stream,
                    Math.max(1, Math.round(width)),
                    Math.max(1, Math.round(height)),
                    preserveAspectRatio,
                    null,
                    (streamObj, pixResult) => {
                        try {
                            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pixResult);
                            stream.close(null);
                            resolve(pixbuf);
                        } catch (e) {
                            try { stream.close(null); } catch (_e) {}
                            reject(e);
                        }
                    },
                );
            } catch (e) {
                try { stream?.close(null); } catch (_e) {}
                reject(e);
            }
        });
    });
}
