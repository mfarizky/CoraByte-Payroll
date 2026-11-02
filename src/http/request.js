'use strict';

const { HttpError } = require('../services/errors');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Reads and parses a JSON request body (max 2 MB). */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'Send the request as application/json.'));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'The request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Cross-site request guard: a state-changing request must come from this
 * same origin (browsers always send Origin on cross-site POSTs).
 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  try {
    if (new URL(origin).host === host) return;
  } catch { /* fall through */ }
  throw new HttpError(403, 'Cross-site requests are not allowed.');
}

module.exports = { readJson, parseCookies, assertSameOrigin };
