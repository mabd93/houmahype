'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const core = require('./core');

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
