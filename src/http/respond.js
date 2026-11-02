'use strict';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
};

function send(res, status, body, headers) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** JSON body. `null` and `undefined` both serialise as `null`. */
function json(res, status, data, headers) {
  send(res, status, JSON.stringify(data === undefined ? null : data), {
    'Content-Type': 'application/json; charset=utf-8', ...headers,
  });
}

/** Errors are a bare sentence (text/plain), which the frontend shows as-is. */
function text(res, status, sentence, headers) {
  send(res, status, String(sentence), { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

module.exports = { send, json, text, redirect, SECURITY_HEADERS };
