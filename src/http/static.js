'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { send, SECURITY_HEADERS } = require('./respond');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serves a file from `root`. Returns false when there is no such file, so
 * the caller can answer 404. Paths outside `root` are never served.
 */
function serveStatic(req, res, root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return false; }
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;

  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const cache = ext === '.woff2' || file.includes(path.sep + 'vendor' + path.sep)
    ? 'public, max-age=604800'          // fonts and pinned libraries: a week
    : 'no-cache';                       // app code: always revalidate
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function sendFile(res, file) {
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-cache' });
}

module.exports = { serveStatic, sendFile };
