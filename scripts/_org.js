'use strict';

/**
 * Picks the organisation a CLI script works on: the one named with
 * `--org "<name or id>"`, or the only one there is.
 */
function pickOrg(db, argv) {
  const i = argv.indexOf('--org');
  const wanted = i !== -1 ? argv[i + 1] : null;
  const orgs = db.prepare('SELECT id, name FROM organizations ORDER BY created_at').all();
  if (wanted) {
    const hit = orgs.find((o) => o.id === wanted || o.name.toLowerCase() === wanted.toLowerCase());
    if (!hit) throw new Error(`No organisation "${wanted}". Known: ${orgs.map((o) => o.name).join(', ') || 'none'}`);
    return hit;
  }
  if (orgs.length === 1) return orgs[0];
  if (!orgs.length) return null;
  throw new Error(`There are ${orgs.length} organisations; name one with --org "<name>". Known: ${orgs.map((o) => o.name).join(', ')}`);
}

/** argv without the `--org <value>` pair. */
function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

module.exports = { pickOrg, positional };
