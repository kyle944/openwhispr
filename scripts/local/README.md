# Kyle's local OpenWhispr build

This folder holds the two pieces that keep a customized OpenWhispr working on
Kyle's Mac without anyone having to think about it.

## Why it exists

The `local-build` branch carries Kyle's changes on top of upstream. They are
compiled into `/Applications/OpenWhispr Local.app`, which ships under its own
bundle id (`com.kylecooper.openwhispr.local`) and deliberately has no
`app-update.yml`, so upstream's auto-updater cannot reach it.

On 2026-08-27 the stock app — a second copy installed as
`OpenWhispr Official 1.8.3.app` — was the one wired into Login Items. It started
at every boot, updated itself to 1.9.1, and grabbed the dictation hotkey, which
made it look as though a month of customization had been wiped out. Nothing was
lost; the wrong app was simply running. The fix was to point startup at the
local build and to stop letting upstream releases arrive as a surprise.

## sync-local-build.sh

Run weekly by `com.kylecooper.openwhispr-local-sync`. It fetches upstream,
rebases `local-build` onto the newest release in a throwaway worktree, then runs
typecheck, the full test suite, and a packaged build. Only when all of that
passes does it swap `/Applications/OpenWhispr Local.app`, keeping the previous
bundle beside it as `.previous` and rolling back if the copy fails.

Every failure path exits before touching the installed app, so a broken upstream
release or a conflict with Kyle's changes leaves the working app exactly where it
was and posts a notification saying the update was skipped. A conflict is the one
case that needs a person: the log names it, and the next run retries.

Progress goes to `~/Library/Logs/OpenWhispr Local/sync.log`.

Run it by hand any time:

    "$HOME/Library/Application Support/OpenWhispr Local/sync-local-build.sh"

## com.kylecooper.openwhispr-local-sync.plist

The weekly schedule, Sundays at 04:00. Copy it to `~/Library/LaunchAgents/` and
load it with `launchctl bootstrap gui/$(id -u)`. A run missed because the Mac was
asleep fires at the next wake.
