// Shared by the settings page and its tests: a pairing answer in the UI
// language. codie-host answers with a result code (govee_buddy spec §4.1);
// a failed call comes back from the settings IPC as { error, code }.
export function pairText(t, answer) {
  const key = `pair.result.${answer.code}`;
  const said = t(key, { name: answer.deviceName ?? '' });
  return said === key ? t('pair.result.unknown', { code: answer.code || answer.error || '' }) : said;
}
