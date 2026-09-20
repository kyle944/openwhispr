import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
let submitAfterPaste = CommandLine.arguments.contains("--submit")
let virtualKey: CGKeyCode = copyMode ? 0x08 : 0x09  // kVK_ANSI_C : kVK_ANSI_V

let targetPid: pid_t? = {
    guard let index = CommandLine.arguments.firstIndex(of: "--target-pid"),
          CommandLine.arguments.indices.contains(index + 1),
          let value = Int32(CommandLine.arguments[index + 1]),
          value > 0 else {
        return nil
    }
    return value
}()

if CommandLine.arguments.contains("--target-pid") && targetPid == nil {
    exit(3)
}

// Submitting is only meaningful for a targeted ordinary paste. Refuse rather
// than falling back to whichever application owns focus.
if submitAfterPaste && (copyMode || targetPid == nil) {
    exit(3)
}

// Dictation captures the target PID before the overlay appears. Activate and
// verify that exact application here, in the same native process that emits
// Cmd+V, instead of paying several AppleScript launches before every paste.
if !copyMode, let targetPid {
    guard let targetApp = NSRunningApplication(processIdentifier: targetPid) else {
        exit(3)
    }
    if !targetApp.isActive {
        _ = targetApp.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        for _ in 0..<30 {
            if targetApp.isActive { break }
            usleep(5000)
        }
    }
    if !targetApp.isActive {
        exit(4)
    }
}

// Resolved before the keystroke is posted: this is the app that will receive it.
let target = copyMode ? NSWorkspace.shared.frontmostApplication : nil
if copyMode && target == nil {
    exit(1)
}

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
if let targetPid {
    // Core Graphics supplies a PID-addressed event API. This removes the
    // focus-race window between targeting the recorded app and Cmd+V.
    keyDown.postToPid(targetPid)
} else {
    keyDown.post(tap: .cgSessionEventTap)
}
usleep(8000)
if let targetPid {
    keyUp.postToPid(targetPid)
} else {
    keyUp.post(tap: .cgSessionEventTap)
}
usleep(20000)

if let target = target {
    print("COPY_OK \(target.processIdentifier) \(target.localizedName ?? "")")
} else if let targetPid {
    if submitAfterPaste {
        // The paste key events were addressed to targetPid. Before emitting
        // Return, also require that the same app remains frontmost; otherwise
        // leave the text pasted and report a deliberately skipped submission.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {
            print("PASTE_OK \(targetPid) SUBMIT_SKIPPED target_changed")
            exit(0)
        }
        guard let returnDown = CGEvent(keyboardEventSource: nil, virtualKey: 0x24, keyDown: true),
              let returnUp = CGEvent(keyboardEventSource: nil, virtualKey: 0x24, keyDown: false) else {
            print("PASTE_OK \(targetPid) SUBMIT_SKIPPED event_unavailable")
            exit(0)
        }
        returnDown.postToPid(targetPid)
        usleep(8000)
        returnUp.postToPid(targetPid)
        usleep(8000)
        print("PASTE_OK \(targetPid) SUBMITTED")
    } else {
        print("PASTE_OK \(targetPid)")
    }
}
