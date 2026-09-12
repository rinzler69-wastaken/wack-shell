import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ColorManager from './colorManager.js';
import { createBlurredPanelStrip } from './wallpaperSampler.js';
import { resolveWallpaperSource, getFileMtimeAndSize, loadScaledWallpaperPixbuf, getWallpaperFileInfo } from './wallpaperUtils.js';
import { initCache, saveCache, getCache, setCache, hasCache } from './alphaCache.js';

export const RADIUS_LINEAR = 350;
export const RADIUS_LENIENT = 175;

const PANEL_STRIP_SOURCE_HEIGHT = 192;
const PANEL_CACHE_PREFIX = 'wack-panel-blur-';
const USER_NAME = GLib.get_user_name();
const PANEL_CACHE_DIR = GLib.get_user_cache_dir();

export default class VibrancyManager {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._desktopSettings = null;
        this._bgSettings = null;
        this._bmsSettings = null;
        this._vibrancyBmsSig = null;
        this._panelStripPath = null;
        this._panelStripWidth = 0;
        this._panelStripHeight = PANEL_STRIP_SOURCE_HEIGHT;
        this._panelBackdrop = null;
        this._panelBackdropStyle = null;
        this._panelBackdropOverlay = null;
        this._panelBackdropOverlayStyle = null;
        this._panelProximityOverlay = null;
        this._panelProximityOverlayStyle = null;
        this._panelProximityActive = false;
        this._updateStripId = 0;
        this._stripPromise = null;
        this._stripRegenerationPending = false;
        this._settingStyle = false;
        this._updateColorsId = 0;
        this._retryCount = 0;
        this._retryTimeoutId = 0;
        this._currentColors = null;
        this._vibrancyStyleActive = false;
        this._proximityAnimationId = 0;
        this._proximityAnimationToken = 0;
        this._proximityPanelColor = null;
    }

    get vibrancyActive() {
        const enabled = this._settings.get_boolean('enable-vibrancy');
        const bmsConflict = this._bmsHasPanelBlur();
        return enabled && !bmsConflict;
    }

    enable() {
        this._bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        this._settingStyle = false;
        this._updateColorsId = 0;
        this._retryCount = 0;
        this._retryTimeoutId = 0;

        this._desktopSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });

        this._bgSettings.connectObject(
            'changed::picture-uri', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            'changed::picture-uri-dark', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            'changed::picture-options', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            'changed::primary-color', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            'changed::secondary-color', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            'changed::color-shading-type', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); },
            this
        );

        if (this._desktopSettings) {
            this._desktopSettings.connectObject(
                'changed::color-scheme', () => { this._updateWallpaperColors(); this._regeneratePanelStrip(); this._syncVibrancy(); },
                this
            );
        }

        Main.panel.connectObject(
            'notify::style', () => {
                if (this._settingStyle) return;
                this.applyVibrancyStyle();
            },
            'notify::allocation', () => this._allocatePanelBackdrop(),
            this
        );

        this._ensurePanelBackdrop();

        // Initialize static panel strip and BMS integrations
        this._vibrancyBmsSig = null;
        this._extStateChangedId = 0;

        // React to our own settings changes
        this._settings.connectObject(
            'changed::enable-vibrancy', () => this._syncVibrancy(),
            'changed::vibrancy-blur-mode', () => this._syncVibrancy(),
            'changed::vibrancy-style', () => this._syncVibrancy(),
            this
        );

        this._initBmsSettings();

        try {
            Main.extensionManager.connectObject('extension-state-changed', (_obj, ext) => {
                if (ext.uuid === 'blur-my-shell@aunetx') {
                    this._initBmsSettings();
                    this._syncVibrancy();
                }
            }, this);
        } catch {
            // extensionManager may not support connectObject in all versions
        }

        Main.layoutManager.connectObject('monitors-changed', () => this._regeneratePanelStrip(), this);
        Main.panel.connectObject('notify::allocation', () => this._allocatePanelBackdrop(), this);


        this._updateWallpaperColors();
        this._regeneratePanelStrip();
        this._syncVibrancy();
    }

    disable() {
        this._cancelProximityAnimation();
        if (this._retryTimeoutId) {
            GLib.source_remove(this._retryTimeoutId);
            this._retryTimeoutId = 0;
        }

        Main.panel.disconnectObject(this);

        if (this._panelBackdrop) {
            try {
                this._panelBackdrop.destroy();
            } catch (_) { }
            this._panelBackdrop = null;
        }
        if (this._panelBackdropOverlay) {
            try {
                this._panelBackdropOverlay.destroy();
            } catch (_) { }
            this._panelBackdropOverlay = null;
        }
        if (this._panelProximityOverlay) {
            try {
                this._panelProximityOverlay.destroy();
            } catch (_) { }
            this._panelProximityOverlay = null;
        }
        this._panelBackdropStyle = null;
        this._panelBackdropOverlayStyle = null;
        this._panelProximityOverlay = null;
        this._panelProximityOverlayStyle = null;
        this._panelProximityActive = false;
        try {
            Main.extensionManager.disconnectObject(this);
        } catch { }

        this._panelStripPath = null;
        this._panelStripWidth = 0;
        this._panelStripHeight = PANEL_STRIP_SOURCE_HEIGHT;
        this._panelBackdrop = null;
        this._panelBackdropStyle = null;
        this._updateStripId++;

        if (this._bmsSettings) {
            if (this._vibrancyBmsSig)
                this._bmsSettings.disconnect(this._vibrancyBmsSig);
            this._bmsSettings = null;
            this._vibrancyBmsSig = null;
        }

        if (this._vibrancyStyleActive) {
            Main.panel.set_style(null);
            this._vibrancyStyleActive = false;
        this._proximityAnimationId = 0;
        this._proximityAnimationToken = 0;
        this._proximityPanelColor = null;
        }

        Main.panel.remove_style_class_name('panel-ventura-light');
        Main.panel.remove_style_class_name('panel-bigsur');
        Main.panel.remove_style_class_name('light-contrast');

        if (this._bgSettings) {
            this._bgSettings.disconnectObject(this);
            this._bgSettings = null;
        }

        if (this._desktopSettings) {
            this._desktopSettings.disconnectObject(this);
            this._desktopSettings = null;
        }

        this._settings.disconnectObject(this);

        ColorManager.releaseCache();
        this._currentColors = null;
    }

    async _updateWallpaperColors() {
        const runId = ++this._updateColorsId;
        if (this._retryTimeoutId) {
            GLib.source_remove(this._retryTimeoutId);
            this._retryTimeoutId = 0;
        }
        try {
            const colors = await ColorManager.getPanelColors();
            if (!this._settings || runId !== this._updateColorsId) return;
            this._currentColors = colors;
            this._retryCount = 0;
            this.applyVibrancyStyle();
        } catch {
            if (runId === this._updateColorsId) {
                this._currentColors = null;
                this.applyVibrancyStyle();

                if (this._retryCount < 3) {
                    this._retryCount++;
                    this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                        this._retryTimeoutId = 0;
                        if (this._settings && runId === this._updateColorsId) {
                            this._updateWallpaperColors();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        }
    }

    async _regeneratePanelStrip() {
        if (!this._settings?.get_boolean('enable-vibrancy'))
            return;

        const runId = ++this._updateStripId;
        if (this._stripPromise) {
            this._stripRegenerationPending = true;
            return this._stripPromise;
        }

        this._stripRegenerationPending = false;
        this._stripPromise = (async () => {
            try {
                await initCache();
                const isDark = this._isDarkColorScheme();
                const uri = this._bgSettings?.get_string(isDark ? 'picture-uri-dark' : 'picture-uri') || '';
                const pictureOptions = this._bgSettings?.get_string('picture-options') || 'zoom';
                const monitor = Main.layoutManager?.primaryMonitor || { width: 1920, height: 1080 };
                const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
                const stripWidth = Math.max(1, Math.round(monitor.width));
                // Processing/backdrop extent only. This never defines panel thickness;
                // Main.panel's allocation remains authoritative and clips the CSS background.
                const stripHeight = PANEL_STRIP_SOURCE_HEIGHT;
                const physicalWidth = Math.max(1, Math.round(stripWidth * scale));
                const physicalHeight = Math.max(1, Math.round(stripHeight * scale));

                const blurMode = this._settings.get_int('vibrancy-blur-mode');
                const style = this._settings.get_int('vibrancy-style');
                const borrow = this._getBorrowVenturaLight();
                const effectiveStyle = ((style === 2 || borrow) && !isDark) ? 2 : 1;
                const resolvedMode = blurMode === 3 ? (this._isWallpaperLenient() ? 2 : 1) : blurMode;
                const blurRadius = resolvedMode === 1 ? RADIUS_LINEAR : RADIUS_LENIENT;
                const brightness = effectiveStyle === 2 ? 0.80 : (isDark ? 0.90 : 0.95);

                const { targetUri, targetFilePath } = await resolveWallpaperSource(uri);
                const { mtime, size } = await getFileMtimeAndSize(targetFilePath);
                const primaryColor = this._bgSettings?.get_string('primary-color') || '';
                const secondaryColor = this._bgSettings?.get_string('secondary-color') || '';
                const shadingType = this._bgSettings?.get_enum('color-shading-type') ?? 0;
                const cacheKey = `${targetUri}_${mtime}_${size}_${monitor.width}x${monitor.height}_${scale}_${pictureOptions}_${primaryColor}_${secondaryColor}_${shadingType}_${blurRadius}_${brightness}_${stripWidth}x${stripHeight}_v9`;
                const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, cacheKey, -1).substring(0, 8);
                const path = GLib.build_filenamev([PANEL_CACHE_DIR, `${PANEL_CACHE_PREFIX}${USER_NAME}-${hash}.png`]);

                if (hasCache(cacheKey)) {
                    const cached = getCache(cacheKey);
                    if (cached?.imagePath && Gio.File.new_for_path(cached.imagePath).query_exists(null)) {
                        if (runId === this._updateStripId) {
                            this._panelStripPath = cached.imagePath;
                            this._panelStripWidth = stripWidth;
                            this._panelStripHeight = stripHeight;
                            this.applyVibrancyStyle();
                        }
                        return;
                    }
                }

                let imagePath = null;
                const isColorBackground = pictureOptions === 'none';
                if (!isColorBackground && targetFilePath) {
                    const info = await getWallpaperFileInfo(targetFilePath);
                    const origW = info?.width > 0 ? info.width : physicalWidth;
                    const origH = info?.height > 0 ? info.height : Math.max(1, Math.round(monitor.height * scale));
                    // Load the original wallpaper at monitor width (plus no
                    // artificial monitor-height crop). The sampler owns all
                    // picture-options geometry so the visible top edge is
                    // mapped exactly once.
                    const loadW = Math.max(1, physicalWidth);
                    const loadH = Math.max(1, Math.round(origH * (loadW / origW)));
                    const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, loadW, loadH, false);
                    const result = createBlurredPanelStrip({
                        pixbuf,
                        monitorBounds: { ...monitor, pictureOptions },
                        stripWidth: physicalWidth,
                        stripHeight: physicalHeight,
                        blurRadius: blurRadius * scale,
                        brightness,
                    });
                    if (result) {
                        GLib.mkdir_with_parents(PANEL_CACHE_DIR, 0o755);
                        result.savev(path, 'png', [], []);
                        Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                        imagePath = path;
                    }
                }

                if (imagePath) {
                    setCache(cacheKey, { imagePath });
                    saveCache();
                    try {
                        const dir = Gio.File.new_for_path(PANEL_CACHE_DIR);
                        if (dir.query_exists(null)) {
                            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                            const currentSuffix = `-${hash}.png`;
                            let fileInfo;
                            while ((fileInfo = enumerator.next_file(null)) !== null) {
                                const name = fileInfo.get_name();
                                if (name.startsWith(`${PANEL_CACHE_PREFIX}${USER_NAME}-`) && !name.endsWith(currentSuffix)) {
                                    try { dir.get_child(name).delete(null); } catch (_) {}
                                }
                            }
                            enumerator.close(null);
                        }
                    } catch (cleanupErr) {
                        console.error(`[WACK/Vibrancy] Failed to clean panel strip cache: ${cleanupErr}`);
                    }
                }

                if (runId === this._updateStripId) {
                    this._panelStripPath = imagePath;
                    this._panelStripWidth = stripWidth;
                    this._panelStripHeight = stripHeight;
                    this.applyVibrancyStyle();
                    console.debug(`[WACK/Vibrancy] panel strip regenerated: ${imagePath || 'none'} (monitor=${monitor.width}x${monitor.height}, scale=${scale}, css=${stripWidth}x${stripHeight}, image=${physicalWidth}x${physicalHeight})`);
                }
            } catch (e) {
                console.error(`[WACK/Vibrancy] Failed to regenerate static panel strip: ${e}`);
            } finally {
                this._stripPromise = null;
                if (this._stripRegenerationPending && this._settings?.get_boolean('enable-vibrancy')) {
                    this._stripRegenerationPending = false;
                    this._regeneratePanelStrip();
                }
            }
        })();
        return this._stripPromise;
    }

    _initBmsSettings() {
        if (this._vibrancyBmsSig && this._bmsSettings) {
            this._bmsSettings.disconnect(this._vibrancyBmsSig);
            this._vibrancyBmsSig = null;
            this._bmsSettings = null;
        }

        try {
            const ext = Main.extensionManager.lookup('blur-my-shell@aunetx');
            if (ext) {
                const schemaDir = ext.dir.get_child('schemas');
                if (schemaDir.query_exists(null)) {
                    const source = Gio.SettingsSchemaSource.new_from_directory(
                        schemaDir.get_path(),
                        Gio.SettingsSchemaSource.get_default(),
                        false
                    );
                    const schema = source.lookup('org.gnome.shell.extensions.blur-my-shell.panel', true);
                    if (schema) {
                        this._bmsSettings = new Gio.Settings({ settings_schema: schema });
                    }
                }
            }
        } catch (err) {
            this._bmsSettings = null;
        }

        if (this._bmsSettings) {
            this._vibrancyBmsSig = this._bmsSettings.connect(
                'changed::blur', () => this._syncVibrancy()
            );
        }
    }

    _bmsHasPanelBlur() {
        try {
            const bmsExt = Main.extensionManager.lookup('blur-my-shell@aunetx');
            const bmsEnabled = bmsExt && bmsExt.state === 1; // 1 = ExtensionState.ENABLED
            if (!bmsEnabled)
                return false;
            return this._bmsSettings?.get_boolean('blur') ?? false;
        } catch {
            return false;
        }
    }

    _getApca(txtR, txtG, txtB, bgR, bgG, bgB) {
        const simpleExp = (chan) => Math.pow(chan / 255.0, 2.4);
        let txtY = 0.2126729 * simpleExp(txtR) + 0.7151522 * simpleExp(txtG) + 0.0721750 * simpleExp(txtB);
        let bgY = 0.2126729 * simpleExp(bgR) + 0.7151522 * simpleExp(bgG) + 0.0721750 * simpleExp(bgB);
        const blkThrs = 0.022;
        const blkClmp = 1.414;
        txtY = (txtY > blkThrs) ? txtY : txtY + Math.pow(blkThrs - txtY, blkClmp);
        bgY = (bgY > blkThrs) ? bgY : bgY + Math.pow(blkThrs - bgY, blkClmp);
        if (Math.abs(bgY - txtY) < 0.0005) return 0.0;
        let sapc = 0.0;
        if (bgY > txtY) {
            sapc = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
            return (sapc < 0.1) ? 0.0 : (sapc - 0.027) * 100.0;
        } else {
            sapc = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14;
            return (sapc > -0.1) ? 0.0 : (sapc + 0.027) * 100.0;
        }
    }

    _getBorrowVenturaLight() {
        const style = this._settings.get_int('vibrancy-style');
        const isDark = this._isDarkColorScheme();
        const isOverview = Main.overview.visibleTarget;
        const isLockscreen = Main.sessionMode.currentMode === 'unlock-dialog' && !Main.sessionMode.hasWindows;

        if (style === 1 && !isDark && !isOverview && !isLockscreen && this._currentColors) {
            const leftColor = this._currentColors.left;
            const rightColor = this._currentColors.right;
            const centerColor = this._currentColors.center;

            const leftContrast = Math.abs(this._getApca(255, 255, 255, leftColor.r, leftColor.g, leftColor.b));
            const rightContrast = Math.abs(this._getApca(255, 255, 255, rightColor.r, rightColor.g, rightColor.b));
            const centerContrast = Math.abs(this._getApca(255, 255, 255, centerColor.r, centerColor.g, centerColor.b));

            const isWallpaperLenient = this._isWallpaperLenient();
            const isLowContrast = (contrast) => contrast < 50;

            if (isWallpaperLenient) {
                let lowContrastRegions = 0;
                if (isLowContrast(leftContrast)) lowContrastRegions++;
                if (isLowContrast(centerContrast)) lowContrastRegions++;
                if (isLowContrast(rightContrast)) lowContrastRegions++;
                return lowContrastRegions >= 2;
            } else {
                const isWhiteRegion = (color, contrast) => {
                    const maxVal = Math.max(color.r, color.g, color.b);
                    const minVal = Math.min(color.r, color.g, color.b);
                    const chroma = (maxVal - minVal) / 255.0;
                    return contrast < 50 && chroma < 0.30;
                };

                let candidates = 0;
                if (isWhiteRegion(leftColor, leftContrast)) candidates++;
                if (isWhiteRegion(centerColor, centerContrast)) candidates++;
                if (isWhiteRegion(rightColor, rightContrast)) candidates++;
                return candidates >= 2;
            }
        }
        return false;
    }

    _isWallpaperLenient() {
        if (!this._currentColors) return false;

        // ── Helpers ──────────────────────────────────────────────────────────

        const getSaturation = color => {
            const r = color.r / 255, g = color.g / 255, b = color.b / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max === min) return 0;
            const l = (max + min) / 2;
            return (max - min) / (1 - Math.abs(2 * l - 1));
        };

        const rgbToHue = (r, g, b) => {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h = 0;
            if (max !== min) {
                const d = max - min;
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return h * 360;
        };

        const hueDist = (h1, h2) => Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));

        // Shared hue-variety analysis used by both analysis paths below.
        // Returns true/false when a determination can be made, null when all
        // samples are achromatic (caller should try next data source).
        const analyzeHueVariety = (rawColors, satThreshold) => {
            const saturated = rawColors.filter(c => getSaturation(c) >= satThreshold);
            if (saturated.length === 0) return null; // all achromatic, try next source
            if (saturated.length < 3) return false;  // too few saturated colors to form a tricolor

            const hues = saturated.map(c => rgbToHue(c.r, c.g, c.b));

            // A tricolor is defined by a bounce-back:
            // There exists some stop L near the left, some stop R near the right,
            // such that L and R have similar hues, but some intermediate stop M
            // has a completely different, high-contrast hue.
            for (let l = 0; l < Math.min(3, hues.length); l++) {
                for (let r = Math.max(l + 2, hues.length - 3); r < hues.length; r++) {
                    const distLR = hueDist(hues[l], hues[r]);
                    if (distLR <= 60) {
                        for (let m = l + 1; m < r; m++) {
                            if (hueDist(hues[m], hues[l]) >= 80 && hueDist(hues[m], hues[r]) >= 80) {
                                return true; // High-contrast tricolor bounce-back detected!
                            }
                        }
                    }
                }
            }
            return false;
        };

        // ── Panel-strip stops (sole source) ──────────────────────────────────
        // 10 equidistant columns sampled from the top 5% of the image —
        // exactly the region the panel sits over. Only this matters for the
        // gradient mode decision; scanning the full image added body-color
        // noise that biased the system toward lenient.
        const rawStops = this._currentColors.rawStops;
        if (rawStops && rawStops.length >= 4) {
            const result = analyzeHueVariety(rawStops, 0.10);
            if (result !== null) return result;
        } else {
            const stops = this._currentColors.stops;
            if (stops && stops.length >= 4) {
                const result = analyzeHueVariety(stops.map(s => s.color), 0.10);
                if (result !== null) return result;
            }
        }

        // ── 3. Coarse 3-point fallback ────────────────────────────────────────
        // Used for colour-only backgrounds and very old cached results.
        const leftColor = this._currentColors.rawLeft || this._currentColors.left;
        const rightColor = this._currentColors.rawRight || this._currentColors.right;
        const centerColor = this._currentColors.rawCenter || this._currentColors.center;

        const satL = getSaturation(leftColor);
        const satC = getSaturation(centerColor);
        const satR = getSaturation(rightColor);

        const saturatedCount = (satL >= 0.15 ? 1 : 0) +
            (satC >= 0.15 ? 1 : 0) + (satR >= 0.15 ? 1 : 0);
        if (saturatedCount < 2) return false;

        const hLeft = rgbToHue(leftColor.r, leftColor.g, leftColor.b);
        const hCenter = rgbToHue(centerColor.r, centerColor.g, centerColor.b);
        const hRight = rgbToHue(rightColor.r, rightColor.g, rightColor.b);

        const diffLC = hueDist(hLeft, hCenter);
        const diffCR = hueDist(hCenter, hRight);
        const diffLR = hueDist(hLeft, hRight);

        const linearityError = diffLC + diffCR - diffLR; // same as nonLinearity for 3 points

        return linearityError >= 80;
    }

    _syncVibrancy() {
        const enabled = this._settings.get_boolean('enable-vibrancy');
        const blurMode = this._settings.get_int('vibrancy-blur-mode');
        const bmsConflict = this._bmsHasPanelBlur();

        if (!enabled) {
            this.applyVibrancyStyle();
            return;
        }

        const isDark = this._isDarkColorScheme();
        const style = this._settings.get_int('vibrancy-style');
        const borrowVenturaLight = this._getBorrowVenturaLight();
        const useVenturaLight = (style === 2 || borrowVenturaLight) && !isDark;

        const effectiveStyle = useVenturaLight ? 2 : 1;

        let resolvedBlurMode = blurMode;
        if (blurMode === 3) {
            resolvedBlurMode = this._isWallpaperLenient() ? 2 : 1;
        }

        let radius, brightness;
        if (bmsConflict) {
            radius = 0;
            brightness = 1.0;
        } else {
            radius = resolvedBlurMode === 1 ? RADIUS_LINEAR : RADIUS_LENIENT;
            brightness = (effectiveStyle === 2) ? 0.80 : (isDark ? 0.90 : 0.95);
        }

        this._regeneratePanelStrip();
        this.applyVibrancyStyle();
    }

    _ensurePanelBackdrop() {
        if (this._panelBackdrop && !this._panelBackdrop.destroyed)
            return;

        this._panelBackdrop = new St.Widget({
            name: 'wackPanelBackdrop',
            reactive: false,
            can_focus: false,
            width: 0,
            height: 0,
        });

        this._panelBackdropOverlay = new St.Widget({
            name: 'wackPanelBackdropOverlay',
            reactive: false,
            can_focus: false,
            width: 0,
            height: 0,
        });

        this._panelProximityOverlay = new St.Widget({
            name: 'wackPanelProximityOverlay',
            reactive: false,
            can_focus: false,
            width: 0,
            height: 0,
            opacity: 0,
        });

        // Panel.vfunc_allocate() only allocates panelLeft/panelCenter/panelRight.
        // The wallpaper, vibrancy, and proximity surfaces are dedicated panel
        // children. The proximity surface is a direct sibling so it can paint
        // above the vibrancy surface without depending on nested-widget paint
        // propagation.
        Main.panel.insert_child_at_index(this._panelBackdrop, 0);
        Main.panel.insert_child_at_index(this._panelBackdropOverlay, 1);
        Main.panel.insert_child_at_index(this._panelProximityOverlay, 2);
        this._allocatePanelBackdrop();
    }

    _allocatePanelBackdrop() {
        const backdrop = this._panelBackdrop;
        if (!backdrop || backdrop.destroyed || !Main.panel)
            return;

        const width = Math.max(0, Math.round(Main.panel.width));
        const height = Math.max(0, Math.round(Main.panel.height));
        const box = new Clutter.ActorBox();
        box.set_origin(0, 0);
        // Allocate the backdrop to the full static snapshot extent. Its own
        // clip is the actual panel allocation, so the snapshot is anchored
        // at its top edge rather than being cropped by a short actor first.
        const backdropHeight = Math.max(height, Math.round(this._panelStripHeight));
        box.set_size(width, backdropHeight);
        backdrop.allocate(box);
        backdrop.set_clip(0, 0, width, height);

        const overlay = this._panelBackdropOverlay;
        if (overlay && !overlay.destroyed) {
            overlay.set_position(0, 0);
            overlay.set_size(width, height);
            overlay.set_clip(0, 0, width, height);
        }

        const proximityOverlay = this._panelProximityOverlay;
        if (proximityOverlay && !proximityOverlay.destroyed) {
            const proximityBox = new Clutter.ActorBox();
            proximityBox.set_origin(0, 0);
            proximityBox.set_size(width, height);
            proximityOverlay.allocate(proximityBox);
            proximityOverlay.set_clip(0, 0, width, height);
            // Keep the proximity layer above the vibrancy surface but below
            // the real panel content boxes. Reassert this after allocations
            // because panel children can be reordered by Shell.
            try {
                Main.panel.set_child_above_sibling(proximityOverlay, this._panelBackdropOverlay);
                const firstPanelBox = Main.panel._leftBox;
                if (firstPanelBox)
                    Main.panel.set_child_below_sibling(proximityOverlay, firstPanelBox);
            } catch (_) { }
        }
    }

    _setPanelBackdropStyle(imagePath) {
        const backdrop = this._panelBackdrop;
        if (!backdrop || backdrop.destroyed)
            return;

        if (!imagePath) {
            if (this._panelBackdropStyle !== null) {
                backdrop.set_style(null);
                this._panelBackdropStyle = null;
            }
            backdrop.hide();
            return;
        }

        // The backdrop is a real child actor, not Main.panel's CSS background.
        // Give it the exact panel allocation and clip its paint to that actor.
        const imageUri = Gio.File.new_for_path(imagePath).get_uri();
        const style = [
            `background-image: url("${imageUri}") !important;`,
            'background-color: transparent !important;',
            `background-size: ${this._panelStripWidth}px auto !important;`,
            'background-position: 0 0 !important;',
            'background-repeat: no-repeat !important;',
        ].join(' ');

        if (this._panelBackdropStyle !== style) {
            backdrop.set_style(style);
            this._panelBackdropStyle = style;
        }

        const width = Math.max(0, Math.round(Main.panel.width));
        const height = Math.max(0, Math.round(Main.panel.height));
        const box = new Clutter.ActorBox();
        box.set_origin(0, 0);
        box.set_size(width, height);
        backdrop.allocate(box);
        backdrop.set_clip(0, 0, width, height);
        backdrop.set_opacity(255);
        backdrop.show();

        // Keep the backdrop immediately behind the three actual panel boxes.
        // Do not lower it beneath the panel's child stack indiscriminately.
        try {
            const firstPanelBox = Main.panel._leftBox;
            if (firstPanelBox)
                Main.panel.set_child_below_sibling(backdrop, firstPanelBox);
            else
                backdrop.lower_bottom();
        } catch (_) {
            backdrop.lower_bottom();
        }
    }

    _setPanelBackdropOverlayStyle(css) {
        const overlay = this._panelBackdropOverlay;
        if (!overlay || overlay.destroyed)
            return;

        if (!css) {
            // This surface is also the parent of the proximity-color layer.
            // It must remain mapped even when there is no Ventura tint; hiding
            // it would implicitly hide its proximity child as well. Keep the
            // surface transparent instead.
            const style = 'background-color: transparent !important; background-image: none !important;';
            if (this._panelBackdropOverlayStyle !== style) {
                overlay.set_style(style);
                this._panelBackdropOverlayStyle = style;
            }

            const width = Math.max(0, Math.round(Main.panel.width));
            const height = Math.max(0, Math.round(Main.panel.height));
            const box = new Clutter.ActorBox();
            box.set_origin(0, 0);
            box.set_size(width, height);
            overlay.allocate(box);
            overlay.set_clip(0, 0, width, height);
            overlay.set_opacity(255);
            overlay.show();

            try {
                Main.panel.set_child_above_sibling(overlay, this._panelBackdrop);
            } catch (_) { }
            return;
        }

        const style = `background-color: ${css} !important;`;
        if (this._panelBackdropOverlayStyle !== style) {
            overlay.set_style(style);
            this._panelBackdropOverlayStyle = style;
        }

        const width = Math.max(0, Math.round(Main.panel.width));
        const height = Math.max(0, Math.round(Main.panel.height));
        const box = new Clutter.ActorBox();
        box.set_origin(0, 0);
        box.set_size(width, height);
        overlay.allocate(box);
        overlay.set_clip(0, 0, width, height);
        overlay.set_opacity(255);
        overlay.show();

        try {
            Main.panel.set_child_above_sibling(overlay, this._panelBackdrop);
        } catch (_) { }
    }

    _parseProximityColor(css) {
        const value = String(css ?? '').trim().replace(/'/g, '');
        let match = value.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i);
        if (match) {
            const hex = match[1];
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
                a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }

        match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
        if (match) {
            const alpha = match[4] === undefined ? 1 :
                (match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]));
            return {
                r: Math.round(Math.max(0, Math.min(255, parseFloat(match[1])))),
                g: Math.round(Math.max(0, Math.min(255, parseFloat(match[2])))),
                b: Math.round(Math.max(0, Math.min(255, parseFloat(match[3])))),
                a: Math.max(0, Math.min(1, alpha)),
            };
        }
        return null;
    }

    _setProximityPanelColor(css, alpha) {
        const overlay = this._panelProximityOverlay;
        if (!overlay || overlay.destroyed)
            return;

        const value = String(css ?? '').trim().replace(/'/g, '');
        const style = `background-color: ${value || 'transparent'} !important; background-image: none !important;`;
        if (this._panelProximityOverlayStyle !== style) {
            overlay.set_style(style);
            this._panelProximityOverlayStyle = style;
        }
        overlay.set_opacity(Math.round(Math.max(0, Math.min(1, alpha)) * 255));
    }

    _cancelProximityAnimation() {
        if (this._proximityAnimationId) {
            GLib.source_remove(this._proximityAnimationId);
            this._proximityAnimationId = 0;
        }
        this._proximityAnimationToken++;
    }

    _animateProximity(active, color) {
        this._cancelProximityAnimation();
        const token = this._proximityAnimationToken;
        const started = GLib.get_monotonic_time();
        const duration = 250000;
        const from = active ? 0 : 1;
        const to = active ? 1 : 0;
        const overlay = this._panelProximityOverlay;
        const backdrop = this._panelBackdrop;

        if (overlay && !overlay.destroyed) {
            try {
                Main.panel.set_child_above_sibling(overlay, this._panelBackdropOverlay);
                const firstPanelBox = Main.panel._leftBox;
                if (firstPanelBox)
                    Main.panel.set_child_below_sibling(overlay, firstPanelBox);
            } catch (_) { }
            overlay.show();
            overlay.set_opacity(Math.round(from * 255));
        }
        if (backdrop && !backdrop.destroyed) {
            // The blurred wallpaper remains fully visible underneath the
            // proximity colour. Only the colour actor is animated.
            backdrop.set_opacity(255);
            backdrop.show();
        }

        const tick = () => {
            if (token !== this._proximityAnimationToken)
                return GLib.SOURCE_REMOVE;

            const elapsed = Math.max(0, GLib.get_monotonic_time() - started);
            const t = Math.min(1, elapsed / duration);
            const eased = 1 - Math.pow(1 - t, 2);
            const alpha = from + (to - from) * eased;

            this._setProximityPanelColor(color, alpha);

            if (t >= 1) {
                this._proximityAnimationId = 0;
                if (!active && overlay && !overlay.destroyed)
                    overlay.hide();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        this._proximityAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, tick);
        GLib.Source.set_name_by_id(this._proximityAnimationId, '[wack-shell] panel proximity color crossfade');
        tick();
    }

    setPanelProximity(active, bgCss, fgCss = null) {
        this._ensurePanelBackdrop();
        const overlay = this._panelProximityOverlay;
        const backdrop = this._panelBackdrop;
        if (!overlay || overlay.destroyed)
            return;

        const isDark = this._isDarkColorScheme();
        const configuredColor = this._settings?.get_string(isDark ? 'dark-bg-color' : 'light-bg-color') || '';
        const color = String(configuredColor || bgCss || '').replace(/'/g, '').trim();

        if (!active || !color) {
            this._panelProximityActive = false;
            this._animateProximity(false, this._proximityPanelColor || color || 'rgb(0, 0, 0)');
            this._proximityPanelColor = null;
            return;
        }

        this._panelProximityActive = true;
        this._proximityPanelColor = color;
        this._allocatePanelBackdrop();

        // The proximity actor is a direct sibling above the vibrancy surface
        // and below the real panel content.
        this._setProximityPanelColor(color, 0);
        overlay.show();
        if (backdrop && !backdrop.destroyed) {
            backdrop.set_opacity(255);
            backdrop.show();
        }

        console.debug(`[WACK/Vibrancy] proximity color layered above vibrancy: ${color}`);
        this._animateProximity(true, color);
    }

    applyVibrancyStyle() {
        const enabled = this._settings.get_boolean('enable-vibrancy');
        const blurMode = this._settings.get_int('vibrancy-blur-mode');
        const style = this._settings.get_int('vibrancy-style');
        const bmsConflict = this._bmsHasPanelBlur();
        const vibrancyClasses = ['panel-ventura-light', 'panel-bigsur'];

        const clearVibrancyClasses = () => {
            for (const cls of vibrancyClasses) {
                Main.panel.remove_style_class_name(cls);
            }
        };

        if (!enabled) {
            this._setPanelBackdropStyle(null);
            this._setPanelBackdropOverlayStyle(null);
            if (this._vibrancyStyleActive) {
                this._settingStyle = true;
                try {
                    Main.panel.set_style(null);
                    clearVibrancyClasses();
                    Main.panel.remove_style_class_name('light-contrast');
                } finally {
                    this._settingStyle = false;
                }
                this._vibrancyStyleActive = false;
        this._proximityAnimationId = 0;
        this._proximityAnimationToken = 0;
        this._proximityPanelColor = null;
            }
            return;
        }

        const isDark = this._isDarkColorScheme();
        const isOverview = Main.overview.visibleTarget;
        const isLockscreen = Main.sessionMode.currentMode === 'unlock-dialog' && !Main.sessionMode.hasWindows;

        const borrowVenturaLight = this._getBorrowVenturaLight();
        const useVenturaLight = (style === 2 || borrowVenturaLight) && !isDark;

        if (useVenturaLight && !isOverview && !isLockscreen && !bmsConflict) {
            Main.panel.add_style_class_name('light-contrast');
        } else {
            Main.panel.remove_style_class_name('light-contrast');
        }

        let targetClass = '';
        let panelCSS = '';
        this._panelBackdropOverlayTint = null;

        if (bmsConflict) {
            targetClass = 'panel-bigsur';
        } else if (isOverview || isLockscreen) {
            targetClass = 'panel-bigsur';
        } else if (useVenturaLight) {
            targetClass = 'panel-ventura-light';
            const leftColor = this._currentColors?.left || { r: 128, g: 128, b: 128 };
            const rightColor = this._currentColors?.right || { r: 128, g: 128, b: 128 };
            const centerColor = this._currentColors?.center || { r: 128, g: 128, b: 128 };

            const avgR = (leftColor.r + rightColor.r + centerColor.r) / 3;
            const avgG = (leftColor.g + rightColor.g + centerColor.g) / 3;
            const avgB = (leftColor.b + rightColor.b + centerColor.b) / 3;

            const contrastLc = this._getApca(255, 255, 255, avgR, avgG, avgB);
            const absLc = Math.abs(contrastLc);

            let factor = Math.max(0, Math.min(1, (100.0 - absLc) / 100.0));

            const maxVal = Math.max(avgR, avgG, avgB);
            const minVal = Math.min(avgR, avgG, avgB);
            const chroma = (maxVal - minVal) / 255.0;

            factor = Math.max(0, Math.min(1, factor + chroma * 0.5));

            const alpha = 0.375 + (0.475 * factor);
            panelCSS = 'background-color: transparent !important;';
            this._panelBackdropOverlayTint = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
        } else {
            targetClass = 'panel-bigsur';
            panelCSS = 'background-color: transparent !important;';
            this._panelBackdropOverlayTint = null;
        }

        // The static wallpaper is rendered by dedicated child actors. Make
        // sure they exist before applying their styles; otherwise the first
        // style pass can silently miss the overlay actor.
        this._ensurePanelBackdrop();

        if (useVenturaLight && !isOverview && !isLockscreen && !bmsConflict) {
            this._setPanelBackdropOverlayStyle(this._panelBackdropOverlayTint);
        } else {
            this._setPanelBackdropOverlayStyle(null);
        }

        // The backdrop actor is allocated to Main.panel's actual allocation,
        // so its CSS background is clipped by that actor's own bounds. It does
        // not participate in Panel's preferred-size calculation because the
        // core Panel allocator only allocates its three content boxes.
        const showBackdrop = this._panelStripPath &&
            !isOverview && !isLockscreen && !bmsConflict;
        this._setPanelBackdropStyle(showBackdrop ? this._panelStripPath : null);

        try {
            const box = Main.panel.get_allocation_box();
            console.debug(`[WACK/Vibrancy] panel allocation=${box.get_width()}x${box.get_height()}, static backdrop=${this._panelStripWidth}x${this._panelStripHeight}`);
        } catch (_) { }

        this._settingStyle = true;
        try {
            clearVibrancyClasses();
            if (targetClass) {
                Main.panel.add_style_class_name(targetClass);
            }

            if (this._panelProximityActive) {
                // Proximity owns the panel background while its crossfade is
                // active; do not overwrite it with vibrancy's transparent CSS.
            } else if (panelCSS) {
                if (Main.panel.style !== panelCSS) {
                    Main.panel.set_style(panelCSS);
                }
            } else {
                if (Main.panel.style !== null && Main.panel.style !== '') {
                    Main.panel.set_style(null);
                }
            }
        } finally {
            this._settingStyle = false;
        }

        const effectiveStyle = useVenturaLight ? 2 : 1;
        let resolvedBlurMode = blurMode;
        if (blurMode === 3) {
            resolvedBlurMode = this._isWallpaperLenient() ? 2 : 1;
        }
        let brightness, radius;
        if (bmsConflict) {
            radius = 0;
            brightness = 1.0;
        } else {
            radius = resolvedBlurMode === 1 ? RADIUS_LINEAR : RADIUS_LENIENT;
            brightness = (effectiveStyle === 2) ? 0.80 : (isDark ? 0.90 : 0.95);
        }
        this._vibrancyStyleActive = true;

        const isLockMode = Main.sessionMode.currentMode === 'unlock-dialog';
        const isShieldActive = Main.screenShield && (Main.screenShield.active || Main.screenShield.locked);
        const isOverviewActive = Main.overview.visible || Main.overview.visibleTarget;

        if (!isLockMode && !isShieldActive && !isOverviewActive) {
            global.wack_panel_cached_classes = Main.panel.get_style_class_name() || '';
            global.wack_panel_cached_style = Main.panel.style || '';
            global.wack_panel_cached_proximity_bg = null;
            global.wack_panel_cached_proximity_fg = null;
            global.wack_panel_cached_foreground = Main.panel.has_style_class_name('light-contrast') ? 'rgb(20, 20, 20)' : null;
            global.wack_panel_cached_blur_mode = resolvedBlurMode;
            global.wack_panel_cached_brightness = brightness;
        }
    }

    _isDarkColorScheme() {
        try {
            const scheme = this._desktopSettings?.get_string('color-scheme') ?? '';
            return scheme === 'prefer-dark';
        } catch {
            return false;
        }
    }
}
