'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const core = require('./core');
const accounts = require('./accounts');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });
admin.initializeApp();
const db = admin.firestore();

function wrap(fn) {
  return onCall(async request => {
    try {
      return await fn(db, request.auth && request.auth.uid, request.data || {});
    } catch (e) {
      if (e instanceof core.Fail) throw new HttpsError(e.code, e.message);
      console.error(e);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
}

// Game leader / Full staff: scan any player of the winning team (or record a draw).
exports.recordMatch = wrap(core.recordMatch);
// Full staff: mark "no result", or set / correct a winner. Everything affected is recomputed.
exports.adminMatch = wrap(core.adminMatch);

// Students: first-time activation (wristband code + activation code + own password) creates the lifetime account.
exports.claimAccount = wrap((d, uid, data) => accounts.claimAccount(d, admin.auth(), data));
// Signed-in students: link the wristband of a new event to the same account.
exports.linkBand = wrap(accounts.linkBand);
// Full staff, end of event: store every member's final team score and rank (lifetime points).
exports.closeEvent = wrap(accounts.closeEvent);
