// Shared by the main process and the settings page: looks a key up in one
// message table and fills its {placeholders}. A missing key shows as itself.
export function translator(table) {
  return (key, vars = {}) => (table[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
