import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Constants from './constants.js';
import { SelectionWindow } from './selection.js';

const INACTIVE_WORKSPACE_DOT_SCALE = 0.75;
const BUTTON_DND_ACTIVATION_TIMEOUT = 500;

function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
}

// Custom MenuItem class registered once at module load
const LogoMenuItem = GObject.registerClass(
    class WackLogoMenuItem extends PopupMenu.PopupMenuItem {
        _init(name, activateFunction) {
            super._init(name);
            this.connect('activate', activateFunction);
        }
    });

// Workspace dot actor
const WorkspaceDot = GObject.registerClass({
    Properties: {
        'expansion': GObject.ParamSpec.double('expansion', '', '',
            GObject.ParamFlags.READWRITE,
            0.0, 1.0, 0.0),
        'width-multiplier': GObject.ParamSpec.double(
            'width-multiplier', '', '',
            GObject.ParamFlags.READWRITE,
            1.0, 10.0, 1.0),
    },
}, class WorkspaceDot extends Clutter.Actor {
    constructor(params = {}) {
        super({
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            ...params,
        });

        this._dot = new St.Widget({
            style_class: 'workspace-dot',
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            request_mode: Clutter.RequestMode.WIDTH_FOR_HEIGHT,
        });
        this.add_child(this._dot);

        this.connect('notify::width-multiplier', () => this.queue_relayout());
        this.connect('notify::expansion', () => {
            this._updateVisuals();
            this.queue_relayout();
        });
        this._updateVisuals();

        this._destroying = false;
    }

    _updateVisuals() {
        const { expansion } = this;
        this._dot.set({
            opacity: Util.lerp(0.50, 1.0, expansion) * 255,
            scaleX: Util.lerp(INACTIVE_WORKSPACE_DOT_SCALE, 1.0, expansion),
            scaleY: Util.lerp(INACTIVE_WORKSPACE_DOT_SCALE, 1.0, expansion),
        });
    }

    vfunc_get_preferred_width(forHeight) {
        const factor = Util.lerp(1.0, this.widthMultiplier, this.expansion);
        return this._dot.get_preferred_width(forHeight).map(v => Math.round(v * factor));
    }

    vfunc_get_preferred_height(forWidth) {
        return this._dot.get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        box.set_origin(0, 0);
        this._dot.allocate(box);
    }

    scaleIn() {
        this.set({
            scale_x: 0,
            scale_y: 0,
        });
        this.ease({
            duration: 500,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            scale_x: 1.0,
            scale_y: 1.0,
        });
    }

    scaleOutAndDestroy() {
        this._destroying = true;
        this.ease({
            duration: 500,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            scale_x: 0.0,
            scale_y: 0.0,
            onComplete: () => this.destroy(),
        });
    }

    get destroying() {
        return this._destroying;
    }
});

// Workspace dots container
const WorkspaceIndicators = GObject.registerClass(
    class WorkspaceIndicators extends St.BoxLayout {
        constructor() {
            super({ style_class: 'activities-layout' });

            this._workspacesAdjustment = Main.createWorkspacesAdjustment(this);
            this._workspacesAdjustment.connectObject(
                'notify::value', () => this._updateExpansion(),
                'notify::upper', () => this._recalculateDots(),
                this
            );

            for (let i = 0; i < this._workspacesAdjustment.upper; i++)
                this.insert_child_at_index(new WorkspaceDot(), i);
            this._updateExpansion();
        }

        _getActiveIndicators() {
            return [...this].filter(i => !i.destroying);
        }

        _recalculateDots() {
            const activeIndicators = this._getActiveIndicators();
            const nIndicators = activeIndicators.length;
            const targetIndicators = this._workspacesAdjustment.upper;

            let remaining = Math.abs(nIndicators - targetIndicators);
            while (remaining--) {
                if (nIndicators < targetIndicators) {
                    const indicator = new WorkspaceDot();
                    this.add_child(indicator);
                    indicator.scaleIn();
                } else {
                    const indicator = activeIndicators[nIndicators - remaining - 1];
                    indicator.scaleOutAndDestroy();
                }
            }

            this._updateExpansion();
        }

        _updateExpansion() {
            const nIndicators = this._getActiveIndicators().length;
            const activeWorkspace = this._workspacesAdjustment.value;

            let widthMultiplier;
            if (nIndicators <= 3)
                widthMultiplier = 3.75;
            else if (nIndicators <= 5)
                widthMultiplier = 3.25;
            else
                widthMultiplier = 2.75;

            this.get_children().forEach((indicator, index) => {
                const distance = Math.abs(index - activeWorkspace);
                indicator.expansion = clamp(1 - distance, 0, 1);
                indicator.widthMultiplier = widthMultiplier;
            });
        }

        destroy() {
            this._workspacesAdjustment?.disconnectObject(this);
            this._workspacesAdjustment = null;
            super.destroy();
        }
    });

// Combined WackLogoButton (hides activities, implements logo menu, label, dots)
const WackLogoButton = GObject.registerClass(
    class WackLogoButton extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'WackLogoButton');
            this.set({
                name: 'panelActivities',
                accessible_role: Atk.Role.TOGGLE_BUTTON,
                accessible_name: _('LogoActivities'),
            });
            this.add_style_class_name('wack-logo-button');

            this._extension = extension;
            this._settings = extension.getSettings();

            // Single box layout
            this._container = new St.BoxLayout({ style_class: 'activities-layout' });
            this.add_child(this._container);

            // Icon Box
            this._iconBox = new St.Bin({
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.icon = new St.Icon({
                style_class: 'menu-button',
            });
            this._iconBox.add_child(this.icon);
            this._container.add_child(this._iconBox);

            // Label Box
            this._label = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._container.add_child(this._label);

            // Settings change listeners
            this._settings.connectObject(
                'changed::logo-icon-image', () => this._updateIcon(),
                'changed::symbolic-logo', () => this._updateIcon(),
                'changed::use-custom-logo', () => this._updateIcon(),
                'changed::custom-logo-path', () => this._updateIcon(),
                'changed::logo-icon-size', () => this._updateIconSize(),
                'changed::show-logo-label', () => this._updateLabel(),
                'changed::logo-label-text', () => this._updateLabel(),
                'changed::show-power-options', () => this._displayMenuItems(),
                'changed::show-lockscreen', () => this._displayMenuItems(),
                'changed::hide-forcequit', () => this._displayMenuItems(),
                'changed::hide-softwarecentre', () => this._displayMenuItems(),
                this
            );

            this._updateIcon();
            this._updateIconSize();
            this._updateLabel();
            this._displayMenuItems();



            // Drag/scroll/DND variables
            this._lastScrollTime = 0;
            this._xdndTimeOut = 0;
            this.connect('scroll-event', this._onScrollEvent.bind(this));
        }

        vfunc_event(event) {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const button = event.get_button();
                if (button === Clutter.BUTTON_PRIMARY) {
                    const clickAction = this._settings.get_int('logo-click-action');
                    if (clickAction === 1) { // Toggle Overview
                        this.menu.close();
                        if (Main.overview.shouldToggleByCornerOrButton()) {
                            Main.overview.toggle();
                        }
                        return Clutter.EVENT_STOP;
                    }
                } else if (button === Clutter.BUTTON_MIDDLE) {
                    const middleClickAction = this._settings.get_int('logo-middle-click-action');
                    if (middleClickAction === 1) { // Toggle Overview
                        this.menu.close();
                        if (Main.overview.shouldToggleByCornerOrButton()) {
                            Main.overview.toggle();
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
            }
            return super.vfunc_event(event);
        }

        _onScrollEvent(actor, event) {
            if (!this._settings.get_boolean('desktop-scroll'))
                return Clutter.EVENT_PROPAGATE;

            const now = Date.now();
            if (now - this._lastScrollTime < 200)
                return Clutter.EVENT_STOP;
            this._lastScrollTime = now;

            const wsManager = global.workspace_manager;
            let index = wsManager.get_active_workspace().index();

            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.DOWN) {
                index++;
            } else if (direction === Clutter.ScrollDirection.UP) {
                index--;
            } else if (direction === Clutter.ScrollDirection.LEFT) {
                index++;
            } else if (direction === Clutter.ScrollDirection.RIGHT) {
                index--;
            } else {
                let [dx, dy] = event.get_scroll_delta();
                if (dy > 0)
                    index++;
                else if (dy < 0)
                    index--;
                else if (dx < 0)
                    index++;
                else if (dx > 0)
                    index--;
                else
                    return Clutter.EVENT_PROPAGATE;
            }

            let nindex = clamp(index, 0, wsManager.n_workspaces - 1);
            if (nindex !== wsManager.get_active_workspace().index()) {
                wsManager.get_workspace_by_index(nindex).activate(global.get_current_time());
            }

            return Clutter.EVENT_STOP;
        }

        _updateIcon() {
            const useSymbolic = this._settings.get_boolean('symbolic-logo');
            const useCustomLogo = this._settings.get_boolean('use-custom-logo');
            const customLogoPath = this._settings.get_string('custom-logo-path');
            const logoIndex = this._settings.get_int('logo-icon-image');

            let logoPath = 'start-here-symbolic';

            if (useCustomLogo && customLogoPath !== '') {
                logoPath = customLogoPath;
            } else if (useSymbolic) {
                if (Constants.SymbolicDistroIcons[logoIndex] !== undefined) {
                    logoPath = Constants.SymbolicDistroIcons[logoIndex].PATH;
                    if (logoPath.startsWith('/Resources/')) {
                        logoPath = this._extension.path + logoPath;
                    }
                }
            } else {
                if (Constants.ColouredDistroIcons[logoIndex] !== undefined) {
                    logoPath = Constants.ColouredDistroIcons[logoIndex].PATH;
                    if (logoPath.startsWith('/Resources/')) {
                        logoPath = this._extension.path + logoPath;
                    }
                }
            }

            // Validate path exists, fallback to default Apple logo
            if (logoPath.startsWith('/') && !GLib.file_test(logoPath, GLib.FileTest.IS_REGULAR)) {
                logoPath = this._extension.path + '/Resources/apple-icon-symbolic.svg';
            }

            try {
                this.icon.gicon = Gio.icon_new_for_string(logoPath);
            } catch (e) {
                console.error('WACK Shell: Failed to load icon', e);
                this.icon.icon_name = 'start-here-symbolic';
            }
        }

        _updateIconSize() {
            const size = this._settings.get_int('logo-icon-size');
            this.icon.icon_size = size;
        }

        _updateLabel() {
            const showLabel = this._settings.get_boolean('show-logo-label');
            const labelText = this._settings.get_string('logo-label-text');

            if (showLabel && labelText !== '') {
                this._label.set_text(labelText);
                this._label.show();
            } else {
                this._label.hide();
            }
        }



        _displayMenuItems() {
            this.menu.removeAll();

            // 1. About System / Distro Info
            this.menu.addMenuItem(new LogoMenuItem(_('About My System'), () => {
                const home = GLib.get_home_dir();
                const aboutPanePaths = [
                    '/usr/local/bin/aboutpane',
                    `${home}/.local/bin/aboutpane`,
                ];
                const found = aboutPanePaths.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
                if (found) {
                    try {
                        Util.trySpawnCommandLine(found);
                        return;
                    } catch (e) {
                        console.error('Failed to launch aboutpane:', e);
                    }
                }
                const gnomeMajorVersion = parseInt(Config.PACKAGE_VERSION.toString().split('.')[0]);
                if (gnomeMajorVersion >= 46) {
                    Util.spawn(['gnome-control-center', 'system', 'about']);
                } else {
                    Util.spawn(['gnome-control-center', 'info-overview']);
                }
            }));

            this.menu.addMenuItem(new LogoMenuItem(_('System Settings...'), () => {
                Util.spawn(['gnome-control-center']);
            }));

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // 2. App Grid
            this.menu.addMenuItem(new LogoMenuItem(_('App Grid'), () => {
                Main.overview.dash.showAppsButton.checked = true;
                Main.overview.show();
                Main.overview.dash.showAppsButton.checked = true;
            }));

            // 3. System Utility Launchers
            const showSoftware = !this._settings.get_boolean('hide-softwarecentre');
            if (showSoftware) {
                this.menu.addMenuItem(new LogoMenuItem(_('Software Center'), () => {
                    Util.trySpawnCommandLine(this._settings.get_string('menu-button-software-center'));
                }));
            }

            this.menu.addMenuItem(new LogoMenuItem(_('System Monitor'), () => {
                Util.trySpawnCommandLine(this._settings.get_string('menu-button-system-monitor'));
            }));

            this.menu.addMenuItem(new LogoMenuItem(_('Terminal'), () => {
                Util.trySpawnCommandLine(this._settings.get_string('menu-button-terminal'));
            }));

            this.menu.addMenuItem(new LogoMenuItem(_('Extensions'), () => {
                const appSys = Shell.AppSystem.get_default();
                const extensionManagerChoice = this._settings.get_string('menu-button-extensions-app');
                const extensionApp = appSys.lookup_app(extensionManagerChoice);
                if (extensionApp) {
                    try {
                        extensionApp.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
                    } catch (e) {
                        console.error(e);
                    }
                }
            }));

            // 4. Force Quit App
            const hideForceQuit = this._settings.get_boolean('hide-forcequit');
            if (!hideForceQuit) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this.menu.addMenuItem(new LogoMenuItem(_('Force Quit App'), () => {
                    new SelectionWindow();
                }));
            }

            // 5. System Power controls
            const showPower = this._settings.get_boolean('show-power-options');
            const showLock = this._settings.get_boolean('show-lockscreen');

            if (showPower || showLock) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                if (showPower) {
                    this.menu.addMenuItem(new LogoMenuItem(_('Sleep'), () => {
                        Util.spawn(['systemctl', 'suspend']);
                    }));
                    this.menu.addMenuItem(new LogoMenuItem(_('Restart...'), () => {
                        Util.spawn(['gnome-session-quit', '--reboot']);
                    }));
                    this.menu.addMenuItem(new LogoMenuItem(_('Shut Down...'), () => {
                        Util.spawn(['gnome-session-quit', '--power-off']);
                    }));
                }

                if (showLock) {
                    if (showPower) {
                        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    }
                    this.menu.addMenuItem(new LogoMenuItem(_('Lock Screen'), () => {
                        Util.spawn(['loginctl', 'lock-session']);
                    }));
                }

                if (showPower) {
                    this.menu.addMenuItem(new LogoMenuItem(_('Log Out...'), () => {
                        Util.spawn(['gnome-session-quit', '--logout']);
                    }));
                }
            }
        }

        handleDragOver(source, _actor, _x, _y, _time) {
            if (source != Main.xdndHandler)
                return DND.DragMotionResult.CONTINUE;

            if (this._xdndTimeOut != 0)
                GLib.source_remove(this._xdndTimeOut);
            this._xdndTimeOut = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUTTON_DND_ACTIVATION_TIMEOUT, () => {
                this._xdndToggleOverview();
            });
            GLib.Source.set_name_by_id(this._xdndTimeOut, '[gnome-shell] this._xdndToggleOverview');

            return DND.DragMotionResult.CONTINUE;
        }

        _xdndToggleOverview() {
            let [x, y] = global.get_pointer();
            let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);

            if (pickedActor == this && Main.overview.shouldToggleByCornerOrButton())
                Main.overview.toggle();

            GLib.source_remove(this._xdndTimeOut);
            this._xdndTimeOut = 0;
            return GLib.SOURCE_REMOVE;
        }

        destroy() {
            this._settings.disconnectObject(this);
            Main.overview.disconnectObject(this);
            if (this._xdndTimeOut) {
                GLib.source_remove(this._xdndTimeOut);
                this._xdndTimeOut = 0;
            }
            super.destroy();
        }
    });
const WackAppMenuButton = GObject.registerClass({
    Signals: { 'changed': {} },
}, class WackAppMenuButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, null, true);
        this.set({
            name: 'appMenu',
            accessible_role: Atk.Role.MENU,
        });
        this.add_style_class_name('wack-app-menu-button');

        this._settings = extension.getSettings();

        this._startingApps = [];
        this._menuManager = Main.panel.menuManager;
        this._targetApp = null;

        let bin = new St.Bin({ name: 'appMenu' });
        this.add_child(bin);

        this.bind_property('reactive', this, 'can-focus', 0);
        this.reactive = false;

        this._container = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        bin.set_child(this._container);

        this._desaturateEffect = new Clutter.DesaturateEffect();
        this._iconBox = new St.Bin({
            style_class: 'app-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 4px; -st-icon-style: symbolic',
        });
        this._container.add_child(this._iconBox);

        this._label = new St.Label({
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._container.add_child(this._label);

        this._visible = !Main.overview.visible;
        if (!this._visible)
            this.hide();

        Main.overview.connectObject(
            'hiding', this._sync.bind(this),
            'showing', this._sync.bind(this), this
        );

        let menu = new AppMenu(this);
        this.setMenu(menu);
        this._menuManager.addMenu(menu);

        Shell.WindowTracker.get_default().connectObject('notify::focus-app',
            this._focusAppChanged.bind(this), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed',
            this._onAppStateChanged.bind(this), this);
        global.window_manager.connectObject('switch-workspace',
            this._sync.bind(this), this);

        this._settings.connectObject('changed::colored-app-menu-icon',
            this._updateIconEffect.bind(this), this);

        this._updateIconEffect();
        this._sync();
    }

    fadeIn() {
        if (this._visible)
            return;

        this._visible = true;
        this.show();
        this.reactive = true;
        this.remove_all_transitions();
        this.ease({
            opacity: 255,
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    fadeOut() {
        if (!this._visible)
            return;

        this._visible = false;
        this.reactive = false;
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Overview.ANIMATION_TIME,
            onComplete: () => {
                if (!this._visible)
                    this.hide();
            },
        });
    }

    _syncIcon(app) {
        const PANEL_ICON_SIZE = 16;
        const icon = app.create_icon_texture(PANEL_ICON_SIZE);
        this._iconBox.set_child(icon);
    }

    _onAppStateChanged(appSys, app) {
        let state = app.state;
        if (state !== Shell.AppState.STARTING)
            this._startingApps = this._startingApps.filter(a => a !== app);
        else if (state === Shell.AppState.STARTING)
            this._startingApps.push(app);

        // Performance Improvement: Only run find/sync if the state change is relevant to active window or start queue
        if (app === this._targetApp || state === Shell.AppState.STARTING) {
            this._sync();
        }
    }

    _focusAppChanged() {
        let tracker = Shell.WindowTracker.get_default();
        let focusedApp = tracker.focus_app;
        if (!focusedApp) {
            if (global.stage.key_focus != null)
                return;
        }
        this._sync();
    }

    _findTargetApp() {
        let workspaceManager = global.workspace_manager;
        let workspace = workspaceManager.get_active_workspace();
        let tracker = Shell.WindowTracker.get_default();
        let focusedApp = tracker.focus_app;
        if (focusedApp && focusedApp.is_on_workspace(workspace))
            return focusedApp;

        for (let i = 0; i < this._startingApps.length; i++) {
            if (this._startingApps[i].is_on_workspace(workspace))
                return this._startingApps[i];
        }

        return null;
    }

    _sync() {
        let targetApp = this._findTargetApp();

        if (this._targetApp !== targetApp) {
            this._targetApp?.disconnectObject(this);
            this._targetApp = targetApp;

            if (this._targetApp) {
                this._targetApp.connectObject('notify::busy', this._sync.bind(this), this);
                this._label.set_text(this._targetApp.get_name());
                this.set_accessible_name(this._targetApp.get_name());
                this._syncIcon(this._targetApp);
            }
        }

        let visible = this._targetApp != null && !Main.overview.visibleTarget;
        if (visible)
            this.fadeIn();
        else
            this.fadeOut();

        let isBusy = this._targetApp != null &&
            (this._targetApp.get_state() === Shell.AppState.STARTING ||
                this._targetApp.get_busy());

        this.reactive = visible && !isBusy;

        this.menu.setApp(this._targetApp);
        this.emit('changed');
    }

    _updateIconEffect() {
        const colored = this._settings.get_boolean('colored-app-menu-icon');
        const hasEffect = this._iconBox.get_effects?.().includes(this._desaturateEffect);

        if (colored) {
            if (hasEffect)
                this._iconBox.remove_effect(this._desaturateEffect);
            this._iconBox.style = 'margin-right: 4px; -st-icon-style: regular';
        } else {
            if (!hasEffect)
                this._iconBox.add_effect(this._desaturateEffect);
            this._iconBox.style = 'margin-right: 4px; -st-icon-style: symbolic';
        }
    }

    destroy() {
        this._targetApp?.disconnectObject(this);
        this._targetApp = null;

        this._settings?.disconnectObject(this);

        Main.overview.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        global.window_manager.disconnectObject(this);

        this.menu?.destroy();
        this._menuManager?.removeMenu(this.menu);

        super.destroy();
    }
});

// Separate WackWorkspaceButton (can show workspace indicators or Activities label)
const WackWorkspaceButton = GObject.registerClass(
    class WackWorkspaceButton extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'WackWorkspaceButton', true);
            this.set({
                name: 'panelActivities',
                accessible_role: Atk.Role.TOGGLE_BUTTON,
                accessible_name: _('Activities'),
            });
            this.add_style_class_name('wack-workspace-button');

            this._extension = extension;
            this._settings = extension.getSettings();

            // Single box layout
            this._container = new St.BoxLayout({ style_class: 'activities-layout' });
            this.add_child(this._container);

            // Label (GNOME 40+ Activities style)
            this._label = new St.Label({
                text: _('Activities'),
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._container.add_child(this._label);

            // Workspace Indicators (GNOME 45 style)
            this._workspaceBox = new St.Bin({
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._container.add_child(this._workspaceBox);

            // Overview checked state syncing
            Main.overview.connectObject(
                'showing', () => {
                    this.add_style_pseudo_class('checked');
                    this.add_accessible_state(Atk.StateType.CHECKED);
                },
                'hiding', () => {
                    this.remove_style_pseudo_class('checked');
                    this.remove_accessible_state(Atk.StateType.CHECKED);
                },
                this
            );

            this._settings.connectObject(
                'changed::workspace-widget-type', () => this._updateWidget(),
                'changed::show-workspace-number', () => this._updateLabel(),
                this
            );

            global.workspace_manager.connectObject(
                'active-workspace-changed', () => this._updateLabel(),
                this
            );

            this._updateWidget();

            // Drag/scroll/DND variables
            this._lastScrollTime = 0;
            this._xdndTimeOut = 0;
            this.connect('scroll-event', this._onScrollEvent.bind(this));
        }

        _updateWidget() {
            const type = this._settings.get_int('workspace-widget-type');

            if (type === 0) { // Workspace Indicators (dots)
                this._label.hide();
                if (!this._workspaceIndicators) {
                    this._workspaceIndicators = new WorkspaceIndicators();
                    this._workspaceBox.set_child(this._workspaceIndicators);
                }
                this._workspaceBox.show();
            } else { // Activities Label
                this._workspaceBox.hide();
                if (this._workspaceIndicators) {
                    this._workspaceIndicators.destroy();
                    this._workspaceIndicators = null;
                }
                this._updateLabel();
                this._label.show();
            }
        }

        _updateLabel() {
            const showNum = this._settings.get_boolean('show-workspace-number');
            if (showNum) {
                const activeWorkspace = global.workspace_manager.get_active_workspace();
                const index = activeWorkspace.index() + 1; // 1-indexed
                this._label.set_text(`${_('Activities')} • ${index}`);
            } else {
                this._label.set_text(_('Activities'));
            }
        }

        vfunc_event(event) {
            if (event.type() === Clutter.EventType.TOUCH_END ||
                event.type() === Clutter.EventType.BUTTON_RELEASE) {
                if (Main.overview.shouldToggleByCornerOrButton()) {
                    Main.overview.toggle();
                    return Clutter.EVENT_STOP;
                }
            }
            return super.vfunc_event(event);
        }

        _onScrollEvent(actor, event) {
            if (!this._settings.get_boolean('desktop-scroll'))
                return Clutter.EVENT_PROPAGATE;

            const now = Date.now();
            if (now - this._lastScrollTime < 200)
                return Clutter.EVENT_STOP;
            this._lastScrollTime = now;

            const wsManager = global.workspace_manager;
            let index = wsManager.get_active_workspace().index();

            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.DOWN) {
                index++;
            } else if (direction === Clutter.ScrollDirection.UP) {
                index--;
            } else if (direction === Clutter.ScrollDirection.LEFT) {
                index++;
            } else if (direction === Clutter.ScrollDirection.RIGHT) {
                index--;
            } else {
                let [dx, dy] = event.get_scroll_delta();
                if (dy > 0)
                    index++;
                else if (dy < 0)
                    index--;
                else if (dx < 0)
                    index++;
                else if (dx > 0)
                    index--;
                else
                    return Clutter.EVENT_PROPAGATE;
            }

            let nindex = clamp(index, 0, wsManager.n_workspaces - 1);
            if (nindex !== wsManager.get_active_workspace().index()) {
                wsManager.get_workspace_by_index(nindex).activate(global.get_current_time());
            }
            return Clutter.EVENT_STOP;
        }

        handleDragOver(source, _actor, _x, _y, _time) {
            if (source != Main.xdndHandler)
                return DND.DragMotionResult.CONTINUE;

            if (this._xdndTimeOut != 0)
                GLib.source_remove(this._xdndTimeOut);
            this._xdndTimeOut = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUTTON_DND_ACTIVATION_TIMEOUT, () => {
                this._xdndToggleOverview();
            });
            GLib.Source.set_name_by_id(this._xdndTimeOut, '[gnome-shell] this._xdndToggleOverview');

            return DND.DragMotionResult.CONTINUE;
        }

        _xdndToggleOverview() {
            let [x, y] = global.get_pointer();
            let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);

            if (pickedActor == this && Main.overview.shouldToggleByCornerOrButton())
                Main.overview.toggle();

            GLib.source_remove(this._xdndTimeOut);
            this._xdndTimeOut = 0;
            return GLib.SOURCE_REMOVE;
        }

        destroy() {
            this._settings.disconnectObject(this);
            Main.overview.disconnectObject(this);
            global.workspace_manager.disconnectObject(this);
            if (this._xdndTimeOut) {
                GLib.source_remove(this._xdndTimeOut);
                this._xdndTimeOut = 0;
            }
            if (this._workspaceIndicators) {
                this._workspaceIndicators.destroy();
                this._workspaceIndicators = null;
            }
            super.destroy();
        }
    });

// Extension Entry Class
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

        this._destroyProximityTracking();
        this._unloadProximityStylesheet();
        this._clearPanelStyle();
        if (this._desktopSettings) {
            this._desktopSettings.disconnectObject(this);
            this._desktopSettings = null;
        }

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
            this._animateWindowsIn();
        }

        this._lastHasWindows = hasWindows;
    }

    _animateWindowsIn() {
        let windowActors = [];
        try {
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = workspace.list_windows().filter(metaWindow => {
                return !metaWindow.is_hidden() &&
                       metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
                       !metaWindow.is_attached_dialog() &&
                       !metaWindow.maximized_horizontally &&
                       !metaWindow.maximized_vertically;
            });
            windowActors = windows.map(w => w.get_compositor_private()).filter(actor => actor !== null);
        } catch (err) {
            console.error(`[WACK Shell] Failed to find windows for animation: ${err}`);
            return;
        }

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

    _initProximity() {
        this._proximitySignals = [];
        this._proximityWindowSignals = new Map();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._customCssPath = GLib.build_filenamev([this.path, 'stylesheet-custom.css']);
        this._customCssFile = Gio.File.new_for_path(this._customCssPath);
        this._desktopSettings = new Gio.Settings({ schema: "org.gnome.desktop.interface" });

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

        // Tear down any existing tracking first
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
        // Connect to overview opening/closing
        const sigShowing = Main.overview.connect('showing', () => this._updatePanelVisibility());
        const sigHidden = Main.overview.connect('hidden', () => this._updatePanelVisibility());
        this._proximitySignals.push({ object: Main.overview, id: sigShowing });
        this._proximitySignals.push({ object: Main.overview, id: sigHidden });

        // Connect to session mode update
        const sigSession = Main.sessionMode.connect('updated', () => this._updatePanelVisibility());
        this._proximitySignals.push({ object: Main.sessionMode, id: sigSession });

        // Manage already-existing windows
        for (const meta_window_actor of global.get_window_actors()) {
            this._onProximityWindowActorAdded(meta_window_actor.get_parent(), meta_window_actor);
        }

        // Manage windows at their creation/removal
        const sigChildAdded = global.window_group.connect('child-added', this._onProximityWindowActorAdded.bind(this));
        const sigChildRemoved = global.window_group.connect('child-removed', this._onProximityWindowActorRemoved.bind(this));
        this._proximitySignals.push({ object: global.window_group, id: sigChildAdded });
        this._proximitySignals.push({ object: global.window_group, id: sigChildRemoved });

        // Connect to workspace change
        const sigSwitchWS = global.window_manager.connect('switch-workspace', () => this._updatePanelVisibility());
        this._proximitySignals.push({ object: global.window_manager, id: sigSwitchWS });

        // Perform initial update
        this._updatePanelVisibility();
    }

    _onProximityWindowActorAdded(container, meta_window_actor) {
        const signals = [
            { object: meta_window_actor, id: meta_window_actor.connect('notify::allocation', () => this._updatePanelVisibility()) },
            { object: meta_window_actor, id: meta_window_actor.connect('notify::visible', () => this._updatePanelVisibility()) }
        ];

        if (meta_window_actor.meta_window) {
            signals.push({ object: meta_window_actor.meta_window, id: meta_window_actor.meta_window.connect('notify::minimized', () => this._updatePanelVisibility()) });
        }

        this._proximityWindowSignals.set(meta_window_actor, signals);
        this._updatePanelVisibility();
    }

    _onProximityWindowActorRemoved(container, meta_window_actor) {
        const signals = this._proximityWindowSignals.get(meta_window_actor);
        if (signals) {
            signals.forEach(({ object, id }) => object.disconnect(id));
            this._proximityWindowSignals.delete(meta_window_actor);
        }
        this._updatePanelVisibility();
    }

    _destroyProximityTracking() {
        if (this._proximitySignals) {
            this._proximitySignals.forEach(s => s.object.disconnect(s.id));
            this._proximitySignals = [];
        }

        if (this._proximityWindowSignals) {
            for (const [win, signals] of this._proximityWindowSignals) {
                signals.forEach(({ object, id }) => object.disconnect(id));
            }
            this._proximityWindowSignals.clear();
        }
    }

    _unloadProximityStylesheet() {
        if (this._themeId) {
            this._themeContext.get_theme().unload_stylesheet(this._customCssFile);
            this._themeId = false;
        }
    }

    _isProximityDarkMode() {
        return this._desktopSettings.get_string('color-scheme') === 'prefer-dark';
    }

    _updateProximityStylesheet() {
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
`;
        try {
            const bytes = new TextEncoder().encode(cssString);
            this._customCssFile.replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
            this._themeContext.get_theme().load_stylesheet(this._customCssFile);
            this._themeId = true;
        } catch (e) {
            console.error(`[wack-shell-proximity] Error writing custom stylesheet: ${e}`);
        }

        this._updatePanelVisibility();
    }

    _updatePanelVisibility() {
        if (!this._settings.get_boolean('enable-panel-proximity')) {
            this._clearPanelStyle();
            return;
        }

        // Don't apply custom color when overview is visible
        if (Main.overview.visible) {
            this._clearPanelStyle();
            return;
        }

        // Don't apply custom color when screen is locked
        if (Main.sessionMode.currentMode === 'unlock-dialog') {
            this._clearPanelStyle();
            return;
        }

        if (!Main.layoutManager.primaryMonitor) return;

        // Get all windows in the active workspace that are visible
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(meta_window =>
            meta_window.showing_on_its_workspace() &&
            !meta_window.is_hidden() &&
            meta_window.get_window_type() !== Meta.WindowType.DESKTOP &&
            // Exclude Desktop Icons NG
            meta_window.get_gtk_application_id() !== "com.rastersoft.ding" &&
            meta_window.get_gtk_application_id() !== "com.desktop.ding"
        );

        // Check if any window is near the panel
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

            // Check if window is near panel (within 5 * scale pixels)
            if (sameMonitor &&
                // Panel on top
                ((panelTop === 0 && windowVerticalPos < panelBottom + 5 * scale) ||
                    // Panel at bottom
                    (panelTop > 0 && windowVerticalBottom > panelTop - 5 * scale))
            ) {
                windowNearPanel = true;
            }
        });

        // Apply custom color if window is near panel
        if (windowNearPanel) {
            this._applyPanelStyle();
        } else {
            this._clearPanelStyle();
        }
    }

    _applyPanelStyle() {
        Main.panel.add_style_class_name('panel-proximity');
    }

    _clearPanelStyle() {
        Main.panel.remove_style_class_name('panel-proximity');
    }
}