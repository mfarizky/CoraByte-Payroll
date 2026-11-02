'use strict';

/**
 * Demo data: six fictional employees with salaries, departments and payroll settings.
 *
 *   npm run seed:demo                       -> a new "Demo Consulting" organisation,
 *                                              sign in as  demo / demo12345
 *   npm run seed:demo -- --org "<name>"     -> into an existing organisation
 *                                              (only if it has no employees yet)
 */
const config = require('../src/config');
const { openDatabase } = require('../src/db/connection');
const { createDocuments } = require('../src/db/documents');
const { createUserService } = require('../src/services/user-service');
const { createOrganizationService } = require('../src/services/organization-service');
const { seedReference, seedDemo } = require('../src/db/seed');
const { pickOrg } = require('./_org');

const { createClientService } = require('../src/services/client-service');

const argv = process.argv.slice(2);
const db = openDatabase(config.dbFile);
const documents = createDocuments(db);
const orgService = (seed) => createOrganizationService({ db, documents, users: createUserService({ db }),
  clients: createClientService({ db, documents }), seedDemoOnRegister: seed });

try {
  if (argv.includes('--org')) {
    const org = pickOrg(db, argv);
    const docs = documents.forOrg(org.id);
    seedReference(db, docs);
    const clientId = orgService(true).ensurePrimary(org.id);
    console.log(seedDemo(db, docs, clientId)
      ? `Demo data added to "${org.name}".`
      : `"${org.name}" already has employees — demo data was not added.`);
  } else {
    const orgs = orgService(true);
    orgs.register({ org_name: 'Demo Consulting', name: 'Demo Admin', username: 'demo', password: 'demo12345' });
    console.log('Created organisation "Demo Consulting" with demo data. Sign in as  demo / demo12345');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
