'use strict';

const config = require('./config');
const { createApp } = require('./app');

const app = createApp({
  dbFile: config.dbFile,
  publicDir: config.publicDir,
  sessionTtlHours: config.sessionTtlHours,
  seedDemo: config.seedDemo,
  allowSignup: config.allowSignup,
});

app.server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/`;
  console.log(`${config.appName} v${config.version}`);
  console.log(`  App:      ${url}`);
  console.log(`  Database: ${config.dbFile}`);
  if (app.services.auth.needsSetup()) console.log('  First run: open the app to register your organisation.');
  console.log('  Press Ctrl+C to stop.');
});

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Close the other server, or set PORT in .env.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\nStopping…');
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
