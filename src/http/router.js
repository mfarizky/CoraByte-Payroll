'use strict';

/**
 * A tiny method + path router. Paths may hold `:params`.
 *   router.add('PUT', '/api/users/:id', handler)
 * Handlers receive (ctx) where ctx = { req, res, params, user, ... }.
 */
function createRouter() {
  const routes = [];

  function add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, regex, keys, handler, options });
  }

  /** @returns {{ handler: Function, params: object, options: object } | null | 'method'} */
  function match(method, pathname) {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params, options: r.options };
    }
    return pathMatched ? 'method' : null;
  }

  return { add, match };
}

module.exports = { createRouter };
