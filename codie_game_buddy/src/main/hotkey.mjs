// The commentary hotkey (spec §4.1): one global shortcut at a time.
// Returns the message key of the error for the settings window, or null.
export function registerHotkey(shortcut, accelerator, onPress) {
  shortcut.unregisterAll();
  try {
    return shortcut.register(accelerator, onPress) ? null : 'hotkey.taken';
  } catch {
    return 'hotkey.invalid';
  }
}
