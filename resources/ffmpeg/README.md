# Bundled FFmpeg

The release process uses the pinned BtbN Windows x64 `lgpl-shared` build defined
in `scripts/fetch-ffmpeg.mjs`. The script verifies SHA-256 before extracting the
executables, shared libraries and upstream license into this directory.

The generated `bin/` directory is intentionally excluded from Git. Run:

```powershell
npm run fetch:ffmpeg
```

before development involving ugoira conversion or before packaging a release.
