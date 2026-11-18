'use strict';
// Minimal in-memory stand-in for the parts of Firestore that core.js uses.
// It also enforces the real rule that a transaction may not read after it has written.
function makeDb() {
  const store = new Map();
  const clone = v => JSON.parse(JSON.stringify(v));
  const mkRef = (coll, id) => ({ coll, id, path: coll + '/' + id });
  const docSnap = r => { const v = store.get(r.path); return { exists: v !== undefined, id: r.id, ref: r, data: () => (v === undefined ? undefined : clone(v)) }; };
  const matches = (v, [f, op, val]) => op === '==' ? v[f] === val : Array.isArray(v[f]) && v[f].includes(val);
  function querySnap(q) {
    const docs = [];
    for (const [p, v] of store) {
      if (!p.startsWith(q.coll + '/')) continue;
      const id = p.slice(q.coll.length + 1); if (id.includes('/')) continue;
      if (q.filters.every(f => matches(v, f))) docs.push(docSnap(mkRef(q.coll, id)));
    }
    return { docs, empty: docs.length === 0 };
  }
  const mkQuery = (coll, filters) => ({ coll, filters, where: (f, op, val) => mkQuery(coll, filters.concat([[f, op, val]])), get: async () => querySnap({ coll, filters }) });
  const db = {
    store,
    collection: coll => Object.assign(mkQuery(coll, []), { doc: id => Object.assign(mkRef(coll, id), { get: async () => docSnap(mkRef(coll, id)) }) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async x => { if (writes.length) throw new Error('TEST: read after write in a transaction'); return x.path ? docSnap(x) : querySnap(x); },
        set: (r, d, o) => writes.push({ r, d: clone(d), merge: !!(o && o.merge) }),
        update: (r, d) => { if (!store.has(r.path)) throw new Error('TEST: update of missing doc ' + r.path); writes.push({ r, d: clone(d), merge: true }); }
      };
      const out = await fn(tx);
      if (writes.length > 500) throw new Error('TEST: more than 500 writes in one transaction');
      for (const w of writes) store.set(w.r.path, w.merge ? Object.assign({}, store.get(w.r.path) || {}, w.d) : w.d);
      return out;
    },
    put(path, data) { store.set(path, clone(data)); },
    get(path) { return store.has(path) ? clone(store.get(path)) : undefined; }
  };
  return db;
}
module.exports = { makeDb };
