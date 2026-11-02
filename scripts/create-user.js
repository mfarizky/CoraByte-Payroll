'use strict';

/**
 * Creates a user from the command line — handy when an organisation's only
 * admin forgot their password (create a second admin, sign in, reset the first).
 *
 *   npm run user:create -- <username> "<display name>" <admin|member> [--org "<organisation>"]
 *
 * --org is needed only when the database holds more than one organisation.
 * The password is asked for interactively (not stored in the shell history).
 */
const readline = require('node:readline');
const config = require('../src/config');
const { openDatabase } = require('../src/db/connection');
const { createUserService } = require('../src/services/user-service');
const { pickOrg, positional } = require('./_org');

const argv = process.argv.slice(2);
const [username, name, role = 'member'] = positional(argv);
if (!username || !name) {
  console.error('Usage: npm run user:create -- <username> "<display name>" <admin|member> [--org "<organisation>"]');
  process.exit(1);
}

const db = openDatabase(config.dbFile);
let org;
try {
  org = pickOrg(db, argv);
  if (!org) throw new Error('There is no organisation yet. Start the app and register one first.');
} catch (err) {
  console.error(err.message);
  db.close();
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Password for ${username} (at least 8 characters): `, (password) => {
  rl.close();
  try {
    const user = createUserService({ db }).create(org.id, { username, name, password, role });
    console.log(`Created ${user.role} "${user.username}" in "${org.name}".`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
});
