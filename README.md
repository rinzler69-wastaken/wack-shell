# WACK Shell

A GNOME Shell panel extension bringing macOS-inspired panel elements to your desktop — a logo menu button, focused app menu, workspace indicators, and proximity-aware panel coloring.


This is a part of the WACK project (WACK Ain't Cupertino, Kid), a collection of tweaks aimed at bringing a refined, macOS-inspired aesthetic to the GNOME desktop.

## Features

- **Logo Button & System Menu** <br>
  Adds a customizable logo button to the far left of the panel — pick from 34 pre-defined distro icons (Apple, Fedora, Arch, and more), use symbolic or colored variants, or supply your own SVG/PNG. Add an optional text label beside it. Clicking opens a macOS-style system menu with quick access to About My System, System Settings, App Grid, Software Center, System Monitor, Terminal, Extensions, Force Quit App, and optionally power controls (Sleep, Restart, Shut Down, Log Out, Lock Screen). Each launcher command is user-configurable, and individual menu items can be shown or hidden. Left- and middle-click actions are independently configurable: open the menu or toggle the Overview. <br><br>

- **App Menu** <br>
  Shows the focused application's name and icon next to the logo, macOS menu-bar style. Fades in and out smoothly on focus change and overview toggle. Icon can be displayed in symbolic or full color. <br><br>

- **Workspace Widget** <br>
  A separate widget placed next to the logo — choose between animated workspace dot indicators (à la GNOME 45 lock screen) or a classic Activities label. The label variant optionally appends the current workspace number (e.g. *Activities • 2*). Scroll over either widget to switch workspaces, with an optional workspace switcher HUD popup. <br><br>

- **Panel Proximity Coloring** <br>
  Dynamically recolors the panel when an application window comes within range of it — separate background and foreground colors for light and dark mode, auto-switching with the system color scheme. Clears automatically when the overview is open or the desktop is clear.

## Install / Update

```bash
git clone https://github.com/rinzler69-wastaken/wack-shell.git
cd wack-shell
make enable        # install + enable in one step
```

Or separately:

```bash
make install       # copy to ~/.local/share/gnome-shell/extensions/
gnome-extensions enable wack-shell@rinzler69-wastaken.github.com
```

Reload GNOME Shell after installing: `Alt+F2` → `r` on Xorg, or log out and back in on Wayland.

Running `make install` again is sufficient to update — it syncs the directory in place.

## Compatibility

Developed and tested on GNOME 46 and 49 (Fedora/Nobara). GNOME 47–48 are untested but should work fine. Open an issue if you run into something, or clone and contribute.

## About the WACK Project

WACK (WACK Ain't Cupertino, Kid) brings the best design patterns from macOS to the GNOME desktop — dock animations, traffic-light window controls, lockscreen layout, panel elements, and more — built entirely within what GNOME already gives you.

Other extensions in the suite:
- **[WACK Lockscreen Clock](https://extensions.gnome.org/extension/TODO)** — macOS Sonoma-style lockscreen clock
- **[Cupertino Dock Lite](https://github.com/rinzler69-wastaken/cupertino-dock-lite)** — macOS-inspired dock theming and bounce animations

## Credits

WACK Shell combines and builds upon the work of several talented extension authors. Their original projects are listed below — please consider starring and supporting them.

| Component | Original Extension | Author |
|---|---|---|
| Logo Menu Button | [Logo Menu](https://github.com/Aryan20/Logomenu) | [Aryan Kaushik](https://github.com/Aryan20) |
| Activities Button & Workspace Dots | [Logo Activities](https://github.com/howbea/logo-activities) | [Howbea](https://github.com/howbea) |
| App Menu Button | [App Menu is Back](https://github.com/fthx/appmenu-is-back) | [fthx](https://github.com/fthx) |
