/*
The MIT License (MIT)
Copyright (c) 2023 Aryan20
Copyright (c) 2013 otto.allmendinger@gmail.com
*/

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function setCursor(cursor) {
    global.display.set_cursor(cursor);
}

const Capture = GObject.registerClass({
    GTypeName: 'WackShellCapture',
    Signals: {
        'captured-event': {
            param_types: [GObject.TYPE_BOXED]
        },
        'stop': {
            param_types: []
        }
    }
}, class Capture extends GObject.Object {
    _init() {
        super._init();

        this._mouseDown = false;
        this.monitor = Main.layoutManager.focusMonitor;

        this._areaSelection = new St.Widget({
            name: 'area-selection',
            style_class: 'area-selection',
            visible: true,
            reactive: true,
            x: -10,
            y: -10,
        });

        Main.uiGroup.add_child(this._areaSelection);
        this._grab = Main.pushModal(this._areaSelection);

        if (this._grab) {
            this._areaSelection.connectObject(
                'captured-event', (actor, event) => this._onCaptureEvent(actor, event),
                this
            );
            setCursor(Meta.Cursor.CROSSHAIR);
        }
    }

    _setDefaultCursor() {
        setCursor(Meta.Cursor.DEFAULT);
    }

    _onCaptureEvent(actor, event) {
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.destroy();
            }
        }
        this.emit('captured-event', event);
    }

    destroy() {
        if (this._areaSelection) {
            this._areaSelection.disconnectObject(this);
            this._setDefaultCursor();
            Main.uiGroup.remove_child(this._areaSelection);
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
            this._areaSelection.destroy();
            this._areaSelection = null;
        }
        this.monitor = null;
        this.emit('stop');
    }
});

const SelectionWindow = GObject.registerClass({
    GTypeName: 'WackShellSelectionWindow',
    Signals: {
        'stop': {
            param_types: []
        }
    }
}, class SelectionWindow extends GObject.Object {
    _init() {
        super._init();

        this._windows = global.get_window_actors();
        this._capture = new Capture();
        
        this._capture.connectObject(
            'captured-event', (capture, event) => this._onEvent(capture, event),
            'stop', () => this.destroy(),
            this
        );
    }

    _onEvent(capture, event) {
        let type = event.type();
        let [x, y] = global.get_pointer();

        this._selectedWindow = _selectWindow(this._windows, x, y);

        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._capture.destroy();
            } else if (this._selectedWindow) {
                this._selectedWindow.get_meta_window().kill();
                this._capture.destroy();
            }
        }
    }

    destroy() {
        if (this._capture) {
            this._capture.disconnectObject(this);
            this._capture.destroy();
            this._capture = null;
        }
        this._windows = null;
        this._selectedWindow = null;
        this.emit('stop');
    }
});

function _selectWindow(windows, x, y) {
    let filtered = windows.filter(win => {
        if (
            win !== undefined &&
            win.visible &&
            typeof win.get_meta_window === 'function'
        ) {
            let [w, h] = win.get_size();
            let [wx, wy] = win.get_position();

            return wx <= x && wy <= y && wx + w >= x && wy + h >= y;
        }
        return false;
    });

    filtered.sort((a, b) => {
        return a.get_meta_window().get_layer() <= b.get_meta_window().get_layer();
    });

    return filtered[0];
}

export { SelectionWindow };
