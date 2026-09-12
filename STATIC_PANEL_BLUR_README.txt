Wack Shell — Static Panel Blur

This bundle replaces the live Shell.BlurEffect panel blur with a cached,
preprocessed wallpaper strip.

Files to copy into the Wack Shell extension:
  vibrancyManager.js
  wallpaperSampler.js
  wallpaperUtils.js
  alphaCache.js

Then delete the old:
  panelBlur.js

No colorUtils.js or lockscreen constants are required by the static panel blur
support files in this bundle.

The panel strip is generated only when needed (startup, wallpaper/background
settings changes, vibrancy blur/style changes, color scheme changes, and
monitor changes). The generated PNG is cached under GLib.get_user_cache_dir()
and consumed by St as a CSS background image afterward.

Validation performed:
  node --check vibrancyManager.js
  node --check wallpaperSampler.js
  node --check wallpaperUtils.js
  node --check alphaCache.js

Runtime HiDPI/fractional-scale validation still needs to be done inside GNOME
Shell/Looking Glass.
