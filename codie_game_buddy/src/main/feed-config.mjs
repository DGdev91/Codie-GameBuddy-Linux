import yaml from 'js-yaml';

// The update feed as electron-builder wrote it into app-update.yml.

// Base URL of a generic feed (OneDev raw files), or null for providers that
// find their files themselves (GitHub releases) and need no sign-in.
export function feedBaseUrl(appUpdateYml) {
  const config = yaml.load(appUpdateYml);
  if (config?.provider !== 'generic' || typeof config.url !== 'string') return null;
  return config.url.replace(/\/+$/, '');
}

// The Cookie header for the feed from the sign-in window's cookies.
export function cookieHeaders(cookies) {
  if (!cookies.length) return {};
  return { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };
}

// The sign-in window stays on the feed's site: anything else (a link, a
// redirect, a popup) could put another site in a window that looks like
// this app's own.
export function onFeedSite(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
