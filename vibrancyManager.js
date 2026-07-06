import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';

import * as ColorManager from './colorManager.js';
import { PanelBlur, RADIUS_LINEAR, RADIUS_LENIENT } from './panelBlur.js';

export default class VibrancyManager {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._desktopSettings = null;
        this._bgSettings = null;
        this._bmsSettings = null;
        this._vibrancyBmsSig = null;
        this._panelBlur = null;
        this._settingStyle = false;
        this._updateColorsId = 0;
        this._retryCount = 0;
        this._retryTimeoutId = 0;
        this._currentColors = null;
        this._vibrancyStyleActive = false;
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

        try {
            this._desktopSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        } catch (e) {
            this._desktopSettings = null;
        }

        this._bgSettings.connectObject(
            'changed::picture-uri', () => this._updateWallpaperColors(),
            'changed::picture-uri-dark', () => this._updateWallpaperColors(),
            'changed::picture-options', () => this._updateWallpaperColors(),
            'changed::primary-color', () => this._updateWallpaperColors(),
            'changed::secondary-color', () => this._updateWallpaperColors(),
            'changed::color-shading-type', () => this._updateWallpaperColors(),
            this
        );

        if (this._desktopSettings) {
            this._desktopSettings.connectObject(
                'changed::color-scheme', () => this._updateWallpaperColors(),
                this
            );
        }

        Main.panel.connectObject('notify::style', () => {
            if (this._settingStyle) return;
            this.applyVibrancyStyle();
        }, this);

        // Initialize PanelBlur and BMS integrations
        this._panelBlur = new PanelBlur();
        this._vibrancyBmsSig = null;
        this._extStateChangedId = 0;

        // React to our own settings changes
        this._settings.connectObject(
            'changed::enable-vibrancy', () => this._syncVibrancy(),
            'changed::vibrancy-blur-mode', () => this._syncVibrancy(),
            'changed::vibrancy-style', () => this._syncVibrancy(),
            this
        );

        if (this._desktopSettings) {
            this._desktopSettings.connectObject(
                'changed::color-scheme', () => this._syncVibrancy(),
                this
            );
        }

        this._initBmsSettings();

        try {
            Main.extensionManager.connectObject('extension-state-changed', (_obj, ext) => {
                if (ext.uuid === 'blur-my-shell@aunetx') {
                    this._initBmsSettings();
                    this._syncVibrancy();
                }
            }, this);
        } catch (e) {
            // extensionManager may not support connectObject in all versions
        }

        this._updateWallpaperColors();
        this._syncVibrancy();
    }

    disable() {
        if (this._retryTimeoutId) {
            GLib.source_remove(this._retryTimeoutId);
            this._retryTimeoutId = 0;
        }

        Main.panel.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);

        if (this._panelBlur) {
            this._panelBlur.disable();
            this._panelBlur = null;
        }

        if (this._bmsSettings) {
            if (this._vibrancyBmsSig)
                this._bmsSettings.disconnect(this._vibrancyBmsSig);
            this._bmsSettings = null;
            this._vibrancyBmsSig = null;
        }

        if (this._vibrancyStyleActive) {
            Main.panel.set_style(null);
            this._vibrancyStyleActive = false;
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
        } catch (e) {
            if (runId === this._updateColorsId) {
                logError(e, 'WACK Shell: Failed to update wallpaper colors');
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

        const leftColor = this._currentColors.left;
        const rightColor = this._currentColors.right;
        const centerColor = this._currentColors.center;

        const getSaturation = (color) => {
            const r = color.r / 255;
            const g = color.g / 255;
            const b = color.b / 255;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            if (max === min) return 0;
            const l = (max + min) / 2;
            return (max - min) / (1 - Math.abs(2 * l - 1));
        };

        const satL = getSaturation(leftColor);
        const satC = getSaturation(centerColor);
        const satR = getSaturation(rightColor);

        if (satL < 0.15 || satC < 0.15 || satR < 0.15) {
            return false;
        }

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

        const hueDistance = (h1, h2) => Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));

        const hLeft = rgbToHue(leftColor.r, leftColor.g, leftColor.b);
        const hCenter = rgbToHue(centerColor.r, centerColor.g, centerColor.b);
        const hRight = rgbToHue(rightColor.r, rightColor.g, rightColor.b);

        const diffLC = hueDistance(hLeft, hCenter);
        const diffCR = hueDistance(hCenter, hRight);
        const diffLR = hueDistance(hLeft, hRight);

        const linearityError = Math.abs(diffLC + diffCR - diffLR);

        return (diffLC > 35 && diffCR > 35 && linearityError > 30) ||
            (diffLC > 18 && diffCR > 18 && diffLR > 45);
    }

    _syncVibrancy() {
        const enabled = this._settings.get_boolean('enable-vibrancy');
        const blurMode = this._settings.get_int('vibrancy-blur-mode');
        const bmsConflict = this._bmsHasPanelBlur();

        if (!enabled) {
            this._panelBlur.disable();
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

        if (this._panelBlur.enabled) {
            this._panelBlur.updateParams(radius, brightness);
        } else {
            this._panelBlur.enable(radius, brightness);
        }

        this.applyVibrancyStyle();
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
            }
            return;
        }

        if (Main.panel.has_style_class_name('panel-proximity'))
            return;

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
            panelCSS = `background-color: rgba(255, 255, 255, ${alpha.toFixed(3)}) !important;`;
        } else {
            targetClass = 'panel-bigsur';
        }

        this._settingStyle = true;
        try {
            clearVibrancyClasses();
            if (targetClass) {
                Main.panel.add_style_class_name(targetClass);
            }

            if (panelCSS) {
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
        if (this._panelBlur && this._panelBlur.enabled) {
            this._panelBlur.updateParams(radius, brightness);
        }

        this._vibrancyStyleActive = true;
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
