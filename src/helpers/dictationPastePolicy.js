function shouldRestoreClipboardAfterDictation({ platform, targetActivated, requestedRestore }) {
  if (requestedRestore === false) return false;
  // A macOS paste command can exit successfully even when no verified external
  // target owns focus. Keep the transcript on the clipboard in that recovery
  // case instead of restoring the prior clipboard and making the text vanish.
  return !(platform === "darwin" && targetActivated !== true);
}

module.exports = { shouldRestoreClipboardAfterDictation };
