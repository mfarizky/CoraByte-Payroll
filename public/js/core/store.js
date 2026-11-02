/**
 * CoraByte Payroll — data access ("store").
 *
 * The only way the screens read or write payroll data. Every call is a POST
 * to /api/store { op, collection, key, value }; the server applies the rules
 * (locking, run status, paid = frozen) and answers the bare data, or a
 * one-sentence text/plain error.
 *
 *     GKI.store.list(collection, options?)    -> { rows, stale, cachedAt }
 *     GKI.store.get(collection, key)          -> { row,  stale, cachedAt }
 *     GKI.store.save(collection, key, value)  -> row
 *     GKI.store.del(collection, key)          -> { deleted, id }
 *     GKI.store.action(name, body)            -> body (POST /api/<name>)
 *     GKI.store.status()                      -> { online, lastOk, lastError }
 *
 * A 4xx is an answer (shown to the user as-is); only "no answer" (network
 * error or 5xx) marks the store offline. A 401 sends the user to sign in.
 */
(function(){

  var APP      = 'payroll';                      // cache namespace only
  var ENDPOINT = '/api/store';                   // this app's own proxy
  var TTL_MS   = 12 * 60 * 60 * 1000;            // 12 hours

  /* ── answered() — ONE PREDICATE, BOTH QUESTIONS (§4, v1.9) ───────────────
     "Is the store down?" and "may this read fall back to cache?" are the same
     question: DID THE SERVICE ANSWER?

     ⚠️ IMPLEMENTED AS TWO SEPARATE CONDITIONS THEY DRIFT APART, and the drift
     is invisible until a refusal happens. CRM's store.js set online=false on
     every non-ok response, four lines below a comment correctly quoting this
     rule — a 403 made the app announce an outage above a live read that had
     just succeeded. Both cannot be true. Fixed in CRM 2026-09-19.

     A 4xx IS AN ANSWER. The service is up and saying no.                    */
  function answered(status){ return status !== 0 && status < 500; }

  /* ── The error shape (§3). One shape, whatever failed. ──────────────────
     ⚠️ status 0 is the honest signal for "no answer" — DNS, offline, timeout,
     CORS. It is what separates DEGRADE from REFUSED, so it must never be
     flattened into a made-up 500.                                          */
  function storeError(status, body, op, collection){
    var e = new Error('store ' + op + ' ' + collection + ' failed: ' + status);
    e.status = status; e.body = body; e.op = op; e.collection = collection;
    return e;
  }

  /* ── Cache (§4). localStorage, per browser, try/catch on EVERY touch ─────
     It throws in private windows and returns empty after a clear, so every
     read and write is guarded and the accessor works with none of it.

     ⚠️ KEY SHAPE MATTERS. A get caches under <collection>/<key>; without the
     suffix a get overwrites that collection's list entry. CRM's fix, 2026-09-18.

     ⚠️ THE CACHE IS PER BROWSER and is never authoritative. It is "the last
     copy this browser saved", which differs per machine.                    */
  /* ⚠️ PAYROLL (plan F2): personal and pay data never touch localStorage.
     A read of app/payroll/* is never written, and never read back — so it
     cannot degrade to a stale copy either. Any old entry is removed. */
  function cacheable(collection){
    return String(collection).indexOf('app/payroll/') !== 0;
  }
  function cacheKey(collection, key){
    return 'gki.' + APP + '.store.' + collection + (key ? '/' + key : '');
  }
  function cacheRead(collection, key){
    if (!cacheable(collection)) {
      try { localStorage.removeItem(cacheKey(collection, key)); } catch(e){}
      return null;
    }
    try {
      var raw = localStorage.getItem(cacheKey(collection, key));
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || typeof rec.cachedAt !== 'number') return null;
      if (Date.now() - rec.cachedAt > TTL_MS) return null;
      return rec;
    } catch(e){ return null; }
  }
  function cacheWrite(collection, key, payload){
    if (!cacheable(collection)) return;
    try {
      localStorage.setItem(cacheKey(collection, key),
        JSON.stringify({ payload: payload, cachedAt: Date.now() }));
    } catch(e){ /* full, blocked or private — the accessor works without it */ }
  }

  /* ── status() state (§3, §4) ────────────────────────────────────────────
     online is false ONLY when the service did not answer. See answered().   */
  var state = { online: true, lastOk: null, lastError: null };

  /* ── The one call (§5). Same-origin POST to this app's own proxy. ────────
     The browser sends { op, collection, key, value } and its session cookie
     and NOTHING ELSE. The key and the employee identity are the proxy's job:
     the key because it must never reach the browser, the identity because the
     browser cannot be trusted to state it.                                  */
  function call(op, collection, key, value){
    /* ⚠️ undefined IS NORMALISED TO null, DELIBERATELY. §5 states the wire
       body as { op, collection, key, value } — four fields. JSON.stringify
       DROPS a key whose value is undefined, so a `get` (no value) and an
       option-less `list` were putting THREE fields on the wire and the
       envelope silently stopped matching the contract. Caught by
       storecheck.js, 2026-09-30. This is the envelope, not a save payload:
       §3's omitted-vs-empty trap is about the FIELDS INSIDE value, and is
       untouched by this. */
    return send(ENDPOINT, op, collection, {
      op: op,
      collection: collection,
      key: key === undefined ? null : key,
      value: value === undefined ? null : value
    }, true);                                   // collection calls report health
  }

  /* ── THE ONE TRANSPORT (COMPLIANCE, 2026-10-03) ─────────────────────────
     Every request this file makes goes through here: the four collection ops
     via call() above, and action() below. ONE fetch, one error shape. A
     second fetch for actions would be a second place for answered() to drift
     — the exact defect §4 records in CRM.

     `op` and `collection` are only what the error shape and lastError report:
     for an action they are 'action' and the action's name.

     ⚠️ reportsHealth — THE ONE BRANCH BETWEEN THE TWO CALLERS.
     2026-10-03, correcting its own earlier brief:
       true   collection calls. They write status() exactly as before:
              online, lastOk, lastError, through answered().
       false  actions. They write NOTHING to status() — not on success, not
              on a 4xx, not on a 5xx, not when the fetch itself rejects. The
              caller still gets the error, same shape.
     WHY: store health is what COLLECTION reads say it is. A generate that
     fails says the generator is misconfigured or refusing; it says nothing
     about whether list() works. Found by the GRID chat: a generate 500
     ("GENERATE_URL is not set") flipped online to false and the spine put
     "The store is unreachable" over rows it had read seconds earlier.
     The next collection call decides store health, as it always did.      */
  function send(endpoint, op, collection, payload, reportsHealth){
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function(resp){
      return resp.text().then(function(text){
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch(e){ data = null; }
        if (!resp.ok) {
          if (resp.status === 401) { window.location.href = '/login'; }
          if (reportsHealth) {
            if (!answered(resp.status)) state.online = false;
            state.lastError = { status: resp.status, body: text, op: op, collection: collection, at: Date.now() };
          }
          throw storeError(resp.status, text, op, collection);
        }
        if (reportsHealth) {
          state.online = true;
          state.lastOk  = Date.now();
        }
        return data;
      });
    }, function(networkErr){
      /* No answer at all. status 0, and the ONLY branch that may degrade. */
      var msg = String(networkErr && networkErr.message || networkErr);
      if (reportsHealth) {
        state.online = false;
        state.lastError = { status: 0, body: msg, op: op, collection: collection, at: Date.now() };
      }
      throw storeError(0, msg, op, collection);
    });
  }

  /* ── A read's failure path (§4) ─────────────────────────────────────────
     Degrade ONLY when the service did not answer: status 0 or 5xx. Return the
     last cached copy with stale:true and cachedAt; with no cache, throw.

     ⚠️ EVERY 4xx SURFACES. IT IS NEVER ANSWERED FROM CACHE. Corrected
     2026-09-18 — v1.3 said "on failure", CRM implemented that literally, and a
     403 on a read returned stale rows while a fenced 404 looked like data.
     Hiding a refusal behind a cache means the caller cannot tell "you may not
     read this" from "the network is down".

     The caller decides what to do with stale. The accessor never decides.    */
  function readOrDegrade(err, collection, key, shape){
    if (answered(err.status)) throw err;          // a refusal is an answer
    var hit = cacheRead(collection, key);
    if (!hit) throw err;                          // nothing to fall back to
    var out = {}; out[shape] = hit.payload;
    out.stale = true; out.cachedAt = hit.cachedAt;
    return out;
  }

  /* ⚠️ THE ERROR PATH ALREADY USES .text() AND NEVER .json(), and that is
     load-bearing rather than incidental. A 4xx body from the service is
     text/plain — a bare sentence meant to be shown to a person as it stands:
        401  "This caller is not recognised."
        403  "immigration may not write core/visa_types."
        404  "That collection does not exist."
        409  "Another visa type already uses that code."
     Calling .json() on one throws a parse error, and the caller reports an
     OUTAGE instead of a REFUSAL — the precise defect §4 exists to prevent.
     err.body is therefore the raw text, exactly as §3 declares it. Do not
     "tidy" call() into resp.json(). */

  var store = {

    /* list(collection, options?) — §3.
       ⚠️ Options ride on the `value` field so neither the proxy nor the
       service changes. They are FLAGS, not a query language, and the accessor
       PASSES THEM THROUGH UNCHANGED AND FILTERS NOTHING CLIENT-SIDE.
       ⚠️ An options-bearing list is NOT CACHED: two different result sets
       cannot share one entry (§4). */
    list: function(collection, options){
      var hasOpts = !!(options && typeof options === 'object' && Object.keys(options).length);
      return call('list', collection, null, hasOpts ? options : undefined)
        .then(function(data){
          /* ⚠️ THE BODY *IS* THE ARRAY. THERE IS NO ENVELOPE. Measured by
             The store: list answers a BARE JSON ARRAY of row
             objects, and zero rows is []. This read was `data.rows` — two
             levels too deep, undefined, `|| []`, and a 200 that reported
             zero rows against a collection holding 17. The contract
             specified the REQUEST body to the byte and said nothing about
             the reply; `rows` was carried inward from §3's CLIENT-SURFACE
             name, which is this function's OUTPUT, not the wire.
             ⚠️ Array.isArray, NOT `|| []`, ON PURPOSE: a wrong shape must
             not be able to impersonate an empty collection ever again. */
          if (!Array.isArray(data)) {
            throw storeError(200, 'Expected a JSON array of rows, received ' +
              (data === null ? 'null' : typeof data) + '. The response shape has changed.',
              'list', collection);
          }
          if (!hasOpts) cacheWrite(collection, null, data);   // success only
          return { rows: data, stale: false, cachedAt: null };
        }, function(err){
          if (hasOpts) throw err;                              // nothing cached to degrade to
          return readOrDegrade(err, collection, null, 'rows');
        });
    },

    /* get(collection, key) — §3. Cached under <collection>/<key>. */
    get: function(collection, key){
      return call('get', collection, key)
        .then(function(data){
          /* ⚠️ THE BODY IS THE ROW — not wrapped, not in an array (the database,
             2026-09-30). Was `data.row`. Same fault as list. */
          cacheWrite(collection, key, data);                    // success only
          return { row: data === undefined ? null : data, stale: false, cachedAt: null };
        }, function(err){
          return readOrDegrade(err, collection, key, 'row');
        });
    },

    /* save(collection, key, value) — §3. NEVER DEGRADES. Throws on failure.
       ⚠️ A SAVE IS A PARTIAL UPDATE: only the keys sent are written. An
       omitted key is unchanged; '' or null becomes NULL. A form that posts its
       whole model wipes every field the user did not fill, and the service
       cannot tell that from deliberate clearing. THE RULE: A FORM SENDS ONLY
       THE FIELDS IT SHOWS. That is the caller's obligation — this file passes
       the object through and filters nothing.
       ⚠️ SEND THE rev YOU READ. The service returns 409 on a mismatch, but
       ONLY when a rev is sent; without one the save is an ordinary overwrite
       and the 409 never fires. A caller that never read the row has nothing to
       send and must not invent one. */
    save: function(collection, key, value){
      return call('save', collection, key, value).then(function(data){
        /* ⚠️ THE BODY IS THE SAVED ROW, same shape, with rev MOVED and
           generated and defaulted columns filled (the store).
           REPLACE YOUR COPY WITH IT — the rev you hold is stale the instant
           this returns, and §3 says the next save must send the rev it read
           or the 409 never fires. Was `data.row`. */
        return data;
      });
    },

    /* del(collection, key) — §3. NEVER DEGRADES. Throws on failure. */
    del: function(collection, key){
      return call('del', collection, key).then(function(data){
        /* ⚠️ THE BODY IS { deleted: <boolean>, id: <string> } AND NOTHING
           ELSE (the store). Relayed as given rather than mapped
           to §3's declared `{ ok }`.
           ⚠️ THIS DIVERGES FROM §3 AND THE CONTRACT IS THE SIDE THAT IS
           WRONG: §3 was written before anyone measured the service. Inventing
           an `ok` here would make a caller's `if (r.ok)` silently true for a
           delete that returned deleted:false. Contract corrected in v1.13. */
        return data;
      });
    },

    /* action(name, body) -> Promise of the service's answer, as it stands.
       the first implementation; the
       contract is being amended to carry it.

       POSTs `body` to this app's own proxy at /api/<name> (today only
       'generate'), through the SAME send() as the collection ops: same
       headers, same error shape.

       ⚠️ AN ACTION NEVER TOUCHES status() — not online, not lastOk, not
       lastError; not on success, 4xx, 5xx or a rejected fetch (CORE,
       2026-10-03, correcting the first brief, which said "same online/offline
       tracking"). The caller gets the error; store health stays what the
       last collection call said. See send().

       ⚠️ AN ACTION IS NOT A COLLECTION. It is NEVER cached, NEVER served
       stale, and NEVER degrades — on any failure it throws, like save. It
       returns the parsed 200 body bare, with no { rows, stale, cachedAt }
       wrapper. A cached "generate" that quietly returned last week's counts
       would be worse than an error.

       ⚠️ A NON-2xx IS READ WITH .text() — err.body is the service's one
       sentence, to be shown as it stands (§5.2).

       ⚠️ THE NAME IS CHECKED FOR SHAPE ONLY — lowercase letters, digits and
       hyphens, in one or more '/'-separated segments that each start with a
       letter ('generate', 'publish/filing') — so it can never become a path
       like "../store": no dot can appear anywhere. That is transport safety,
       not permission: what may be run is the service's to decide (§3). A bad
       name is a programming error and throws a TypeError WITHOUT touching
       status(), because nothing was sent and nothing failed to answer.
       The '/' segments were added 2026-10-13 for step 9's POST
       /api/publish/filing — one transport, no raw fetch in obligation-ui. */
    action: function(name, body){
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(name)) {
        return Promise.reject(new TypeError(
          'GKI.store.action needs a lowercase action name such as "generate".'));
      }
      return send('/api/' + name, 'action', name,
                  body === undefined ? null : body,
                  false);                       // actions never report health
    },

    /* status() — §3. The accessor exposes this and NOTHING VISUAL.
       ⚠️ THE DEGRADE BAND BELONGS TO THE SPINE (§4). It renders the warning
       and decides which actions to disable; what this app permits on stale
       data is stated in its own architecture.md, per app by design. */
    status: function(){
      return { online: state.online, lastOk: state.lastOk, lastError: state.lastError };
    }
  };

  /* ⚠️ NO RETRIES, NO QUEUE, NO OPTIMISTIC UPDATE (§4). A write applied later
     is worse than one refused now: this is reference data five apps read, and a
     silent deferred write means two people believe different things about the
     same record. Reads are not retried either in v1 — a retry doubles the wait
     before the degrade band appears, and the cache already covers the case the
     retry would have fixed. Revisit with evidence, not in principle. */

  /* ── PUBLISHING, AND THE COLLISION §6's LOAD ORDER CREATES ──────────────
     §6 puts this file AFTER config.js and BEFORE spine.js. Correct — the
     accessor must exist before the spine starts.

     ⚠️ A SPINE THAT DOES `window.GKI = GKI;` — a WHOLE-OBJECT ASSIGNMENT,
     not a merge — silently destroys a plain `window.GKI.store = store`.
     Nothing errors; GKI.store is simply undefined at the first call. Measured
     in IMMIGRATION's spine.js, 2026-09-30 (accessor §6.1). COMPLIANCE's spine
     attaches with window.GKI.spine = ..., but the defence stays: §6.1 says the
     accessor defends itself and no second file is relied on.

     A property accessor on window re-attaches .store to whatever is assigned.
     We rejected the two alternatives (accessor §6.1):
        (a) one line in spine.js  — `GKI.store = window.GKI_STORE;`
        (b) load store.js AFTER spine.js in index.html, against §6

     GKI_STORE is also published as a stable handle that no assignment to
     window.GKI can take away. */
  window.GKI_STORE = store;

  try {
    var held = window.GKI;
    Object.defineProperty(window, 'GKI', {
      configurable: true,
      enumerable: true,
      get: function(){ return held; },
      set: function(v){
        held = v;
        if (v && typeof v === 'object' && !v.store) {
          try { v.store = store; } catch(e){}
        }
      }
    });
    if (held && typeof held === 'object') { if (!held.store) held.store = store; }
    else { window.GKI = {}; }        // runs the setter, which attaches .store
  } catch(e) {
    /* defineProperty refused: fall back to the plain attach. GKI_STORE above
       still works, and the spine's assignment is what would break this. */
    window.GKI = window.GKI || {};
    window.GKI.store = store;
  }

})();
