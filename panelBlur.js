/**
 * panelBlur.js — WACK Shell Vibrancy panel blur
 *
 * Forked and pruned from Blur My Shell (GPL-3.0, @aunetx).
 * Only the dynamic-blur panel path is kept. No Dash-to-Panel, no static
 * blur, no BMS settings object, no multi-monitor-bar support.
 *
 * Lifecycle (enable/disable/show/hide) is driven by the Vibrancy system in
 * extension.js. Parameters (radius, brightness) are passed directly.
 */

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---------------------------------------------------------------------------
// Resolve blur effect class — gi://Blur (GNOME 46+) or gi://Shell fallback
// ---------------------------------------------------------------------------
let _BlurEffect, _BlurMode;
try {
    const Blur = (await import('gi://Blur')).default;
    _BlurEffect = Blur.BlurEffect;
    _BlurMode = Blur.BlurMode;
} catch {
    const Shell = (await import('gi://Shell')).default;
    _BlurEffect = Shell.BlurEffect;
    _BlurMode = Shell.BlurMode;
}

// ---------------------------------------------------------------------------
// Blur radius presets (unscaled; the effect scales by the HiDPI factor)
// ---------------------------------------------------------------------------
// BMS multiplies settings.sigma by 2 when passing to Shell.BlurEffect's radius.
// To match BMS's visual sigma of 300/150, our unscaled radii must be 600/300.
export const RADIUS_LINEAR = 900;
export const RADIUS_LENIENT = 300;

// ---------------------------------------------------------------------------
// WackBlurEffect — thin GObject subclass of Shell/Blur.BlurEffect.
// Tracks the display scale factor and keeps `radius` proportional.
// ---------------------------------------------------------------------------
const WackBlurEffect = GObject.registerClass(
    { GTypeName: 'WackShellPanelBlurEffect' },
    class WackBlurEffect extends _BlurEffect {
        constructor({ unscaled_radius, brightness }) {
            super({ mode: _BlurMode.BACKGROUND });
            this.brightness = brightness;

            this._themeCtx = St.ThemeContext.get_for_stage(global.stage);
            this._themeCtx.connectObject(
                'notify::scale-factor',
                () => { this.radius = this._unscaled * this._themeCtx.scale_factor; },
                this
            );

            // Setter triggers initial radius calculation
            this.unscaled_radius = unscaled_radius;
        }

        get unscaled_radius() { return this._unscaled; }
        set unscaled_radius(v) {
            this._unscaled = v;
            this.radius = v * this._themeCtx.scale_factor;
        }
    }
);

// ---------------------------------------------------------------------------
// PaintSignals — forces the blur effect to repaint on every actor paint cycle.
//
// Shell.BlurEffect does not repaint when shadows are rendered beneath it:
//   https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2857
// This hack (Level 1 in BMS) keeps the blur fresh without full compositor
// redraws. Ported verbatim from BMS's conveniences/paint_signals.js.
// ---------------------------------------------------------------------------
const EmitPaintSignal = GObject.registerClass({
    GTypeName: 'WackShellEmitPaintSignal',
    Signals: { 'update-blur': { param_types: [] } },
}, class EmitPaintSignal extends Clutter.Effect {
    vfunc_paint(node, paint_context, paint_flags) {
        this.emit('update-blur');
        super.vfunc_paint(node, paint_context, paint_flags);
    }
});

// ---------------------------------------------------------------------------
// PanelBlur — manages one dynamic blur background for Main.panel.
//
// Hierarchy (mirrors BMS dynamic blur path exactly):
//
//   panel_box  (Main.panel.get_parent())
//   ├── wack-panel-backgroundgroup  (Meta.BackgroundGroup, 0×0)
//   │   └── wack-panel-blurred-widget  (St.Widget + WackBlurEffect)
//   └── Main.panel  (unchanged)
//
// The background actor is positioned/sized to overlay the panel exactly via
// update_size(), which mirrors BMS's dynamic-blur update_size() verbatim.
// ---------------------------------------------------------------------------
export class PanelBlur {
    constructor() {
        this._bg = null;   // St.Widget (blur actor)
        this._bgGroup = null;   // Meta.BackgroundGroup (0×0 container)
        this._effect = null;   // WackBlurEffect
        this._paintEffect = null;   // EmitPaintSignal (repaint hack)
        this._sigs = [];     // [[object, signalId], ...]
        this._bindings = [];     // Property bindings
        this._enabled = false;
        this._sessionVisibilityTimeoutId = 0;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    enable(unscaled_radius, brightness) {
        if (this._enabled) return;

        const panel = Main.panel;
        const panel_box = panel.get_parent();   // mirrors BMS exactly

        if (!panel_box) {
            console.warn('[WACK Shell/PanelBlur] panel has no parent, cannot enable blur');
            return;
        }

        // 1. Wrapper group (0×0 so it doesn't affect layout)
        this._bgGroup = new Meta.BackgroundGroup({
            name: 'wack-panel-backgroundgroup',
            width: 0, height: 0,
        });

        // 2. Blur actor + effect
        this._bg = new St.Widget({ name: 'wack-panel-blurred-widget' });
        this._effect = new WackBlurEffect({ unscaled_radius, brightness });
        this._bg.add_effect(this._effect);

        // 3. Repaint hack (BMS hack level 1) — keeps blur fresh under shadows
        this._paintEffect = new EmitPaintSignal();
        this._bg.add_effect(this._paintEffect);
        let _repaintCounter = 0;
        this._paintEffect.connect('update-blur', () => {
            if (_repaintCounter === 0) {
                _repaintCounter = 2;
                this._effect.queue_repaint();
            } else {
                _repaintCounter--;
            }
        });

        // 4. Wire up the hierarchy
        this._bgGroup.insert_child_at_index(this._bg, 0);
        panel_box.insert_child_at_index(this._bgGroup, 0);

        // 5. Initial sizing
        this._updateSize(panel, panel_box);

        // 5b. Bind translation properties to keep the blur in sync with slide-down/up animations
        this._bindings = [
            panel.bind_property('translation-y', this._bgGroup, 'translation-y', GObject.BindingFlags.DEFAULT),
            panel.bind_property('translation-x', this._bgGroup, 'translation-x', GObject.BindingFlags.DEFAULT),
        ];

        // 6. Track geometry changes — mirrors BMS signal connections
        this._connect(panel, 'notify::position',
            () => this._updateSize(panel, panel_box));
        this._connect(panel_box, 'notify::size',
            () => this._updateSize(panel, panel_box));
        this._connect(panel_box, 'notify::position',
            () => this._updateSize(panel, panel_box));
        const ppb = panel_box.get_parent();
        if (ppb)
            this._connect(ppb, 'notify::position',
                () => this._updateSize(panel, panel_box));

        // 7. Hide in overview and lockscreen; show on desktop + Sonoma unlock fade
        //    Mirrors BMS update_visibility: !hasWindows == lockscreen/unlock-dialog
        const _updateSessionVisibility = () => {
            if (this._sessionVisibilityTimeoutId) {
                GLib.source_remove(this._sessionVisibilityTimeoutId);
                this._sessionVisibilityTimeoutId = 0;
            }
            this._sessionVisibilityTimeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._sessionVisibilityTimeoutId = 0;
                if (!Main.sessionMode.hasWindows) {
                    this.hideInstantly();
                } else {
                    if (!Main.overview.visible)
                        this.show();
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        this._connect(Main.sessionMode, 'updated', _updateSessionVisibility);
        this._connect(Main.overview, 'showing', () => this.hideInstantly());
        this._connect(Main.overview, 'hidden', () => {
            if (Main.sessionMode.hasWindows)
                this.show();
        });

        // Apply initial visibility state
        _updateSessionVisibility();

        this._enabled = true;
    }

    disable() {
        if (this._sessionVisibilityTimeoutId) {
            GLib.source_remove(this._sessionVisibilityTimeoutId);
            this._sessionVisibilityTimeoutId = 0;
        }
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];

        if (this._bindings) {
            for (const binding of this._bindings)
                binding.unbind();
            this._bindings = [];
        }

        if (this._bgGroup) {
            try { this._bgGroup.get_parent()?.remove_child(this._bgGroup); } catch { }
            this._bgGroup.destroy();
            this._bgGroup = null;
            this._bg = null;
            this._effect = null;
            this._paintEffect = null;
        }

        this._enabled = false;
    }

    /** Swap blur parameters at runtime (e.g. Linear ↔ Lenient). */
    updateParams(unscaled_radius, brightness) {
        if (!this._effect) return;
        this._effect.unscaled_radius = unscaled_radius;
        this._effect.brightness = brightness;
    }

    show() {
        if (!this._bgGroup) return;
        if (!this._bgGroup.visible) {
            this._bgGroup.opacity = 0;
            this._bgGroup.show();
        }
        this._bgGroup.ease({
            opacity: 255,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        if (!this._bgGroup) return;
        this._bgGroup.ease({
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._bgGroup && this._bgGroup.opacity === 0) {
                    this._bgGroup.hide();
                }
            }
        });
    }

    hideInstantly() {
        if (!this._bgGroup) return;
        this._bgGroup.remove_all_transitions();
        this._bgGroup.opacity = 0;
        this._bgGroup.hide();
    }

    get enabled() { return this._enabled; }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /**
     * Mirrors BMS's update_size() for the dynamic (non-static) blur path:
     *   background.x = panel.x
     *   background.y = panel.y
     *   background.width  = panel.width
     *   background.height = panel.height
     */
    _updateSize(panel, _panel_box) {
        if (!this._bg) return;
        this._bg.x = panel.x;
        this._bg.y = panel.y;
        this._bg.width = panel.width;
        this._bg.height = panel.height;
    }

    _connect(obj, signal, fn) {
        this._sigs.push([obj, obj.connect(signal, fn)]);
    }
}
