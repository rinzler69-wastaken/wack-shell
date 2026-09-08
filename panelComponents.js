import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Constants from './constants.js';

const INACTIVE_WORKSPACE_DOT_SCALE = 0.75;
const BUTTON_DND_ACTIVATION_TIMEOUT = 500;

const { clamp } = Constants;

// Custom MenuItem class registered once at module load
function isDarkTheme() {
    try {
        const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        return interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    } catch (e) {
        return true;
    }
}

export const LogoMenuItem = GObject.registerClass(
    class WackLogoMenuItem extends PopupMenu.PopupMenuItem {
        _init(name, activateFunction, shortcut = null, isDark = null) {
            super._init(name);
            this.connect('activate', activateFunction);

            if (shortcut) {
                const dark = isDark !== null ? isDark : isDarkTheme();
                const themeClass = dark ? 'dark-theme' : 'light-theme';
                this._shortcutLabel = new St.Label({
                    text: shortcut,
                    style_class: `wack-logo-menu-shortcut ${themeClass}`,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.END,
                    x_expand: true,
                });
                this.add_child(this._shortcutLabel);

                const updateHoverState = () => {
                    const active = Boolean(this.hover || this.active);
                    if (active) {
                        this._shortcutLabel.add_style_pseudo_class('hover');
                        this._shortcutLabel.add_style_pseudo_class('selected');
                        this._shortcutLabel.add_style_class_name('highlighted');
                    } else {
                        this._shortcutLabel.remove_style_pseudo_class('hover');
                        this._shortcutLabel.remove_style_pseudo_class('selected');
                        this._shortcutLabel.remove_style_class_name('highlighted');
                    }
                };

                this.connectObject(
                    'notify::hover', updateHoverState,
                    'notify::active', updateHoverState,
                    this
                );
            }
        }

        destroy() {
            this.disconnectObject(this);
            super.destroy();
        }
    });

let _isMacCached = null;
function isMacHardware() {
    if (_isMacCached !== null) return _isMacCached;
    try {
        const vendorPath = '/sys/class/dmi/id/sys_vendor';
        if (GLib.file_test(vendorPath, GLib.FileTest.EXISTS)) {
            const [ok, contents] = GLib.file_get_contents(vendorPath);
            if (ok) {
                const str = new TextDecoder().decode(contents).trim().toLowerCase();
                if (str.includes('apple')) {
                    _isMacCached = true;
                    return true;
                }
            }
        }
        const dtPath = '/sys/firmware/devicetree/base/compatible';
        if (GLib.file_test(dtPath, GLib.FileTest.EXISTS)) {
            const [ok, contents] = GLib.file_get_contents(dtPath);
            if (ok) {
                const str = new TextDecoder().decode(contents).toLowerCase();
                if (str.includes('apple,')) {
                    _isMacCached = true;
                    return true;
                }
            }
        }
    } catch (e) {
        console.error('Failed to detect hardware type:', e);
    }
    _isMacCached = false;
    return false;
}

function isMacStyle(settings) {
    const styleChoice = settings.get_int('menu-shortcut-style');
    if (styleChoice === 1) return true;
    if (styleChoice === 2) return false;
    return isMacHardware();
}

function formatShortcut(binding, isMac) {
    if (!binding || typeof binding !== 'string') return null;
    const trimmed = binding.trim();
    if (!trimmed) return null;

    const hasCtrl = /<(Control|Primary)>/i.test(trimmed);
    const hasAlt = /<Alt>/i.test(trimmed);
    const hasShift = /<Shift>/i.test(trimmed);
    const hasSuper = /<Super>/i.test(trimmed);
    const key = trimmed.replace(/<[^>]+>/g, '').trim();
    if (!key) return null;

    if (isMac) {
        let res = '';
        if (hasCtrl) res += '⌃';
        if (hasAlt) res += '⌥';
        if (hasShift) res += '⇧';
        if (hasSuper) res += '⌘';
        const macKeys = {
            'delete': '⌦',
            'backspace': '⌫',
            'return': '↩',
            'enter': '↩',
            'escape': '⎋',
            'esc': '⎋',
            'space': '␣',
            'tab': '⇥',
            'up': '↑',
            'down': '↓',
            'left': '←',
            'right': '→',
        };
        const lowerKey = key.toLowerCase();
        res += macKeys[lowerKey] || key.toUpperCase();
        return res;
    } else {
        const mods = [];
        if (hasCtrl) mods.push('Ctrl');
        if (hasAlt) mods.push('Alt');
        if (hasShift) mods.push('Shift');
        if (hasSuper) mods.push('Super');
        const pcKeys = {
            'delete': 'Del',
            'backspace': 'Backspace',
            'return': 'Enter',
            'enter': 'Enter',
            'escape': 'Esc',
            'esc': 'Esc',
            'space': 'Space',
            'tab': 'Tab',
            'page_up': 'PgUp',
            'page_down': 'PgDn',
        };
        const lowerKey = key.toLowerCase();
        const formattedKey = pcKeys[lowerKey] || (key.length === 1 ? key.toUpperCase() : key);
        mods.push(formattedKey);
        return mods.join('+');
    }
}

function resolveShortcut(action, sourceMode, isMac) {
    // sourceMode: 0 = User Defined (GNOME Settings), 1 = System Default
    if (sourceMode === 0) {
        try {
            const mk = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.media-keys' });
            const customPaths = mk.get_strv('custom-keybindings') || [];
            for (const path of customPaths) {
                const s = new Gio.Settings({
                    schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
                    path,
                });
                const name = (s.get_string('name') || '').toLowerCase();
                const cmd = (s.get_string('command') || '').toLowerCase();
                const binding = s.get_string('binding');
                if (!binding) continue;

                if (action === 'lock-screen') {
                    if (name === 'lock' || name === 'lock screen' || cmd.includes('lock')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'logout') {
                    if ((name === 'log out' || name === 'logout') && !cmd.includes('--reboot') && !cmd.includes('--power-off')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'restart') {
                    if (name === 'restart' || cmd.includes('--reboot')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'shutdown') {
                    if (name === 'shutdown' || name === 'shut down' || name === 'power off' || cmd.includes('--power-off')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'settings') {
                    if (name === 'settings' || name === 'system settings' || name.includes('control center') || cmd.includes('gnome-control-center')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'terminal') {
                    if (name.includes('terminal') || cmd.includes('terminal') || cmd.includes('ptyxis') || cmd.includes('alacritty') || cmd.includes('kitty') || cmd.includes('ghostty') || cmd.includes('wezterm') || cmd.includes('kgx') || cmd.includes('foot')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'extensions') {
                    if (name.includes('extension') || cmd.includes('gnome-extensions-app') || cmd.includes('extension-manager')) {
                        return formatShortcut(binding, isMac);
                    }
                } else if (action === 'system-monitor') {
                    if (name.includes('monitor') || name.includes('task manager') || name.includes('system monitor') || cmd.includes('gnome-system-monitor') || cmd.includes('resources') || cmd.includes('mission-center') || cmd.includes('btop') || cmd.includes('htop')) {
                        return formatShortcut(binding, isMac);
                    }
                }
            }

            if (action === 'lock-screen') {
                const bindings = mk.get_strv('screensaver') || [];
                if (bindings.length > 0 && bindings[0]) {
                    return formatShortcut(bindings[0], isMac);
                }
            } else if (action === 'logout') {
                const bindings = mk.get_strv('logout') || [];
                if (bindings.length > 0 && bindings[0]) {
                    return formatShortcut(bindings[0], isMac);
                }
            } else if (action === 'settings') {
                const userVal = mk.get_user_value('control-center');
                if (userVal) {
                    const bindings = mk.get_strv('control-center') || [];
                    if (bindings.length > 0 && bindings[0]) {
                        return formatShortcut(bindings[0], isMac);
                    }
                }
            } else if (action === 'terminal') {
                const userVal = mk.get_user_value('terminal');
                if (userVal) {
                    const bindings = mk.get_strv('terminal') || [];
                    if (bindings.length > 0 && bindings[0]) {
                        return formatShortcut(bindings[0], isMac);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to resolve shortcut from GNOME settings:', e);
        }
    }

    // System Defaults
    if (action === 'lock-screen') {
        return isMac ? '⌃⌘Q' : 'Super+L';
    } else if (action === 'logout') {
        return isMac ? '⇧⌘Q' : 'Ctrl+Alt+Del';
    }
    return null;
}

function getSystemUserName() {
    try {
        return GLib.get_user_name() || '';
    } catch (e) {
        return '';
    }
}

// Workspace dot actor
export const WorkspaceDot = GObject.registerClass({
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
        const [minWidth, natWidth] = this._dot.get_preferred_width(forHeight);
        return [Math.round(minWidth * factor), Math.round(natWidth * factor)];
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
export const WorkspaceIndicators = GObject.registerClass(
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
export const WackLogoButton = GObject.registerClass(
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
            this._settings = extension._settings;

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
                'changed::hide-softwarecentre', () => this._displayMenuItems(),
                'changed::show-menu-shortcuts', () => this._displayMenuItems(),
                'changed::menu-shortcut-source', () => this._displayMenuItems(),
                'changed::menu-shortcut-style', () => this._displayMenuItems(),
                'changed::menu-shortcut-amount', () => this._displayMenuItems(),
                this
            );

            // Re-render menu on open so newly assigned shortcuts are instantly detected
            this.menu.connectObject('open-state-changed', (menu, isOpen) => {
                if (isOpen)
                    this._displayMenuItems();
            }, this);

            // Also monitor GNOME media-keys settings for changes in the background
            try {
                this._mediaKeysSettings = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.media-keys' });
                this._mediaKeysSettings.connectObject('changed', () => this._displayMenuItems(), this);
            } catch (e) {
                console.error('Failed to monitor media-keys settings:', e);
            }

            // Monitor color-scheme settings for light/dark theme awareness
            try {
                this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                this._interfaceSettings.connectObject('changed::color-scheme', () => this._displayMenuItems(), this);
            } catch (e) {
                console.error('Failed to monitor interface color-scheme settings:', e);
            }

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
                logoPath = 'start-here-symbolic';
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

            const showShortcuts = this._settings.get_boolean('show-menu-shortcuts');
            const shortcutSource = this._settings.get_int('menu-shortcut-source');
            const shortcutAmount = this._settings.get_int('menu-shortcut-amount');
            const isMac = isMacStyle(this._settings);
            const isDark = isDarkTheme();

            const getShortcut = (action) => {
                if (!showShortcuts) return null;
                // "More" is only available when displaying custom shortcuts (shortcutSource === 0).
                // If System Default (1) or "Less" (0), only show shortcuts for Lock Screen and Log Out.
                if ((shortcutAmount === 0 || shortcutSource === 1) && action !== 'lock-screen' && action !== 'logout') {
                    return null;
                }
                return resolveShortcut(action, shortcutSource, isMac);
            };

            // 1. About System / Distro Info
            this.menu.addMenuItem(new LogoMenuItem(_('About This System'), () => {
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
                        console.error('Failed to launch aboutpane', e);
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
            }, getShortcut('settings'), isDark));

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
            }, getShortcut('system-monitor'), isDark));

            this.menu.addMenuItem(new LogoMenuItem(_('Terminal'), () => {
                Util.trySpawnCommandLine(this._settings.get_string('menu-button-terminal'));
            }, getShortcut('terminal'), isDark));

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
            }, getShortcut('extensions'), isDark));



            // 5. System Power and Session controls
            const showPower = this._settings.get_boolean('show-power-options');

            if (showPower) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                // Power controls
                this.menu.addMenuItem(new LogoMenuItem(_('Sleep'), () => {
                    SystemActions.getDefault().activateSuspend();
                }));
                this.menu.addMenuItem(new LogoMenuItem(_('Restart...'), () => {
                    SystemActions.getDefault().activateRestart();
                }, getShortcut('restart'), isDark));
                this.menu.addMenuItem(new LogoMenuItem(_('Shut Down...'), () => {
                    SystemActions.getDefault().activatePowerOff();
                }, getShortcut('shutdown'), isDark));

                // Separator line between Power and Session options
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                // Session controls
                this.menu.addMenuItem(new LogoMenuItem(_('Lock Screen'), () => {
                    SystemActions.getDefault().activateLockScreen();
                }, getShortcut('lock-screen'), isDark));
                this.menu.addMenuItem(new LogoMenuItem(_('Switch User...'), () => {
                    SystemActions.getDefault().activateSwitchUser();
                }));

                const username = getSystemUserName();
                const logoutLabel = username ? `${_('Log Out')} ${username}...` : _('Log Out...');
                this.menu.addMenuItem(new LogoMenuItem(logoutLabel, () => {
                    SystemActions.getDefault().activateLogout();
                }, getShortcut('logout'), isDark));
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
            this.menu.disconnectObject(this);
            if (this._mediaKeysSettings) {
                this._mediaKeysSettings.disconnectObject(this);
                this._mediaKeysSettings = null;
            }
            if (this._interfaceSettings) {
                this._interfaceSettings.disconnectObject(this);
                this._interfaceSettings = null;
            }
            if (this._xdndTimeOut) {
                GLib.source_remove(this._xdndTimeOut);
                this._xdndTimeOut = 0;
            }
            super.destroy();
        }
    });

export const WackAppMenuButton = GObject.registerClass({
    Signals: { 'changed': {} },
}, class WackAppMenuButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, null, true);
        this.set({
            name: 'appMenu',
            accessible_role: Atk.Role.MENU,
        });
        this.add_style_class_name('wack-app-menu-button');

        this._extension = extension;
        this._settings = extension._settings;

        this._startingApps = [];
        this._menuManager = Main.panel.menuManager;
        this._targetApp = null;

        let bin = new St.Bin({ name: 'appMenu' });
        this.add_child(bin);

        this.bind_property('reactive', this, 'can-focus', 0);
        this.reactive = false;

        this._container = new St.BoxLayout({
            style_class: 'panel-status-menu-box', y_align: Clutter.ActorAlign.CENTER,
        });
        bin.set_child(this._container);

        this._desaturateEffect = new Clutter.DesaturateEffect();
        this._iconBox = new St.Bin({
            style_class: 'app-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 4px; -st-icon-style: symbolic',
        });
        this._container.add_child(this._iconBox);

        this._label = new St.Label({
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

        this._settings.connectObject(
            'changed::colored-app-menu-icon', this._updateIconEffect.bind(this),
            'changed::show-app-menu-icon', this._updateAppMenuVisibility.bind(this),
            'changed::show-app-menu-label', this._updateAppMenuVisibility.bind(this),
            this
        );

        this._updateIconEffect();
        this._updateAppMenuVisibility();
        this._sync(true);
    }

    fadeIn() {
        if (this._visible)
            return;

        this._visible = true;
        this.show();
        this.reactive = true;
        if (this.container) {
            this.container.opacity = 255;
            this.container.reactive = true;
            this.container.show();
        }
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

    _sync(instant = false) {
        const forceInstant = instant === true;
        const isLocked = !Main.sessionMode.hasWindows;
        if (isLocked) {
            this._visible = false;
            this.reactive = false;
            this.opacity = 0;
            this.hide();
            if (this.container) {
                this.container.opacity = 0;
                this.container.reactive = false;
                this.container.hide();
            }
            return;
        }

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
        if (visible) {
            if (forceInstant) {
                this._visible = true;
                this.show();
                this.reactive = true;
                this.opacity = 255;
                if (this.container) {
                    this.container.opacity = 255;
                    this.container.reactive = true;
                    this.container.show();
                }
            } else {
                this.fadeIn();
            }
        } else {
            if (forceInstant) {
                this._visible = false;
                this.hide();
                this.reactive = false;
                this.opacity = 0;
                if (this.container) {
                    this.container.opacity = 0;
                    this.container.reactive = false;
                    this.container.hide();
                }
            } else {
                this.fadeOut();
            }
        }

        let isBusy = this._targetApp != null &&
            (this._targetApp.get_state() === Shell.AppState.STARTING ||
                this._targetApp.get_busy());

        this.reactive = visible && !isBusy;
        this.sync_hover(); //after an app is focused, this ensures the appmenu is not being hovered over without the cursor over it

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

    _updateAppMenuVisibility() {
        const showIcon = this._settings.get_boolean('show-app-menu-icon');
        const showLabel = this._settings.get_boolean('show-app-menu-label');

        if (showIcon) {
            this._iconBox.show();
        } else {
            this._iconBox.hide();
        }

        if (showLabel) {
            this._label.show();
        } else {
            this._label.hide();
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



export const WackWorkspaceButton = GObject.registerClass(
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
            this._settings = extension._settings;

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

export class QuickSettingsPowerManager {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension._settings;

        this._settings.connectObject(
            'changed::show-logo-menu', () => this.sync(),
            'changed::show-power-options', () => this.sync(),
            'changed::hide-qs-power-options', () => this.sync(),
            this
        );

        Main.sessionMode.connectObject(
            'updated', () => this.sync(),
            this
        );

        if (Main.screenShield) {
            Main.screenShield.connectObject(
                'active-changed', () => this.sync(),
                this
            );
        }

        this.sync();
    }

    _isLockscreen() {
        const currentMode = Main.sessionMode.currentMode;
        if (currentMode === 'unlock-dialog' || currentMode === 'greeter' || currentMode === 'gdm')
            return true;
        if (Main.sessionMode.isLocked)
            return true;
        if (Main.screenShield) {
            if (Main.screenShield.active)
                return true;
            if (typeof Main.screenShield.isLocked === 'function' && Main.screenShield.isLocked())
                return true;
        }
        return false;
    }

    _isLockItem(item) {
        const typeName = item.constructor.name || '';
        if (typeName === 'LockItem')
            return true;
        if (item._action === 'lock' || item.action === 'lock')
            return true;
        const accessibleName = item.accessible_name || (typeof item.get_accessible_name === 'function' ? item.get_accessible_name() : '');
        if (typeof accessibleName === 'string' && accessibleName.toLowerCase().includes('lock'))
            return true;
        return false;
    }

    _getPowerItems() {
        try {
            const systemIndicator = Main.panel.statusArea.quickSettings?._system;
            const systemItem = systemIndicator?._systemItem;
            const boxLayout = systemItem?.child;
            if (!boxLayout)
                return [];

            const children = boxLayout.get_children();
            return children.filter(c => {
                const typeName = c.constructor.name || '';
                return typeName === 'LockItem' || typeName === 'ShutdownItem' ||
                    c._systemActions !== undefined || c.menu !== undefined;
            });
        } catch (e) {
            console.error('WACK Shell: Failed to locate Quick Settings power items', e);
            return [];
        }
    }

    sync() {
        const isLockscreen = this._isLockscreen();
        const showLogoMenu = this._settings.get_boolean('show-logo-menu');
        const showPowerOptions = this._settings.get_boolean('show-power-options');
        const hideQsPowerOptions = this._settings.get_boolean('hide-qs-power-options');

        const shouldHideAllQsPower = showLogoMenu && showPowerOptions && hideQsPowerOptions;

        const powerItems = this._getPowerItems();
        powerItems.forEach(item => {
            const isLock = this._isLockItem(item);

            let shouldHideItem = false;
            if (isLockscreen) {
                // On lockscreen: lock button makes no sense so hide it, but show power options (shutdown/restart/suspend)
                shouldHideItem = isLock;
            } else {
                // On desktop: hide all QS power controls if option to hide QS power options is active
                shouldHideItem = shouldHideAllQsPower;
            }

            if (shouldHideItem) {
                if (!item._wackSignalId) {
                    item._wackSignalId = item.connect('notify::visible', () => {
                        if (item._wackHiding && item.visible) {
                            item.visible = false;
                        }
                    });
                }
                if (item._sync && !item._wackOriginalSync) {
                    item._wackOriginalSync = item._sync;
                    item._sync = () => { item.visible = false; };
                }
                item._wackHiding = true;
                item.visible = false;
            } else {
                item._wackHiding = false;
                if (item._wackOriginalSync) {
                    item._sync = item._wackOriginalSync;
                    delete item._wackOriginalSync;
                }
                if (item._wackSignalId) {
                    item.disconnect(item._wackSignalId);
                    delete item._wackSignalId;
                }
                if (item._sync)
                    item._sync();
                else
                    item.visible = true;
            }
        });
    }

    destroy() {
        this._settings?.disconnectObject(this);
        Main.sessionMode?.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);

        const powerItems = this._getPowerItems();
        powerItems.forEach(item => {
            item._wackHiding = false;
            if (item._wackOriginalSync) {
                item._sync = item._wackOriginalSync;
                delete item._wackOriginalSync;
            }
            if (item._wackSignalId) {
                item.disconnect(item._wackSignalId);
                delete item._wackSignalId;
            }
            if (item._sync)
                item._sync();
            else
                item.visible = true;
        });
    }
}
