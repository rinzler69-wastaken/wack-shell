import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    WackLogoButton,
    WackAppMenuButton,
    WackWorkspaceButton
} from './panelComponents.js';
import VibrancyManager from './vibrancyManager.js';
import { APP_GRID_WORKSPACE_RATIO, APP_GRID_WORKSPACE_FADE_RANGE, APP_GRID_WORKSPACE_FADE_SNAP } from './constants.js';

const PowerProfilesIface = `<node>
<interface name="net.hadess.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
</interface>
</node>`;

const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PowerProfilesIface);




export default class WackShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.lastPanelStateIsProximity = false;
        global.wack_proximity_active = false;
        global.wack_proximity_bg = null;
        global.wack_proximity_fg = null;
        global.wack_panel_cached_style = '';
        global.wack_panel_cached_classes = '';
        global.wack_panel_cached_proximity_bg = null;
        global.wack_panel_cached_proximity_fg = null;
        global.wack_panel_cached_foreground = null;
        global.wack_panel_cached_blur_mode = null;
        global.wack_panel_cached_brightness = null;

        // Hide native activities button and suppress it from showing up
        const activities = Main.panel.statusArea['activities'];
        if (activities?.container) {
            activities.container.hide();
            activities.container.connectObject('show', () => {
                activities.container.hide();
            }, this);
        }
        this._activities = activities;

        this._logoButton = null;
        this._workspaceButton = null;
        this._appMenuButton = null;

        this._lastHasWindows = Main.sessionMode.hasWindows;

        this._sessionModeOwner = {};
        Main.sessionMode.connectObject('updated', () => this._syncSessionModeUI(), this._sessionModeOwner);

        this._settings.connectObject(
            'changed::show-logo-menu', () => this._syncLogoMenu(),
            'changed::show-workspace-widget', () => this._syncWorkspaceWidget(),
            'changed::show-app-menu', () => this._syncAppMenu(),
            this
        );

        this._syncLogoMenu();
        this._syncWorkspaceWidget();
        this._syncAppMenu();
        this._initProximity();

        // Initialize and enable VibrancyManager
        this._vibrancyManager = new VibrancyManager(this, this._settings);
        this._vibrancyManager.enable();

        this._windowSnapshotCachingEnabled = true;
        this._lockscreenSettings = null;

        try {
            const lockExt = Main.extensionManager.lookup('wack-lockscreen-clock@rinzler69-wastaken.github.com');
            if (lockExt && lockExt.state === 1 /* ExtensionState.ENABLED */) {
                const schemaDir = lockExt.dir.get_child('schemas');
                if (schemaDir.query_exists(null)) {
                    const source = Gio.SettingsSchemaSource.new_from_directory(
                        schemaDir.get_path(),
                        Gio.SettingsSchemaSource.get_default(),
                        false
                    );
                    const schema = source.lookup('org.gnome.shell.extensions.wack-lockscreen-clock', true);
                    if (schema) {
                        this._lockscreenSettings = new Gio.Settings({ settings_schema: schema });
                        this._lockscreenSettings.connectObject(
                            'changed::lockscreen-mode', () => this._syncWindowSnapshotCaching(),
                            'changed::cupertino-unlock-fade', () => this._syncWindowSnapshotCaching(),
                            this
                        );
                    }
                }
            }
        } catch {
        }

        this._powerProfilesProxy = null;
        try {
            this._powerProfilesProxy = new PowerProfilesProxy(
                Gio.DBus.system,
                'net.hadess.PowerProfiles',
                '/net/hadess/PowerProfiles',
                (proxy, error) => {
                    if (error) {
                        this._syncWindowSnapshotCaching();
                        return;
                    }
                    if (!this._powerProfilesProxy)
                        return;
                    proxy.connectObject('g-properties-changed', () => {
                        this._syncWindowSnapshotCaching();
                    }, this);
                    this._syncWindowSnapshotCaching();
                }
            );
        } catch {
        }

        this._syncWindowSnapshotCaching();

        this._setupWindowCache();
        this._initWorkspacesAppGrid();
    }

    disable() {
        // Guideline EGO-M-008: Documenting use of unlock-dialog.
        // This extension supports running during the 'unlock-dialog' session mode
        // to coordinate with the lock screen. When the extension is disabled during
        // a lockscreen transition (such as when entering the lockscreen/unlock-dialog),
        // we perform the following:
        // - Preserve and cache panel styles, vibrancy classes, and proximity states
        //   via global variables (_cachePanelHandoffState) so they can be seamlessly
        //   inherited by the lockscreen clock/dialog without a jarring visual pop.
        // - Retain the cached window texture snapshots (_destroyWindowCache(isLockscreen))
        //   so that the lockscreen extension can use them to perform the Cupertino-style
        //   unlock fade animation.
        // - Prevent restoring the native activities button visibility on the panel
        //   if the session is locked, maintaining lockscreen UI integrity.
        //
        // Otherwise, if the extension is disabled under normal session conditions, all
        // temporary handoff states, caches, and custom panel modifications are fully cleared.
        const currentMode = Main.sessionMode.currentMode;
        const isLockscreen = currentMode === 'unlock-dialog' || currentMode === 'greeter' ||
            currentMode === 'gdm' || Main.screenShield?.active || Main.screenShield?.locked;

        if (isLockscreen)
            this._cachePanelHandoffState();
        else
            this._clearPanelHandoffState();

        this.lastPanelStateIsProximity = false;
        this._activities?.container?.disconnectObject(this);
        this._activities = null;

        if (this._sessionModeOwner) {
            Main.sessionMode.disconnectObject(this._sessionModeOwner);
            this._sessionModeOwner = null;
        }

        if (this._proximityWriteCancellable) {
            this._proximityWriteCancellable.cancel();
            this._proximityWriteCancellable = null;
        }

        this._destroyProximityTracking();
        this._unloadProximityStylesheet();
        this._clearPanelStyle();

        if (this._queuedUpdateId) {
            GLib.source_remove(this._queuedUpdateId);
            this._queuedUpdateId = null;
        }

        // Disable VibrancyManager
        if (this._vibrancyManager) {
            this._vibrancyManager.disable();
            this._vibrancyManager = null;
        }

        // Clear gradient and contrast styling
        Main.panel.set_style(null);
        Main.panel.remove_style_class_name('light-contrast');

        this._settings.disconnectObject(this);
        this._settings = null;

        this._desktopSettings?.disconnectObject(this);
        this._desktopSettings = null;



        if (this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }

        if (this._workspaceButton) {
            this._workspaceButton.destroy();
            this._workspaceButton = null;
        }

        if (this._appMenuButton) {
            this._appMenuButton.destroy();
            this._appMenuButton = null;
        }

        // Restore native activities button (if not locked)
        if (!isLockscreen) {
            Main.panel.statusArea['activities']?.container.show();
        }
        this._destroyWindowCache(isLockscreen);
        this._destroyWorkspacesAppGrid();
        this._windowSnapshotCachingEnabled = false;
        this._lockscreenSettings?.disconnectObject(this);
        this._lockscreenSettings = null;
        this._powerProfilesProxy?.disconnectObject(this);
        this._powerProfilesProxy = null;
    }


    _clearPanelHandoffState() {
        delete global.wack_proximity_active;
        delete global.wack_proximity_bg;
        delete global.wack_proximity_fg;
        delete global.wack_panel_cached_style;
        delete global.wack_panel_cached_classes;
        delete global.wack_panel_cached_proximity_bg;
        delete global.wack_panel_cached_proximity_fg;
        delete global.wack_panel_cached_foreground;
        delete global.wack_panel_cached_blur_mode;
        delete global.wack_panel_cached_brightness;
    }

    _cachePanelHandoffState() {
        const currentClasses = Main.panel.get_style_class_name() || '';
        const proximityActive = Main.panel.has_style_class_name('panel-proximity') ||
            this.lastPanelStateIsProximity || global.wack_proximity_active;

        const classes = currentClasses.split(/\s+/).filter(Boolean);
        global.wack_proximity_active = proximityActive;

        const isLockscreenMode = Main.sessionMode.currentMode === 'unlock-dialog' ||
            Main.sessionMode.currentMode === 'greeter' ||
            Main.sessionMode.currentMode === 'gdm' ||
            Main.screenShield?.active || Main.screenShield?.locked;

        if (isLockscreenMode) {
            global.wack_panel_cached_classes = global.wack_panel_cached_classes || currentClasses;
            global.wack_panel_cached_style = global.wack_panel_cached_style || Main.panel.style || '';
        } else {
            global.wack_panel_cached_classes = currentClasses;
            global.wack_panel_cached_style = Main.panel.style || '';
        }

        const cachedClassesList = (global.wack_panel_cached_classes || '').split(/\s+/).filter(Boolean);
        global.wack_panel_cached_foreground = cachedClassesList.includes('light-contrast') ? 'rgb(20, 20, 20)' : null;

        if (this._settings) {
            let blurMode = this._settings.get_int('vibrancy-blur-mode');
            if (blurMode === 3 && this._vibrancyManager) {
                blurMode = this._vibrancyManager._isWallpaperLenient() ? 2 : 1;
            }
            global.wack_panel_cached_blur_mode = (blurMode === 1 || blurMode === 2) ? blurMode : 1;

            const isDark = this._desktopSettings?.get_string('color-scheme') === 'prefer-dark';
            const style = this._settings.get_int('vibrancy-style');
            const borrowVenturaLight = this._vibrancyManager ? this._vibrancyManager._getBorrowVenturaLight() : false;
            const useVenturaLight = (style === 2 || borrowVenturaLight) && !isDark;
            const effectiveStyle = useVenturaLight ? 2 : 1;
            const bmsConflict = this._vibrancyManager ? this._vibrancyManager._bmsHasPanelBlur() : false;
            let brightness = 1.0;
            if (!bmsConflict) {
                brightness = (effectiveStyle === 2) ? 0.80 : (isDark ? 0.90 : 0.95);
            }
            global.wack_panel_cached_brightness = brightness;
        }

        if (!proximityActive)
            return;

        if (!classes.includes('panel-proximity'))
            classes.push('panel-proximity');
        global.wack_panel_cached_classes = classes.join(' ');
        global.wack_panel_cached_style = '';

        let bg = global.wack_proximity_bg;
        let fg = global.wack_proximity_fg;
        if ((!bg || !fg) && this._settings) {
            try {
                const isDark = this._desktopSettings?.get_string('color-scheme') === 'prefer-dark';
                bg = this._settings.get_string(isDark ? 'dark-bg-color' : 'light-bg-color').replace(/'/g, '');
                fg = this._settings.get_string(isDark ? 'dark-fg-color' : 'light-fg-color').replace(/'/g, '');
            } catch {
            }
        }

        global.wack_panel_cached_proximity_bg = bg || null;
        global.wack_panel_cached_proximity_fg = fg || null;
        global.wack_panel_cached_foreground = fg || global.wack_panel_cached_foreground;
    }

    _syncLogoMenu() {
        const show = this._settings.get_boolean('show-logo-menu');

        if (show) {
            if (!this._logoButton) {
                this._logoButton = new WackLogoButton(this);
                Main.panel.addToStatusArea('wack-logo-menu', this._logoButton, 0, 'left');
            }
        } else {
            if (this._logoButton) {
                this._logoButton.destroy();
                this._logoButton = null;
            }
        }
        this._syncSessionModeUI();
    }

    _syncWorkspaceWidget() {
        const show = this._settings.get_boolean('show-workspace-widget');

        if (show) {
            if (!this._workspaceButton) {
                this._workspaceButton = new WackWorkspaceButton(this);
                // Position workspace widget next to logo (index 1)
                Main.panel.addToStatusArea('wack-workspace-button', this._workspaceButton, 1, 'left');
            }
        } else {
            if (this._workspaceButton) {
                this._workspaceButton.destroy();
                this._workspaceButton = null;
            }
        }
        this._syncSessionModeUI();
    }

    _syncAppMenu() {
        const show = this._settings.get_boolean('show-app-menu');

        if (show) {
            if (!this._appMenuButton) {
                this._appMenuButton = new WackAppMenuButton(this);
                // Position appmenu-indicator next to workspace button (index 2)
                Main.panel.addToStatusArea('wack-app-menu', this._appMenuButton, 2, 'left');
            }
        } else {
            if (this._appMenuButton) {
                this._appMenuButton.destroy();
                this._appMenuButton = null;
            }
        }
        this._syncSessionModeUI();
    }

    _syncSessionModeUI() {
        const hasWindows = Main.sessionMode.hasWindows;
        const isLocked = !hasWindows;
        const opacity = isLocked ? 0 : 255;
        const visible = !isLocked;

        if (this._logoButton) {
            this._logoButton.opacity = opacity;
            this._logoButton.reactive = visible;
            this._logoButton.can_focus = visible;
            if (visible) {
                this._logoButton.show();
            } else {
                this._logoButton.hide();
            }

            if (this._logoButton.container) {
                this._logoButton.container.opacity = opacity;
                this._logoButton.container.reactive = visible;
                this._logoButton.container.can_focus = visible;
                if (visible) {
                    this._logoButton.container.show();
                } else {
                    this._logoButton.container.hide();
                }
            }
        }
        if (this._workspaceButton) {
            this._workspaceButton.opacity = opacity;
            this._workspaceButton.reactive = visible;
            this._workspaceButton.can_focus = visible;
            if (visible) {
                this._workspaceButton.show();
            } else {
                this._workspaceButton.hide();
            }

            if (this._workspaceButton.container) {
                this._workspaceButton.container.opacity = opacity;
                this._workspaceButton.container.reactive = visible;
                this._workspaceButton.container.can_focus = visible;
                if (visible) {
                    this._workspaceButton.container.show();
                } else {
                    this._workspaceButton.container.hide();
                }
            }
        }
        if (this._appMenuButton) {
            this._appMenuButton._sync(true);
        }

        // Ensure windows are reset to full opacity and scale when transitioning from locked to unlocked
        if (hasWindows && this._lastHasWindows === false) {
            this._resetWindowsOpacity();
            if (!(Main.sessionMode.currentMode === 'unlock-dialog' && this._isLockscreenCupertinoMode()))
                global.wack_window_snapshots = [];
        }

        this._lastHasWindows = hasWindows;
    }

    _setupWindowCache() {
        if (!global.wack_window_snapshots)
            global.wack_window_snapshots = [];

        const shield = Main.screenShield;
        if (shield) {
            this._origShieldActivate = shield.activate.bind(shield);
            shield.activate = (animate) => {
                if (this._windowSnapshotCachingEnabled)
                    this._cacheWindowTextures();
                else
                    this._clearWindowSnapshots();
                return this._origShieldActivate(animate);
            };
        }
    }

    _clearWindowSnapshots() {
        if (global.wack_window_snapshots) {
            for (const snap of global.wack_window_snapshots)
                snap.content = null;
        }
        global.wack_window_snapshots = [];
    }

    _cacheWindowTextures() {
        this._clearWindowSnapshots();
        const workspace = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors().filter(actor => {
            const win = actor.metaWindow;
            if (!win) return false;
            return !win.is_override_redirect() &&
                win.located_on_workspace(workspace) &&
                win.get_window_type() !== Meta.WindowType.DESKTOP &&
                !win.is_hidden();
        });

        // Traverse front-to-back (top-to-bottom z-order) and select visible window actors
        const reversedActors = actors.slice().reverse();
        const selectedActors = [];
        for (const actor of reversedActors) {
            selectedActors.push(actor);
            const win = actor.metaWindow;
            if (win) {
                const isMaximized = win.maximized_horizontally && win.maximized_vertically;
                const isFullscreen = win.is_fullscreen();
                if (isMaximized || isFullscreen) {
                    break;
                }
            }
        }

        // Restore original bottom-to-top z-order for correct overlay rendering
        selectedActors.reverse();

        // Paint only the selected window actors
        selectedActors.forEach(actor => {
            const win = actor.metaWindow;
            if (!win) return;
            const bufferRect = win.get_buffer_rect();
            const content = actor.paint_to_content(null);
            if (content) {
                global.wack_window_snapshots.push({
                    content,
                    rect: {
                        x: bufferRect.x,
                        y: bufferRect.y,
                        width: bufferRect.width,
                        height: bufferRect.height
                    }
                });
            }
        });
    }

    _destroyWindowCache(preserveSnapshots = false) {
        if (Main.screenShield && this._origShieldActivate) {
            Main.screenShield.activate = this._origShieldActivate;
            this._origShieldActivate = null;
        }
        if (!preserveSnapshots)
            this._clearWindowSnapshots();
    }

    _initWorkspacesAppGrid() {
        const hasDisableKey = this._settings.settings_schema.has_key('disable-workspaces-in-app-grid');
        const key = hasDisableKey ? 'disable-workspaces-in-app-grid' : 'workspaces-in-app-grid';

        const getVal = () => {
            const val = this._settings.get_boolean(key);
            return hasDisableKey ? val : !val;
        };

        this._disableWorkspacesInAppGrid = getVal();

        this._settings.connectObject(
            `changed::${key}`, () => {
                this._disableWorkspacesInAppGrid = getVal();
                const controls = Main.overview._overview?._controls;
                if (controls && controls.layout_manager) {
                    controls.layout_manager.layout_changed();
                    controls._update();
                }
            },
            this
        );

        const controls = Main.overview._overview?._controls;
        if (!controls || !controls.layout_manager) {
            return;
        }

        this._origComputeWorkspacesBoxForState = controls.layout_manager._computeWorkspacesBoxForState;
        this._origGetAppDisplayBoxForState = controls.layout_manager._getAppDisplayBoxForState;
        this._origUpdate = controls._update;
        this._origOnSearchChanged = controls._onSearchChanged;

        const self = this;

        // Reduce the reserved workspace area in App Grid state from GNOME's
        // default 15% to APP_GRID_WORKSPACE_RATIO — but ONLY when the workspace
        // view is disabled. When it's visible the user sees the real thumbnail,
        // so GNOME's native ratio is left untouched.
        controls.layout_manager._computeWorkspacesBoxForState = function (state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
            const workspaceBox = self._origComputeWorkspacesBoxForState.call(
                this, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
            if (state === OverviewControls.ControlsState.APP_GRID && self._disableWorkspacesInAppGrid) {
                const [width] = workspaceBox.get_size();
                const [, boxHeight] = box.get_size();
                workspaceBox.set_size(width, Math.round(boxHeight * APP_GRID_WORKSPACE_RATIO));
            }
            return workspaceBox;
        };

        // Instead of collapsing the workspace to height=0 (which corrupts
        // WorkspaceLayout._windowSlots and causes the slide-in blip), we keep
        // the workspace at its real allocation and only hide it via opacity.
        //
        // The emptyBox trick is applied to ALL states (not just APP_GRID) so
        // that the app grid has identical sizing at both ends of the
        // WINDOW_PICKER→APP_GRID transition. Without this, GNOME interpolates
        // between a smaller initial-state size and a larger final-state size,
        // causing the app grid icons to reflow mid-animation ("two faces").
        controls.layout_manager._getAppDisplayBoxForState = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
            if (self._disableWorkspacesInAppGrid) {
                const emptyBox = workspacesBox.copy();
                emptyBox.set_size(emptyBox.get_width(), 0);
                return self._origGetAppDisplayBoxForState.call(this, state, box, searchHeight, dashHeight, emptyBox, spacing);
            }
            return self._origGetAppDisplayBoxForState.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
        };

        controls._update = function () {
            self._origUpdate.call(this);
            self._updateWorkspacesOpacity(this);
        };

        controls._onSearchChanged = function () {
            const oldEase = this._workspacesDisplay.ease;
            this._workspacesDisplay.ease = function (props) {
                if (props && props.opacity === 255) {
                    props.opacity = self._getWorkspacesTargetOpacity(this);
                }
                return oldEase.call(this, props);
            };
            try {
                self._origOnSearchChanged.call(this);
            } finally {
                this._workspacesDisplay.ease = oldEase;
            }
        };

        controls.layout_manager.layout_changed();
        controls._update();
    }

    _getWorkspacesTargetOpacity(controls) {
        if (!this._disableWorkspacesInAppGrid)
            return 255;

        const adjustment = controls._stateAdjustment;
        if (!adjustment)
            return 255;

        const v = adjustment.value;
        if (v <= 1.0)
            return 255;

        const progress = Math.min(1.0, v - 1.0);

        if (progress < APP_GRID_WORKSPACE_FADE_SNAP) {
            // Phase 1: virtual-range linear lerp.
            // Starts immediately at progress=0 and is always proportional,
            // so mid-gesture reversal tracks opacity smoothly with no snap.
            //   t = progress / FADE_RANGE  →  opacity = 255 * (1 - t)
            const t = progress / APP_GRID_WORKSPACE_FADE_RANGE;
            return Math.max(0, Math.round(255 * (1.0 - t)));
        }

        // Phase 2: ease-out-quad finishing curve.
        // Picks up at the exact opacity the linear phase left off at SNAP,
        // then drives it to 0 using (1 - q)² — fast initial drop that
        // decelerates as it approaches transparent (ease-out on the fade-out).
        //   q = (progress - SNAP) / (1 - SNAP)  [0 → 1]
        //   opacity = opacityAtSnap * (1 - q)²
        const opacityAtSnap = 255 * (1.0 - APP_GRID_WORKSPACE_FADE_SNAP / APP_GRID_WORKSPACE_FADE_RANGE);
        const q = (progress - APP_GRID_WORKSPACE_FADE_SNAP) / (1.0 - APP_GRID_WORKSPACE_FADE_SNAP);
        return Math.max(0, Math.round(opacityAtSnap * (1.0 - q) * (1.0 - q)));
    }

    _updateWorkspacesOpacity(controls) {
        if (controls._searchController.searchActive) {
            controls._workspacesDisplay.opacity = 0;
        } else {
            controls._workspacesDisplay.opacity = this._getWorkspacesTargetOpacity(controls);
        }
    }

    _destroyWorkspacesAppGrid() {
        const controls = Main.overview._overview?._controls;
        if (controls) {
            if (this._origComputeWorkspacesBoxForState && controls.layout_manager) {
                controls.layout_manager._computeWorkspacesBoxForState = this._origComputeWorkspacesBoxForState;
                this._origComputeWorkspacesBoxForState = null;
            }
            if (this._origGetAppDisplayBoxForState && controls.layout_manager) {
                controls.layout_manager._getAppDisplayBoxForState = this._origGetAppDisplayBoxForState;
                this._origGetAppDisplayBoxForState = null;
            }
            if (this._origUpdate) {
                controls._update = this._origUpdate;
                this._origUpdate = null;
            }
            if (this._origOnSearchChanged) {
                controls._onSearchChanged = this._origOnSearchChanged;
                this._origOnSearchChanged = null;
            }

            controls._workspacesDisplay.opacity = 255;
            if (controls.layout_manager) {
                controls.layout_manager.layout_changed();
                controls._update();
            }
        }
    }

    _isLockscreenCupertinoMode() {
        return this._lockscreenSettings?.get_string('lockscreen-mode') === 'cupertino';
    }

    _isLockscreenUnlockFadeEnabled() {
        return this._lockscreenSettings?.get_boolean('cupertino-unlock-fade') ?? false;
    }

    _isPowerSaverActive() {
        try {
            return this._powerProfilesProxy?.ActiveProfile === 'power-saver';
        } catch {
            return false;
        }
    }

    _syncWindowSnapshotCaching() {
        try {
            if (!this._lockscreenSettings) {
                this._windowSnapshotCachingEnabled = true;
                return;
            }
            this._windowSnapshotCachingEnabled = this._isLockscreenCupertinoMode() &&
                this._isLockscreenUnlockFadeEnabled() &&
                !this._isPowerSaverActive();
        } catch {
            this._windowSnapshotCachingEnabled = true;
        }
    }

    _resetWindowsOpacity() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(metaWindow => {
            return !metaWindow.is_hidden() &&
                metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
                !metaWindow.is_attached_dialog();
        });
        const windowActors = windows.map(w => w.get_compositor_private()).filter(actor => actor !== null);
        windowActors.forEach(actor => {
            actor.remove_all_transitions();
            actor.opacity = 255;
            actor.scale_x = 1.0;
            actor.scale_y = 1.0;
        });
    }

    _initProximity() {
        this._proximityWindowSignals = new Map();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        const cacheDir = GLib.get_user_cache_dir();
        this._customCssPath = GLib.build_filenamev([cacheDir, 'wack-shell-custom.css']);
        this._customCssFile = Gio.File.new_for_path(this._customCssPath);
        this._desktopSettings = new Gio.Settings({ schema: "org.gnome.desktop.interface" });
        this._proximityRequestToken = 0;
        this._proximityWriteCancellable = null;

        this._settings.connectObject(
            'changed::enable-panel-proximity', () => this._syncProximity(),
            'changed::dark-bg-color', () => this._updateProximityStylesheet(),
            'changed::dark-fg-color', () => this._updateProximityStylesheet(),
            'changed::light-bg-color', () => this._updateProximityStylesheet(),
            'changed::light-fg-color', () => this._updateProximityStylesheet(),
            this
        );

        this._desktopSettings.connectObject(
            'changed::color-scheme', () => this._updateProximityStylesheet(),
            this
        );

        this._syncProximity();
    }

    _syncProximity() {
        const enabled = this._settings.get_boolean('enable-panel-proximity');

        this._destroyProximityTracking();

        if (this._queuedUpdateId) {
            GLib.source_remove(this._queuedUpdateId);
            this._queuedUpdateId = null;
        }

        if (enabled) {
            this._updateProximityStylesheet();
            this._connectProximitySignals();
        } else {
            this._unloadProximityStylesheet();
            this._clearPanelStyle();
        }
    }

    _connectProximitySignals() {
        for (const meta_window_actor of global.get_window_actors()) {
            this._onProximityWindowActorAdded(meta_window_actor.get_parent(), meta_window_actor);
        }

        global.window_group.connectObject(
            'child-added', this._onProximityWindowActorAdded.bind(this),
            'child-removed', this._onProximityWindowActorRemoved.bind(this),
            this
        );

        global.window_manager.connectObject(
            'switch-workspace', () => this._queueUpdatePanelVisibility(),
            this
        );

        Main.overview.connectObject(
            'showing', () => this._updatePanelVisibility(),
            'hiding', () => this._updatePanelVisibility(),
            'hidden', () => this._updatePanelVisibility(),
            this
        );

        Main.sessionMode.connectObject(
            'updated', () => this._updatePanelVisibility(),
            this
        );

        this._queueUpdatePanelVisibility();
    }

    _onProximityWindowActorAdded(container, meta_window_actor) {
        const signals = [
            { object: meta_window_actor, id: meta_window_actor.connect('notify::allocation', () => this._queueUpdatePanelVisibility()) },
            { object: meta_window_actor, id: meta_window_actor.connect('notify::visible', () => this._queueUpdatePanelVisibility()) }
        ];

        if (!meta_window_actor.meta_window) {
            signals.push({
                object: meta_window_actor, id: meta_window_actor.connect('notify::meta-window', () => {
                    if (meta_window_actor.meta_window) {
                        signals.push({ object: meta_window_actor.meta_window, id: meta_window_actor.meta_window.connect('notify::minimized', () => this._queueUpdatePanelVisibility()) });
                    }
                })
            });
        } else {
            signals.push({ object: meta_window_actor.meta_window, id: meta_window_actor.meta_window.connect('notify::minimized', () => this._queueUpdatePanelVisibility()) });
        }

        this._proximityWindowSignals.set(meta_window_actor, signals);
        this._queueUpdatePanelVisibility();
    }

    _onProximityWindowActorRemoved(container, meta_window_actor) {
        const signals = this._proximityWindowSignals.get(meta_window_actor);
        if (signals) {
            signals.forEach(sig => {
                try {
                    sig.object.disconnect(sig.id);
                } catch { }
            });
            this._proximityWindowSignals.delete(meta_window_actor);
        }
        this._queueUpdatePanelVisibility();
    }

    _destroyProximityTracking() {
        global.window_group.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);

        if (this._proximityWindowSignals) {
            for (const [, signals] of this._proximityWindowSignals) {
                signals.forEach(sig => {
                    try {
                        sig.object.disconnect(sig.id);
                    } catch { }
                });
            }
            this._proximityWindowSignals.clear();
        }
    }

    _unloadProximityStylesheet() {
        try {
            this._themeContext.get_theme().unload_stylesheet(this._customCssFile);
        } catch { }
        this._themeId = false;
    }

    _isProximityDarkMode() {
        return this._desktopSettings.get_string('color-scheme') === 'prefer-dark';
    }

    _updateProximityStylesheet() {
        if (this._proximityWriteCancellable) {
            this._proximityWriteCancellable.cancel();
            this._proximityWriteCancellable = null;
        }

        this._unloadProximityStylesheet();

        if (!this._settings.get_boolean('enable-panel-proximity')) {
            return;
        }

        const isDark = this._isProximityDarkMode();
        const bg = this._settings.get_string(isDark ? 'dark-bg-color' : 'light-bg-color');
        const fg = this._settings.get_string(isDark ? 'dark-fg-color' : 'light-fg-color');

        const bgCss = bg.replace(/'/g, '');
        const fgCss = fg.replace(/'/g, '');

        global.wack_proximity_bg = bgCss;
        global.wack_proximity_fg = fgCss;

        const cssString = `
#panel.panel-proximity {
    background-color: ${bgCss} !important;
    transition-duration: 250ms;
}

#panel.panel-proximity,
#panel.panel-proximity *,
#panel.panel-proximity .panel-button,
#panel.panel-proximity .panel-button * {
    color: ${fgCss} !important;
}

#panel.panel-proximity .system-status-icon,
#panel.panel-proximity .app-menu-icon,
#panel.panel-proximity .popup-menu-arrow {
    color: ${fgCss} !important;
}

#panel.panel-proximity .workspace-dot {
    border-radius: 999px;
    background-color: ${fgCss} !important;
}
`;
        const bytes = new TextEncoder().encode(cssString);

        const cancellable = new Gio.Cancellable();
        this._proximityWriteCancellable = cancellable;
        const requestToken = ++this._proximityRequestToken;

        this._customCssFile.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.NONE,
            cancellable,
            (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch {
                    return;
                }

                if (requestToken !== this._proximityRequestToken) return;
                if (this._proximityWriteCancellable === cancellable)
                    this._proximityWriteCancellable = null;
                if (!this._settings) return;

                this._themeContext.get_theme().load_stylesheet(this._customCssFile);
                this._themeId = true;
                this._queueUpdatePanelVisibility();
            }
        );
    }

    _queueUpdatePanelVisibility() {
        if (this._queuedUpdateId)
            return;

        this._queuedUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._queuedUpdateId = null;
            this._updatePanelVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updatePanelVisibility() {
        if (Main.overview.visibleTarget) {
            this._clearPanelStyle();
            return;
        }

        const isLockscreen = Main.sessionMode.currentMode === 'unlock-dialog' && !Main.sessionMode.hasWindows;
        if (isLockscreen) {
            this._clearPanelStyle();
            return;
        }

        if (!this._settings.get_boolean('enable-panel-proximity')) {
            this.lastPanelStateIsProximity = false;
            global.wack_proximity_active = false;
            this._clearPanelStyle();
            return;
        }

        if (!Main.layoutManager.primaryMonitor) return;

        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(meta_window =>
            meta_window.showing_on_its_workspace() &&
            !meta_window.is_hidden() &&
            meta_window.get_window_type() !== Meta.WindowType.DESKTOP &&
            meta_window.get_gtk_application_id() !== "com.rastersoft.ding" &&
            meta_window.get_gtk_application_id() !== "com.desktop.ding"
        );

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panel = Main.panel;
        const panelTop = panel.get_transformed_position()[1];
        const panelBottom = panelTop + panel.get_height();

        let windowNearPanel = false;
        windows.forEach(meta_window => {
            const windowMonitorIndex = meta_window.get_monitor();
            const sameMonitor = Main.layoutManager.primaryMonitor.index === windowMonitorIndex;

            const windowVerticalPos = meta_window.get_frame_rect().y;
            const windowVerticalBottom = windowVerticalPos + meta_window.get_frame_rect().height;

            if (sameMonitor &&
                ((panelTop === 0 && windowVerticalPos < panelBottom + 5 * scale) ||
                    (panelTop > 0 && windowVerticalBottom > panelTop - 5 * scale))
            ) {
                windowNearPanel = true;
            }
        });

        if (windowNearPanel) {
            this.lastPanelStateIsProximity = true;
            global.wack_proximity_active = true;
            this._applyPanelStyle();
        } else {
            this.lastPanelStateIsProximity = false;
            global.wack_proximity_active = false;
            this._clearPanelStyle();
        }
    }

    _applyPanelStyle() {
        Main.panel.add_style_class_name('panel-proximity');
        Main.panel.remove_style_class_name('light-contrast');

        for (const cls of ['panel-ventura-light', 'panel-bigsur']) {
            Main.panel.remove_style_class_name(cls);
        }

        Main.panel.set_style(null);

        const isLockscreen = Main.sessionMode.currentMode === 'unlock-dialog';
        const isShieldActive = Main.screenShield && (Main.screenShield.active || Main.screenShield.locked);
        const isOverview = Main.overview.visible || Main.overview.visibleTarget;

        if (!isLockscreen && !isShieldActive && !isOverview) {
            global.wack_panel_cached_classes = Main.panel.get_style_class_name() || '';
            global.wack_panel_cached_style = '';
            const isDark = this._isProximityDarkMode();
            const bg = this._settings.get_string(isDark ? 'dark-bg-color' : 'light-bg-color');
            const fg = this._settings.get_string(isDark ? 'dark-fg-color' : 'light-fg-color');
            global.wack_panel_cached_proximity_bg = bg.replace(/'/g, '');
            global.wack_panel_cached_proximity_fg = fg.replace(/'/g, '');
        }
    }

    _clearPanelStyle() {
        Main.panel.remove_style_class_name('panel-proximity');

        if (this._vibrancyManager && this._vibrancyManager.vibrancyActive) {
            this._vibrancyManager.applyVibrancyStyle();
        }
    }
}
