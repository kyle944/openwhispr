# OpenWhispr local dictation latency and recovery

## Goal

Keep the installed `OpenWhispr Local.app` available in the background and make the local dictation path recover cleanly after a quit or accidental window switch. Reduce and measure the delay between stopping speech and automatic paste without weakening transcription cleanup.

## Acceptance criteria

- Only one active local-build bundle can be selected by the local bundle identifier.
- Relaunch restores the working local profile, models, hotkey, live preview, and automatic paste.
- Runtime evidence identifies the time spent in stream finalization, cleanup, and paste.
- The confirmed latency cause is fixed at its source and covered by a regression test.
- Focused tests and the full relevant test suite pass.
- A fresh packaged build is installed and verified on macOS with the exact local bundle identity.
- The branch is committed and pushed to its remote.

## Verifiers

- Inspect the packaged app's bundle id, signing identity, running process path, and loaded local models.
- Run focused pipeline and preview tests.
- Run the repository test suite and production renderer build.
- Perform a fresh end-to-end dictation/paste timing check in a neutral text target.
