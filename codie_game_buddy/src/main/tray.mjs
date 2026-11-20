import { Menu, Tray, nativeImage } from 'electron';

import { trayActivity, trayBitmap } from './tray-icon.mjs';

const icons = new Map();
function icon(state, activity = 'idle') {
  const key = `${state}:${activity}`;
  if (!icons.has(key)) {
    const result = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const size = 16 * scaleFactor;
      const buffer = nativeImage.createFromBitmap(trayBitmap(state, size, activity), { width: size, height: size }).toPNG();
      result.addRepresentation({ scaleFactor, buffer });
    }
    icons.set(key, result);
  }
  return icons.get(key);
}

// `onUpdate(action)` runs the action of the update entry (updateMenuItem()).
export function createTray({ onSettings, onToggle, onChatty, onUpdate, onQuit }) {
  const tray = new Tray(icon('connecting'));
  tray.on('double-click', onSettings);
  return {
    // `t`: the translator for the current UI language; `update`: the update entry.
    render({ state, commentaryEnabled, chattyMode, update, t, stateText, errorText, activityPhase }) {
      const text = stateText ?? t(state === 'ready' && !commentaryEnabled ? 'state.commentary-off' : `state.${state}`);
      tray.setImage(icon(state, trayActivity(state, activityPhase)));
      tray.setToolTip(t('tray.tooltip', { text }));
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: text, enabled: false },
        ...(errorText ? [{ label: errorText, enabled: false }] : []),
        { type: 'separator' },
        { label: t('tray.commentary'), type: 'checkbox', checked: commentaryEnabled, click: onToggle },
        { label: t('tray.chatty'), type: 'checkbox', checked: chattyMode, click: onChatty },
        { label: t('tray.settings'), click: onSettings },
        { label: update.label, enabled: update.action !== null, click: () => onUpdate(update.action) },
        { type: 'separator' },
        { label: t('tray.quit'), click: onQuit },
      ]));
    },
    // A Windows notification from the tray icon.
    notify: text => tray.displayBalloon({ title: 'Codie Game Buddy', content: text }),
    destroy: () => tray.destroy(),
  };
}
