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




export default class WackShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Hide native activities button and suppress it from showing up
        const activities = Main.panel.statusArea['activities'];
        if (activities?.container) {
            activities.container.hide();
            this._activitiesShowId = activities.container.connect('show', () => {
                activities.container.hide();
            });
        }

        this._logoButton = null;
        this._workspaceButton = null;
        this._appMenuButton = null;

        this._lastHasWindows = Main.sessionMode.hasWindows;

        this._sessionUpdatedId = Main.sessionMode.connect('updated', () => this._syncSessionModeUI());

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
        this._vibrancyManager = new VibrancyManager(this);
        this._vibrancyManager.enable();

        this._setupWindowCache();
        this._initWorkspacesAppGrid();

        try {
            this._lockscreenSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.wack-lockscreen-clock' });
        } catch {
            this._lockscreenSettings = null;
        }
    }

    disable() {
        if (this._activitiesShowId) {
            Main.panel.statusArea['activities']?.container.disconnect(this._activitiesShowId);
            this._activitiesShowId = null;
        }

        if (this._sessionUpdatedId) {
            Main.sessionMode.disconnect(this._sessionUpdatedId);
            this._sessionUpdatedId = null;
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
        if (Main.sessionMode.currentMode !== 'unlock-dialog') {
            Main.panel.statusArea['activities']?.container.show();
        }
        this._destroyWindowCache();
        this._destroyWorkspacesAppGrid();
        this._lockscreenSettings = null;
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
        const reactive = !isLocked;

        if (this._logoButton) {
            this._logoButton.opacity = opacity;
            this._logoButton.reactive = reactive;
            this._logoButton.can_focus = reactive;
        }
        if (this._workspaceButton) {
            this._workspaceButton.opacity = opacity;
            this._workspaceButton.reactive = reactive;
            this._workspaceButton.can_focus = reactive;
        }
        if (this._appMenuButton) {
            this._appMenuButton.opacity = opacity;
            this._appMenuButton.reactive = reactive;
            this._appMenuButton.can_focus = reactive;
        }

        // Trigger window entrance animation when transitioning from locked to unlocked
        if (hasWindows && this._lastHasWindows === false) {
            if (this._isLockscreenCupertinoMode()) {
                this._resetWindowsOpacity();
            } else {
                this._animateWindowsIn();
            }
            if (Main.sessionMode.currentMode === 'unlock-dialog' && this._isLockscreenCupertinoMode()) {
                log(`[WACK Shell] _syncSessionModeUI: preserving wack_window_snapshots during Cupertino unlock handoff (${global.wack_window_snapshots?.length ?? 0} cached)`);
            } else {
                log(`[WACK Shell] _syncSessionModeUI: hasWindows flipped true, clearing wack_window_snapshots (was ${global.wack_window_snapshots?.length ?? 0})`);
                global.wack_window_snapshots = [];
            }
        }

        this._lastHasWindows = hasWindows;
    }

    _animateWindowsIn() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(metaWindow => {
            return !metaWindow.is_hidden() &&
                metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
                !metaWindow.is_attached_dialog() &&
                !metaWindow.maximized_horizontally &&
                !metaWindow.maximized_vertically;
        });
        const windowActors = windows.map(w => w.get_compositor_private()).filter(actor => actor !== null);

        windowActors.forEach(actor => {
            actor.remove_all_transitions();

            const isDialog = actor.meta_window.get_window_type() === Meta.WindowType.DIALOG ||
                actor.meta_window.get_window_type() === Meta.WindowType.MODAL_DIALOG;

            if (isDialog) {
                actor.set_pivot_point(0.5, 0.5);
                actor.scale_x = 1.0;
                actor.scale_y = 0.01;
                actor.opacity = 0;

                actor.ease({
                    opacity: 255,
                    scale_y: 1.0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        actor.set_pivot_point(0.0, 0.0);
                    }
                });
            } else {
                actor.set_pivot_point(0.5, 1.0);
                actor.scale_x = 0.01;
                actor.scale_y = 0.05;
                actor.opacity = 0;

                actor.ease({
                    opacity: 255,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    onComplete: () => {
                        actor.set_pivot_point(0.0, 0.0);
                    }
                });
            }
        });
    }

    _setupWindowCache() {
        global.wack_window_snapshots = [];

        const shield = Main.screenShield;
        if (shield) {
            this._origShieldActivate = shield.activate.bind(shield);
            shield.activate = (animate) => {
                log('[WACK Shell] shield.activate intercepted, caching window textures');
                this._cacheWindowTextures();
                return this._origShieldActivate(animate);
            };
        }
    }

    _cacheWindowTextures() {
        global.wack_window_snapshots = [];
        const workspace = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors().filter(actor => {
            const win = actor.metaWindow;
            if (!win) return false;
            return !win.is_override_redirect() &&
                win.located_on_workspace(workspace) &&
                win.get_window_type() !== Meta.WindowType.DESKTOP &&
                !win.is_hidden();
        });

        log(`[WACK Shell] _cacheWindowTextures: ${actors.length} candidate window actor(s) found`);

        actors.forEach(actor => {
            const win = actor.metaWindow;
            if (!win) return;
            const bufferRect = win.get_buffer_rect();
            const content = actor.paint_to_content(null);
            const title = win.get_title?.() ?? '(no title)';
            if (content) {
                global.wack_window_snapshots.push({
                    content: content,
                    rect: {
                        x: bufferRect.x,
                        y: bufferRect.y,
                        width: bufferRect.width,
                        height: bufferRect.height
                    }
                });
                log(`[WACK Shell] cached "${title}" bufferRect=${bufferRect.x},${bufferRect.y} ${bufferRect.width}x${bufferRect.height}`);
            } else {
                log(`[WACK Shell] paint_to_content returned null/falsy for "${title}" — SKIPPED`);
            }
        });

        log(`[WACK Shell] _cacheWindowTextures: total cached = ${global.wack_window_snapshots.length}`);
    }

    _destroyWindowCache() {
        if (Main.screenShield && this._origShieldActivate) {
            Main.screenShield.activate = this._origShieldActivate;
            this._origShieldActivate = null;
        }
        global.wack_window_snapshots = [];
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
            logError(new Error('WACK Shell: Main.overview._overview._controls.layout_manager is not initialized'));
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
        this._proximitySignals = [];
        this._proximityWindowSignals = new Map();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._customCssPath = GLib.build_filenamev([this.path, 'stylesheet-custom.css']);
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

        const sigChildAdded = global.window_group.connect('child-added', this._onProximityWindowActorAdded.bind(this));
        const sigChildRemoved = global.window_group.connect('child-removed', this._onProximityWindowActorRemoved.bind(this));
        this._proximitySignals.push({ object: global.window_group, id: sigChildAdded });
        this._proximitySignals.push({ object: global.window_group, id: sigChildRemoved });

        const sigSwitchWS = global.window_manager.connect('switch-workspace', () => this._queueUpdatePanelVisibility());
        this._proximitySignals.push({ object: global.window_manager, id: sigSwitchWS });

        const sigShowing = Main.overview.connect('showing', () => this._updatePanelVisibility());
        const sigHiding = Main.overview.connect('hiding', () => this._updatePanelVisibility());
        const sigHidden = Main.overview.connect('hidden', () => this._updatePanelVisibility());
        const sigSession = Main.sessionMode.connect('updated', () => this._updatePanelVisibility());
        this._proximitySignals.push({ object: Main.overview, id: sigShowing });
        this._proximitySignals.push({ object: Main.overview, id: sigHiding });
        this._proximitySignals.push({ object: Main.overview, id: sigHidden });
        this._proximitySignals.push({ object: Main.sessionMode, id: sigSession });

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
            signals.forEach(sig => sig.object.disconnect(sig.id));
            this._proximityWindowSignals.delete(meta_window_actor);
        }
        this._queueUpdatePanelVisibility();
    }

    _destroyProximityTracking() {
        if (this._proximitySignals) {
            this._proximitySignals.forEach(s => s.object.disconnect(s.id));
            this._proximitySignals = [];
        }

        if (this._proximityWindowSignals) {
            for (const [win, signals] of this._proximityWindowSignals) {
                signals.forEach(sig => sig.object.disconnect(sig.id));
            }
            this._proximityWindowSignals.clear();
        }
    }

    _unloadProximityStylesheet() {
        try {
            this._themeContext.get_theme().unload_stylesheet(this._customCssFile);
        } catch (e) {}
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
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'wack-shell-proximity: Error writing custom stylesheet');
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
        if (this._queuedUpdateId) {
            GLib.source_remove(this._queuedUpdateId);
            this._queuedUpdateId = null;
        }
        this._queuedUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
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
            this._applyPanelStyle();
        } else {
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
    }

    _clearPanelStyle() {
        Main.panel.remove_style_class_name('panel-proximity');

        if (this._vibrancyManager && this._vibrancyManager.vibrancyActive) {
            this._vibrancyManager.applyVibrancyStyle();
        }
    }
}