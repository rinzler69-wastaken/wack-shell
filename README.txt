WACK Shell - Static Panel Blur v21

v21 keeps the v20 static wallpaper/sampling architecture and fixes proximity
compositing: the vibrancy overlay surface is now kept mapped and transparent
when no Ventura tint is active, because the proximity-color actor is its child.
This prevents the parent surface from hiding the proximity layer in Big Sur or
other modes where the Ventura tint is disabled.

Proximity color remains sourced from the existing WACK Shell GSettings keys.
The blurred wallpaper stays visible underneath while the configured proximity
color crossfades above it.
