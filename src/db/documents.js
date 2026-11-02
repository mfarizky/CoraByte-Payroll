'use strict';

/**
 * Document repository: rows of JSON grouped by organisation and collection.
 *
 *   const docs = createDocuments(db).forOrg(orgId);
 *   docs.list('app/payroll/clients');
 *
 * Every query is bound to one organisation, so a tenant can never read or
 * write another tenant's rows. Methods are synchronous (node:sqlite is),
 * which keeps the business rules free of read/write races.
 */
function createDocuments(db) {
  const q = {
    list: db.prepare('SELECT data FROM documents WHERE org_id = ? AND collection = ? ORDER BY rowid'),
    get: db.prepare('SELECT data FROM documents WHERE org_id = ? AND collection = ? AND id = ?'),
    upsert: db.prepare(`
      INSERT INTO documents (org_id, collection, id, data, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (org_id, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    remove: db.prepare('DELETE FROM documents WHERE org_id = ? AND collection = ? AND id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND collection = ?'),
  };

  const parse = (row) => (row ? JSON.parse(row.data) : null);

  function forOrg(orgId) {
    if (!orgId) throw new Error('documents.forOrg: no organisation');
    return {
      orgId,
      /** @returns {object[]} */
      list(collection) {
        return q.list.all(orgId, collection).map(parse);
      },
      /** @returns {object|null} */
      get(collection, id) {
        return parse(q.get.get(orgId, collection, String(id)));
      },
      /** Inserts or replaces a whole row (the row must carry its id). */
      put(collection, row) {
        if (!row || !row.id) throw new Error('documents.put: row without id');
        q.upsert.run(orgId, collection, String(row.id), JSON.stringify(row), new Date().toISOString());
        return row;
      },
      remove(collection, id) {
        return q.remove.run(orgId, collection, String(id)).changes > 0;
      },
      /** Deletes every row of `collection` for which `predicate(row)` is true. */
      removeWhere(collection, predicate) {
        let n = 0;
        for (const row of this.list(collection)) {
          if (predicate(row)) { q.remove.run(orgId, collection, String(row.id)); n++; }
        }
        return n;
      },
      count(collection) {
        return q.count.get(orgId, collection).n;
      },
    };
  }

  return { forOrg };
}

module.exports = { createDocuments };
