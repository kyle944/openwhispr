import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
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
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)

if let target = target {
    print("COPY_OK \(target.processIdentifier) \(target.localizedName ?? "")")
} else if let targetPid {
    print("PASTE_OK \(targetPid)")
}
