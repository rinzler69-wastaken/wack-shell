import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISTRO_LOGOS = [
    "Default",
    "Apple (Wackintosh)",
    "Fedora",
    "Debian",
    "Manjaro",
    "Pop!_OS",
    "Ubuntu",
    "Arch Linux",
    "openSUSE",
    "Raspbian",
    "Kali Linux",
    "PureOS",
    "Solus",
    "Budgie",
    "Gentoo",
    "MX Linux",
    "Red Hat",
    "Voyager",
    "Garuda",
    "FreeBSD",
    "Tux (Linux)",
    "Rocky Linux",
    "EndeavourOS",
    "AlmaLinux",
    "NixOS",
    "ShastraOS",
    "Asahi Linux",
    "Zorin OS",
    "Void Linux",
    "Nobara",
    "Steam Deck",
    "Ublue",
    "CentOS",
    "CachyOS"
];

function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
}

export default class WackShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const settingsSignalIds = [];

        const shellSettings = new Gio.Settings({ schema: 'org.gnome.shell' });
        let bmsSettings = null;
        let bmsBlurSig = 0;

        window.set_default_size(700, 800);

        // =====================================================================
        // -- PAGE 1: HOME PAGE (WACK Lockscreen Style) -----------------------
        // =====================================================================
        const homePage = new Adw.PreferencesPage({
            title: 'Home',
            icon_name: 'go-home-symbolic',
        });

        const homeGroup = new Adw.PreferencesGroup();
        const homeBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            spacing: 8,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 24,
            margin_end: 24,
        });

        const icon = new Gtk.Image({
            icon_name: 'utilities-system-monitor-symbolic',
            pixel_size: 128,
            halign: Gtk.Align.CENTER,
        });
        homeBox.append(icon);

        const titleLabel = new Gtk.Label({
            label: this.metadata.name,
            css_classes: ['title-1'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            wrap: true,
            hexpand: true,
        });
        homeBox.append(titleLabel);

        const descriptionLabel = new Gtk.Label({
            label: this.metadata.description,
            css_classes: ['dim-label'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            wrap: true,
            max_width_chars: 60,
            hexpand: true,
        });
        homeBox.append(descriptionLabel);

        let versionName = this.metadata['version-name'] || this.metadata.version || '';
        if (!versionName && this.dir) {
            try {
                const file = this.dir.get_child('metadata.json');
                const [, contents] = file.load_contents(null);
                const decoder = new TextDecoder('utf-8');
                const parsedMetadata = JSON.parse(decoder.decode(contents));
                versionName = parsedMetadata['version-name'] || parsedMetadata.version || '';
            } catch (e) {
                console.error('Failed to parse metadata.json:', e);
            }
        }

        versionName = String(versionName);

        const versionLabel = versionName
            ? (versionName.startsWith('v') ? versionName : `v${versionName}`)
            : 'v1.0.0';

        const versionButton = new Gtk.Button({
            label: versionLabel,
            css_classes: ['app-version', 'text-button', 'pill'],
            halign: Gtk.Align.CENTER,
            margin_top: 24,
        });
        homeBox.append(versionButton);

        homeGroup.add(homeBox);
        homePage.add(homeGroup);

        // Resources Group (GitHub link)
        const resourcesGroup = new Adw.PreferencesGroup({ title: 'Resources' });

        const repoRow = new Adw.ActionRow({
            title: 'Extension Repo',
            subtitle: this.metadata.url ? this.metadata.url.replace('https://', '') : 'github.com/rinzler69-wastaken/wack-shell',
        });

        const githubIcon = new Gtk.Image({
            icon_name: 'system-software-install-symbolic',
            pixel_size: 32,
            valign: Gtk.Align.CENTER,
        });
        repoRow.add_prefix(githubIcon);

        const openBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: 'Open on GitHub',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        openBtn.connect('clicked', () => {
            if (this.metadata.url) {
                Gtk.show_uri(window, this.metadata.url, GLib.CURRENT_TIME);
            }
        });
        repoRow.add_suffix(openBtn);
        resourcesGroup.add(repoRow);

        // Support Group
        const supportGroup = new Adw.PreferencesGroup({
            title: 'Enjoying this extension?',
            description: 'Consider supporting its development!',
        });

        let donations = this.metadata.donations;
        if (!donations && this.dir) {
            try {
                const file = this.dir.get_child('metadata.json');
                const [, contents] = file.load_contents(null);
                const decoder = new TextDecoder('utf-8');
                donations = JSON.parse(decoder.decode(contents)).donations;
            } catch (e) {
                console.error('Failed to parse metadata.json:', e);
            }
        }
        donations = donations || {
            paypal: 'ArtFazil',
            kofi: 'mikerinzler69',
            custom: 'https://saweria.co/rinzler69'
        };

        const kofiRow = new Adw.ActionRow({
            title: 'Ko-fi',
            subtitle: `ko-fi.com/${donations.kofi}`,
        });
        const kofiIcon = new Gtk.Image({
            icon_name: 'emblem-favorite-symbolic',
            pixel_size: 32,
            valign: Gtk.Align.CENTER,
        });
        kofiRow.add_prefix(kofiIcon);
        const kofiBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: 'Open Ko-fi',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        kofiBtn.connect('clicked', () => {
            Gtk.show_uri(window, `https://ko-fi.com/${donations.kofi}`, GLib.CURRENT_TIME);
        });
        kofiRow.add_suffix(kofiBtn);
        supportGroup.add(kofiRow);

        const saweriaRow = new Adw.ActionRow({
            title: 'Saweria',
            subtitle: donations.custom.replace('https://', ''),
        });
        const saweriaIcon = new Gtk.Image({
            icon_name: 'emblem-favorite-symbolic',
            pixel_size: 32,
            valign: Gtk.Align.CENTER,
        });
        saweriaRow.add_prefix(saweriaIcon);
        const saweriaBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: 'Open Saweria',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        saweriaBtn.connect('clicked', () => {
            Gtk.show_uri(window, donations.custom, GLib.CURRENT_TIME);
        });
        saweriaRow.add_suffix(saweriaBtn);
        supportGroup.add(saweriaRow);
        homePage.add(supportGroup);
        homePage.add(resourcesGroup);

        window.add(homePage);

        // =====================================================================
        // -- PAGE 2: PANEL CONFIGURATION --------------------------------------
        // =====================================================================
        const generalPage = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-system-symbolic',
        });

        // Group 2.1: Panel Objects
        const visibilityGroup = new Adw.PreferencesGroup({
            title: 'Panel Objects',
        });

        visibilityGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-logo-menu',
            'Show Logo Menu Button',
            'Display the logo menu button at the far left'
        ));

        visibilityGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-app-menu',
            'Show App Menu Button',
            'Display the focused application name next to the logo'
        ));

        const coloredAppIconRow = this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'colored-app-menu-icon',
            'Colored App Menu Icon',
            'Display the application icon in color instead of monochrome'
        );
        visibilityGroup.add(coloredAppIconRow);

        const updateColoredAppIconSensitivity = () => {
            coloredAppIconRow.sensitive = settings.get_boolean('show-app-menu');
        };
        const showAppMenuSig = settings.connect('changed::show-app-menu', updateColoredAppIconSensitivity);
        settingsSignalIds.push(showAppMenuSig);
        updateColoredAppIconSensitivity();

        visibilityGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-workspace-widget',
            'Show Workspace Widget',
            'Display separate workspace indicators / Activities label widget next to the logo'
        ));

        // 2. Workspace Widget Type Row
        const widgetTypeRow = new Adw.ActionRow({
            title: 'Workspace Widget Type',
        });
        visibilityGroup.add(widgetTypeRow);

        const widgetTypeBox = new Gtk.Box({
            valign: Gtk.Align.CENTER,
        });

        const widgetLinkedBox = new Gtk.Box({ css_classes: ['linked'] });
        const btnDots = new Gtk.ToggleButton({ label: 'Dots' });
        const btnLabel = new Gtk.ToggleButton({ label: 'Label', group: btnDots });
        widgetLinkedBox.append(btnDots);
        widgetLinkedBox.append(btnLabel);

        const widgetDropdown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: Gtk.StringList.new(['Dots', 'Label'])
        });

        widgetTypeBox.append(widgetLinkedBox);
        widgetTypeBox.append(widgetDropdown);
        widgetTypeRow.add_suffix(widgetTypeBox);

        const WIDGET_DESCRIPTIONS = [
            'Show vanilla GNOME dots for workspaces',
            'Show the legacy "Activities" label'
        ];

        let selfChangeWidgetType = false;
        const syncWidgetTypeFromSettings = () => {
            if (selfChangeWidgetType) return;
            const val = settings.get_int('workspace-widget-type');
            const index = clamp(val, 0, 1);

            if (index === 0) btnDots.active = true;
            else btnLabel.active = true;

            widgetDropdown.selected = index;
            widgetTypeRow.subtitle = WIDGET_DESCRIPTIONS[index];
            updateWorkspaceWidgetSensitivity();
        };

        const updateWidgetTypeSetting = (index) => {
            const val = index;
            if (settings.get_int('workspace-widget-type') !== val) {
                selfChangeWidgetType = true;
                settings.set_int('workspace-widget-type', val);
                selfChangeWidgetType = false;
            }
            widgetTypeRow.subtitle = WIDGET_DESCRIPTIONS[index];
            updateWorkspaceWidgetSensitivity();
        };

        btnDots.connect('toggled', () => { if (btnDots.active) updateWidgetTypeSetting(0); });
        btnLabel.connect('toggled', () => { if (btnLabel.active) updateWidgetTypeSetting(1); });

        widgetDropdown.connect('notify::selected', () => {
            updateWidgetTypeSetting(widgetDropdown.selected);
        });

        widgetDropdown.visible = false;
        widgetLinkedBox.visible = true;

        const widgetCond = Adw.BreakpointCondition.parse('max-width: 450px');
        const widgetBreakpoint = new Adw.Breakpoint({ condition: widgetCond });
        widgetBreakpoint.add_setter(widgetLinkedBox, 'visible', false);
        widgetBreakpoint.add_setter(widgetDropdown, 'visible', true);
        window.add_breakpoint(widgetBreakpoint);

        const widgetTypeSig = settings.connect('changed::workspace-widget-type', syncWidgetTypeFromSettings);
        settingsSignalIds.push(widgetTypeSig);

        // 3. Show Workspace Number Row
        const showWorkspaceNumberRow = this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-workspace-number',
            'Show Workspace Number',
            'Display workspace number next to the Activities label (e.g. Activities • 1)'
        );
        visibilityGroup.add(showWorkspaceNumberRow);

        const updateWorkspaceWidgetSensitivity = () => {
            const active = settings.get_boolean('show-workspace-widget');
            widgetTypeRow.sensitive = active;
            showWorkspaceNumberRow.sensitive = active && (settings.get_int('workspace-widget-type') === 1);
        };

        const workspaceWidgetSig = settings.connect('changed::show-workspace-widget', updateWorkspaceWidgetSensitivity);
        settingsSignalIds.push(workspaceWidgetSig);

        syncWidgetTypeFromSettings();
        updateWorkspaceWidgetSensitivity();

        generalPage.add(visibilityGroup);

        // Group 2.2: Interactive Actions
        const actionsGroup = new Adw.PreferencesGroup({
            title: 'Interactive Actions',
        });

        actionsGroup.add(this._buildComboRowInt(
            settings,
            settingsSignalIds,
            'logo-click-action',
            'Logo Left Click Action',
            'Action to trigger when left-clicking the logo button',
            ['Open Menu', 'Toggle Overview']
        ));

        actionsGroup.add(this._buildComboRowInt(
            settings,
            settingsSignalIds,
            'logo-middle-click-action',
            'Logo Middle Click Action',
            'Action to trigger when middle-clicking the logo button',
            ['Open Menu', 'Toggle Overview']
        ));

        actionsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'desktop-scroll',
            'Scroll to Switch Workspaces',
            'Switch workspaces by scrolling over the logo button'
        ));

        generalPage.add(actionsGroup);



        // Group 2.2.6: Vibrancy (panel blur + macOS-style transparency)
        const vibrancyGroup = new Adw.PreferencesGroup({
            title: 'Vibrancy',
        });

        const vibrancyRow = new Adw.SwitchRow({
            title: 'Enable/Disable Vibrancy',
            subtitle: 'Apply a wallpaper-aware, blur-driven frosted glass effect to the panel'
        });
        vibrancyGroup.add(vibrancyRow);

        let selfChangeVibrancy = false;
        const syncVibrancyRow = () => {
            if (selfChangeVibrancy) return;
            vibrancyRow.active = settings.get_boolean('enable-vibrancy');
        };

        vibrancyRow.connect('notify::active', () => {
            if (settings.get_boolean('enable-vibrancy') !== vibrancyRow.active) {
                selfChangeVibrancy = true;
                settings.set_boolean('enable-vibrancy', vibrancyRow.active);
                selfChangeVibrancy = false;
            }
        });

        const enableSig = settings.connect('changed::enable-vibrancy', syncVibrancyRow);
        settingsSignalIds.push(enableSig);
        syncVibrancyRow();

        // 2. Blur Mode Row
        const blurModeRow = new Adw.ActionRow({
            title: 'Gradient Mode',
        });
        vibrancyGroup.add(blurModeRow);

        const blurModeBox = new Gtk.Box({
            valign: Gtk.Align.CENTER,
        });

        const linkedBox = new Gtk.Box({ css_classes: ['linked'] });
        const btnAuto = new Gtk.ToggleButton({ label: 'Auto' });
        const btnLinear = new Gtk.ToggleButton({ label: 'Linear', group: btnAuto });
        const btnLenient = new Gtk.ToggleButton({ label: 'Lenient', group: btnAuto });
        linkedBox.append(btnAuto);
        linkedBox.append(btnLinear);
        linkedBox.append(btnLenient);

        const dropdown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: Gtk.StringList.new(['Auto', 'Linear', 'Lenient'])
        });

        blurModeBox.append(linkedBox);
        blurModeBox.append(dropdown);
        blurModeRow.add_suffix(blurModeBox);

        const BLUR_DESCRIPTIONS = [
            'Dynamically determines the optimal gradient mode based on the active wallpaper',
            'Tighter blur radius, best for wallpapers with simpler gradients',
            'Looser blur radius, optimised for wallpapers with multi-stop gradients'
        ];

        let selfChangeBlur = false;
        const syncBlurFromSettings = () => {
            if (selfChangeBlur) return;
            const val = settings.get_int('vibrancy-blur-mode');
            let index = 0; // default to Auto
            if (val === 1) index = 1;
            else if (val === 2) index = 2;

            if (index === 0) btnAuto.active = true;
            else if (index === 1) btnLinear.active = true;
            else btnLenient.active = true;

            dropdown.selected = index;
            blurModeRow.subtitle = BLUR_DESCRIPTIONS[index];
        };

        const updateBlurSetting = (index) => {
            let val = 3; // default to Auto
            if (index === 1) val = 1;
            else if (index === 2) val = 2;

            if (settings.get_int('vibrancy-blur-mode') !== val) {
                selfChangeBlur = true;
                settings.set_int('vibrancy-blur-mode', val);
                selfChangeBlur = false;
            }
            blurModeRow.subtitle = BLUR_DESCRIPTIONS[index];
        };

        btnAuto.connect('toggled', () => { if (btnAuto.active) updateBlurSetting(0); });
        btnLinear.connect('toggled', () => { if (btnLinear.active) updateBlurSetting(1); });
        btnLenient.connect('toggled', () => { if (btnLenient.active) updateBlurSetting(2); });

        dropdown.connect('notify::selected', () => {
            updateBlurSetting(dropdown.selected);
        });

        dropdown.visible = false;
        linkedBox.visible = true;

        const cond = Adw.BreakpointCondition.parse('max-width: 450px');
        const breakpoint = new Adw.Breakpoint({ condition: cond });
        breakpoint.add_setter(linkedBox, 'visible', false);
        breakpoint.add_setter(dropdown, 'visible', true);
        window.add_breakpoint(breakpoint);

        const blurSig = settings.connect('changed::vibrancy-blur-mode', syncBlurFromSettings);
        settingsSignalIds.push(blurSig);
        syncBlurFromSettings();

        // 3. Always Light Panel Row
        const alwaysLightRow = new Adw.SwitchRow({
            title: 'Always Light Panel',
            subtitle: 'Forces light panel style in light mode',
        });
        vibrancyGroup.add(alwaysLightRow);

        let selfChangeStyle = false;
        const syncStyleRows = () => {
            if (selfChangeStyle) return;
            let val = settings.get_int('vibrancy-style');
            if (val === 0) {
                settings.set_int('vibrancy-style', 1);
                val = 1;
            }
            alwaysLightRow.active = (val === 2);
        };

        alwaysLightRow.connect('notify::active', () => {
            if (selfChangeStyle) return;
            selfChangeStyle = true;
            settings.set_int('vibrancy-style', alwaysLightRow.active ? 2 : 1);
            selfChangeStyle = false;
        });

        const styleSig = settings.connect('changed::vibrancy-style', syncStyleRows);
        settingsSignalIds.push(styleSig);

        const initBmsSettings = () => {
            if (bmsSettings) return;
            try {
                bmsSettings = new Gio.Settings({
                    schema: 'org.gnome.shell.extensions.blur-my-shell.panel',
                });
            } catch (e) {
                try {
                    const paths = [
                        GLib.get_home_dir() + '/.local/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas',
                        '/usr/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas',
                        '/usr/local/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas'
                    ];
                    for (const path of paths) {
                        const file = Gio.File.new_for_path(path);
                        if (file.query_exists(null)) {
                            const source = Gio.SettingsSchemaSource.new_from_directory(
                                path,
                                Gio.SettingsSchemaSource.get_default(),
                                false
                            );
                            const schema = source.lookup('org.gnome.shell.extensions.blur-my-shell.panel', true);
                            if (schema) {
                                bmsSettings = new Gio.Settings({ settings_schema: schema });
                                break;
                            }
                        }
                    }
                } catch (err) {
                    bmsSettings = null;
                }
            }

            if (bmsSettings && !bmsBlurSig) {
                bmsBlurSig = bmsSettings.connect('changed::blur', updateVibrancySensitivity);
            }
        };

        const bmsHasPanelBlur = () => {
            try {
                const enabledExts = shellSettings.get_strv('enabled-extensions');
                if (!enabledExts.includes('blur-my-shell@aunetx'))
                    return false;
                initBmsSettings();
                return bmsSettings ? bmsSettings.get_boolean('blur') : false;
            } catch {
                return false;
            }
        };

        const updateVibrancySensitivity = () => {
            const bmsConflict = bmsHasPanelBlur();
            if (bmsConflict) {
                vibrancyGroup.sensitive = false;
                vibrancyGroup.title = 'Vibrancy - BMS Panel Blur is enabled, disable it to use Vibrancy.';
                vibrancyRow.subtitle = 'Disabled because Blur My Shell\'s panel blur is active';
            } else {
                vibrancyGroup.sensitive = true;
                vibrancyGroup.title = 'Vibrancy';
                vibrancyRow.subtitle = 'Apply a dynamic, wallpaper-aware frosted glass effect to the panel';
                const active = settings.get_boolean('enable-vibrancy');
                blurModeRow.sensitive = active;
                alwaysLightRow.sensitive = active;
            }
        };

        vibrancyRow.connect('notify::active', updateVibrancySensitivity);

        const updateSensSig = settings.connect('changed::enable-vibrancy', updateVibrancySensitivity);
        settingsSignalIds.push(updateSensSig);

        const shellExtSig = shellSettings.connect('changed::enabled-extensions', () => {
            updateVibrancySensitivity();
        });

        // Initialize bms settings if BMS is active
        initBmsSettings();

        syncStyleRows();
        updateVibrancySensitivity();

        generalPage.add(vibrancyGroup);

        // Group 2.3: Panel Proximity
        const proximityGroup = new Adw.PreferencesGroup({
            title: 'Proximity',
        });

        const buildColorRow = (key, title) => {
            const row = new Adw.ActionRow({ title });
            const button = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
            button.set_use_alpha(true);

            // Set initial color
            const rgba = new Gdk.RGBA();
            rgba.parse(settings.get_string(key));
            button.set_rgba(rgba);

            button.connect('color-set', () => {
                settings.set_string(key, button.get_rgba().to_string());
            });

            const sigId = settings.connect(`changed::${key}`, () => {
                const newRgba = new Gdk.RGBA();
                newRgba.parse(settings.get_string(key));
                button.set_rgba(newRgba);
            });
            settingsSignalIds.push(sigId);

            row.add_suffix(button);
            row.activatable_widget = button;
            return row;
        };

        proximityGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'enable-panel-proximity',
            'Enable/Disable Proximity',
            'Automatically switch panel opacity/color when windows are maximised or close to the panel.'
        ));

        // Dark Mode Colors Expander
        const darkColorsRow = new Adw.ExpanderRow({ title: 'Dark Mode Colors' });
        darkColorsRow.add_row(buildColorRow('dark-bg-color', 'Background Color'));
        darkColorsRow.add_row(buildColorRow('dark-fg-color', 'Foreground Color (Text/Icons)'));
        proximityGroup.add(darkColorsRow);

        // Light Mode Colors Expander
        const lightColorsRow = new Adw.ExpanderRow({ title: 'Light Mode Colors' });
        lightColorsRow.add_row(buildColorRow('light-bg-color', 'Background Color'));
        lightColorsRow.add_row(buildColorRow('light-fg-color', 'Foreground Color (Text/Icons)'));
        proximityGroup.add(lightColorsRow);

        generalPage.add(proximityGroup);

        window.add(generalPage);

        // =====================================================================
        // -- PAGE 3: LOGO & MENU CUSTOMIZATION --------------------------------
        // =====================================================================
        const logoPage = new Adw.PreferencesPage({
            title: 'Logo Menu',
            icon_name: 'image-x-generic-symbolic',
        });

        const logoOptionsGroup = new Adw.PreferencesGroup({
            title: 'Icon Options',
        });

        logoOptionsGroup.add(this._buildComboRowInt(
            settings,
            settingsSignalIds,
            'logo-icon-image',
            'Distro Logo Image',
            'Select pre-defined distro logo',
            DISTRO_LOGOS
        ));

        logoOptionsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'symbolic-logo',
            'Use Symbolic Icon',
            'Toggle symbolic (monochrome) vs colored style'
        ));

        logoOptionsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'use-custom-logo',
            'Use Custom Logo File',
            'Override the pre-defined icon with a custom SVG or PNG image'
        ));

        // Custom logo path row
        const customLogoPathRow = new Adw.EntryRow({
            title: 'Custom Logo Path',
            text: settings.get_string('custom-logo-path') || '',
        });
        customLogoPathRow.connect('changed', () => {
            if (settings.get_string('custom-logo-path') !== customLogoPathRow.text) {
                settings.set_string('custom-logo-path', customLogoPathRow.text);
            }
        });
        const customLogoPathSig = settings.connect('changed::custom-logo-path', () => {
            if (customLogoPathRow.text !== settings.get_string('custom-logo-path')) {
                customLogoPathRow.text = settings.get_string('custom-logo-path') || '';
            }
        });
        settingsSignalIds.push(customLogoPathSig);
        logoOptionsGroup.add(customLogoPathRow);

        // Logo Icon Size
        const logoSizeRow = new Adw.ActionRow({
            title: 'Logo Icon Size',
            subtitle: 'Size of the logo icon in pixels',
        });
        const logoSizeSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 12,
                upper: 48,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('logo-icon-size'),
            }),
            valign: Gtk.Align.CENTER,
        });
        logoSizeSpin.connect('value-changed', () => {
            settings.set_int('logo-icon-size', logoSizeSpin.get_value_as_int());
        });
        const logoSizeSig = settings.connect('changed::logo-icon-size', () => {
            logoSizeSpin.value = settings.get_int('logo-icon-size');
        });
        settingsSignalIds.push(logoSizeSig);
        logoSizeRow.add_suffix(logoSizeSpin);
        logoSizeRow.activatable_widget = logoSizeSpin;
        logoOptionsGroup.add(logoSizeRow);

        logoPage.add(logoOptionsGroup);

        // Label options
        const labelGroup = new Adw.PreferencesGroup({
            title: 'Label Options',
        });

        labelGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-logo-label',
            'Show Custom Label',
            'Show a text label next to the logo icon'
        ));

        const labelTextRow = new Adw.EntryRow({
            title: 'Label Text',
            text: settings.get_string('logo-label-text') || '',
        });
        labelTextRow.connect('changed', () => {
            if (settings.get_string('logo-label-text') !== labelTextRow.text) {
                settings.set_string('logo-label-text', labelTextRow.text);
            }
        });
        const labelTextSig = settings.connect('changed::logo-label-text', () => {
            if (labelTextRow.text !== settings.get_string('logo-label-text')) {
                labelTextRow.text = settings.get_string('logo-label-text') || '';
            }
        });
        settingsSignalIds.push(labelTextSig);
        labelGroup.add(labelTextRow);

        logoPage.add(labelGroup);

        const menuItemsGroup = new Adw.PreferencesGroup({
            title: 'Contents',
            description: 'Choose which options are displayed in the Logo Menu dropdown',
        });

        menuItemsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-power-options',
            'Show Power Options',
            'Display Sleep, Restart, and Shut Down options'
        ));

        menuItemsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'show-lockscreen',
            'Show Lock Screen',
            'Display the Lock Screen option'
        ));

        menuItemsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'hide-forcequit',
            'Hide Force Quit App Utility',
            'Remove Force Quit utility option'
        ));

        menuItemsGroup.add(this._buildSwitchRow(
            settings,
            settingsSignalIds,
            'hide-softwarecentre',
            'Hide Software Center Option',
            'Remove Software Center launcher option'
        ));
        logoPage.add(menuItemsGroup);

        const commandsGroup = new Adw.PreferencesGroup({
            title: 'Application Commands',
            description: 'Commands executed to open standard applications',
        });

        commandsGroup.add(this._buildEntryRow(
            settings,
            settingsSignalIds,
            'menu-button-terminal',
            'Terminal Application Command'
        ));

        commandsGroup.add(this._buildEntryRow(
            settings,
            settingsSignalIds,
            'menu-button-software-center',
            'Software Center Command'
        ));

        commandsGroup.add(this._buildEntryRow(
            settings,
            settingsSignalIds,
            'menu-button-system-monitor',
            'System Monitor Command'
        ));

        logoPage.add(commandsGroup);

        // Group 3.5: Extras
        const extrasGroup = new Adw.PreferencesGroup({
            title: 'Extras',
        });

        // Cupertino About Pane status row
        const aboutPaneRow = new Adw.ActionRow({
            title: 'Cupertino About Pane',
            subtitle: 'Open a custom macOS-style "About This PC" dialog',
        });
        const aboutPaneStatusLabel = new Gtk.Label({
            label: 'Checking...',
            valign: Gtk.Align.CENTER,
        });
        aboutPaneRow.add_suffix(aboutPaneStatusLabel);

        const _checkAboutPane = () => {
            const home = GLib.get_home_dir();
            const paths = [
                '/usr/local/bin/aboutpane',
                `${home}/.local/bin/aboutpane`,
            ];
            return paths.some(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
        };

        if (_checkAboutPane()) {
            aboutPaneStatusLabel.label = 'Active';
            try {
                const provider = new Gtk.CssProvider();
                provider.load_from_data(`
                    label.success-pill {
                        background-color: #2ec27e;
                        color: white;
                        font-weight: bold;
                        padding: 2px 10px;
                        border-radius: 9999px;
                    }
                `);
                aboutPaneStatusLabel.get_style_context().add_provider(
                    provider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
                );
                aboutPaneStatusLabel.css_classes = ['success-pill'];
            } catch (e) {
                aboutPaneStatusLabel.css_classes = ['success', 'pill'];
            }
        } else {
            aboutPaneStatusLabel.label = 'Not installed';
            aboutPaneStatusLabel.css_classes = ['dim-label'];
            const installBtn = new Gtk.Button({
                icon_name: 'adw-external-link-symbolic',
                tooltip_text: 'Get Cupertino About Pane',
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            installBtn.connect('clicked', () => {
                Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/cupertino-aboutpane', GLib.CURRENT_TIME);
            });
            aboutPaneRow.add_suffix(installBtn);
        }

        extrasGroup.add(aboutPaneRow);
        logoPage.add(extrasGroup);
        window.add(logoPage);

        // Clean up connections on destroy (M5)
        window.connect('destroy', () => {
            for (const id of settingsSignalIds) {
                settings.disconnect(id);
            }
            settingsSignalIds.length = 0;
            shellSettings.disconnect(shellExtSig);
            if (bmsSettings && bmsBlurSig) {
                bmsSettings.disconnect(bmsBlurSig);
            }
        });
    }

    _buildSwitchRow(settings, signals, key, title, subtitle) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
        });

        const toggle = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean(key),
        });

        toggle.connect('notify::active', () => {
            if (settings.get_boolean(key) !== toggle.active) {
                settings.set_boolean(key, toggle.active);
            }
        });

        const sigId = settings.connect(`changed::${key}`, () => {
            if (toggle.active !== settings.get_boolean(key)) {
                toggle.active = settings.get_boolean(key);
            }
        });
        signals.push(sigId);

        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        return row;
    }

    _buildEntryRow(settings, signals, key, title) {
        const row = new Adw.EntryRow({
            title,
            text: settings.get_string(key) || '',
        });

        row.connect('changed', () => {
            if (settings.get_string(key) !== row.text) {
                settings.set_string(key, row.text);
            }
        });

        const sigId = settings.connect(`changed::${key}`, () => {
            if (row.text !== settings.get_string(key)) {
                row.text = settings.get_string(key) || '';
            }
        });
        signals.push(sigId);

        return row;
    }

    _buildComboRowInt(settings, signals, key, title, subtitle, options) {
        const model = new Gtk.StringList();
        for (const label of options) {
            model.append(label);
        }

        const row = new Adw.ComboRow({
            title,
            subtitle,
            model,
        });

        const syncFromSettings = () => {
            const val = settings.get_int(key);
            row.selected = clamp(val, 0, options.length - 1);
        };

        syncFromSettings();

        row.connect('notify::selected', () => {
            if (settings.get_int(key) !== row.selected) {
                settings.set_int(key, row.selected);
            }
        });

        const sigId = settings.connect(`changed::${key}`, syncFromSettings);
        signals.push(sigId);

        return row;
    }
}