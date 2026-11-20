// Where a OneDev raw-file feed lives: the URL in package.json build.publish
// is <repo>/~raw/<branch>/<folder>.

export function parseRawFeed(url) {
  const m = /^(https:\/\/[^/]+\/.+?)\/~raw\/([^/]+)\/([^/]+)\/?$/.exec(url ?? '');
  if (!m) throw new Error(`build.publish.url is not a OneDev raw folder: ${url}`);
  return { url: url.replace(/\/+$/, ''), repo: m[1], branch: m[2], folder: m[3] };
}

// Installers in the feed folder, which a new release replaces.
export const staleInstallers = files => files.filter(f => f.endsWith('.exe'));
