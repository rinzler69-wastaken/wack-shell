WACK Shell v1a

Architectural rework: panelStateManager.js centralizes vibrancy, proximity, suppression, and transitions into one panel-state model.

Fixes:
- Panel visual suppression is now independent of proximity enablement: Overview and lockscreen suppression signals remain active even when panel proximity is disabled.
- Cold boot reassertion no longer incorrectly requires sessionMode.hasWindows to be false; vibrancy is restored during normal user sessions when proximity is disabled.
- Disabling proximity now explicitly reasserts vibrancy when visual suppression is not active.
- Manager visual suppression now uses its own generation token. A stale Overview/lockscreen fade completion can no longer hide a newly-restored vibrancy/proximity layer after returning to a workspace.
- No artificial delays, no per-workspace state, and no changes to proximity geometry/detection.

- Lock-screen restoration now tracks the screen shield directly; proximity is reasserted when the shield actually becomes inactive instead of relying only on session-mode timing.

v1g — snapshot-native panel blending:
- Ventura's adaptive white blend is now composited into the static wallpaper snapshot during sampling, rather than rendered as a separate white panel overlay.
- The standard/non-Ventura snapshot receives a very subtle black blend (5%) in the same processing stage, restoring the slight darkening previously supplied by the live-blur presentation.
- Ventura snapshots are cached separately with a `-ventura.png` suffix; the blend variant and alpha participate in the cache key.
- The existing Ventura white-blend alpha calculation remains the authority for its blend strength.


v1g: Based on v1f. Keeps v1b state architecture and moves Ventura white / standard dark blend to the final post-scale pixel-processing stage so the treatment is baked into the cached PNG itself. Cache key bumped to v11 to force regeneration.
