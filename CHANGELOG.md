# Changelog

## 1.2.0

- Library page: every clip you've made, grouped by film or season, with hover previews and details (length,
  resolution, frame rate, codec, size). Select clips from several films and export them into one folder (copy or move).
- AI search can be paused: it stops and shows everything found so far, and Continue picks up where it stopped.
- Interface size setting (Compact, Small, Normal, Large) and Ctrl + plus / minus.
- Polished app icon, now also in the title bar and on the About page.

## 1.1.0

- Automatic updates from GitHub Releases: downloads in the background (only the changed parts), installs on restart.
- Videos start splitting as soon as they're added (can be turned off).
- Right-click any video in Explorer: Send to > ScenePack.
- Keeps working in the tray when the window is closed; progress on the taskbar button and in the window title.
- Instant export mode: no re-encoding, many times faster, original quality.
- Faster scene scanning using the graphics card to decode video.
- First-run welcome guide, keyboard shortcuts, and simpler Settings with an advanced section.
- The engine restarts itself if it ever stops unexpectedly.
- Follows the Windows "reduce animations" setting.

## 1.0.0

First public release.

- Electron app with a Python backend; dark and light themes, styled with Tailwind CSS.
- Split whole films into one clip per scene, frame accurate, with the start time in every file name.
- TV shows: recognise seasons and episodes, choose seasons and clips per episode, skip intros and credits.
- AI search: find scenes from a description or reference pictures with a local CLIP model; "More like this".
- Graphics card support for saving clips (NVENC, AMF, Quick Sync) and for AI search (DirectML).
- Background queue: videos at once, Light/Balanced/Full speed, pause and resume, picks up after closing.
- Settings for format, quality, maximum resolution, audio, file name pattern, trimming and notifications.
- Windows installer with FFmpeg included; GitHub workflow builds it on every push and releases on version tags.
