import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Wack Shell owns this cache independently of the lockscreen extension.
const userName = GLib.get_user_name();
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wack-shell']);
const CACHE_FILE = GLib.build_filenamev([CACHE_DIR, `panel-blur-cache-${userName}.json`]);
const CACHE_FORMAT_VERSION = 'v1-panel-blur';

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
        file.load_contents_async(null, (_obj, result) => {
            try {
                const [success, contents] = file.load_contents_finish(result);
                if (success && contents) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data?.__version__ === CACHE_FORMAT_VERSION) {
                        for (const [key, value] of Object.entries(data)) {
                            if (key !== '__version__')
                                _cache.set(key, value);
                        }
                    } else {
                        try { file.delete(null); } catch (_e) {}
                    }
                }
            } catch (_e) {
                // Missing/corrupt cache is equivalent to an empty cache.
            }
            resolve();
        });
    });

    return _loadPromise;
}

export function saveCache() {
    try {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        const obj = { __version__: CACHE_FORMAT_VERSION };
        for (const [key, value] of _cache.entries())
            obj[key] = value;

        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        const file = Gio.File.new_for_path(CACHE_FILE);
        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null,
            (_obj, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.error(`[WACK/PanelCache] Failed to save cache: ${e}`);
                }
            },
        );
    } catch (e) {
        console.error(`[WACK/PanelCache] Failed to prepare cache: ${e}`);
    }
}

export function clearCache() {
    _cache.clear();
    _loaded = false;
    _loadPromise = null;
}

export function getCache(key) {
    return _cache.get(key);
}

export function setCache(key, value) {
    _cache.set(key, value);
}

export function hasCache(key) {
    return _cache.has(key);
}
