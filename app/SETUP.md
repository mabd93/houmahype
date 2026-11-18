# Connect the HoumaHype app to Firebase

1. Go to https://console.firebase.google.com, sign in, click **Create a project** (name: houmahype). Analytics: off.
2. **Build > Firestore Database > Create database**. Production mode. Region: europe-west (closest to Cairo).
3. **Build > Authentication > Get started > Email/Password > Enable**. Then **Users > Add user**: create an account for each organizer.
4. **Firestore > Rules**: paste the contents of `firestore.rules`, click **Publish**.
5. **Project settings (gear) > Your apps > Web (</>)**: register an app, copy the `firebaseConfig` values into `firebase-config.js` (replace `null`).
6. Make each organizer a staff member: in Firestore click **Start collection**, id `staff`, document id = the user's **UID** (Authentication > Users > copy User UID), add one field `ok` = true.
7. Open `/app/organizer.html`, sign in, press **Create players** (HH-001..HH-300).
8. Write each wristband with the link `https://houmahype.com/app/?w=HH-001` (NFC Tools, "Write > Add a record > URL"), one code per band, or use the Write button on an Android phone.
9. In Authentication > Settings > Authorized domains, add `houmahype.com`.

The student app switches from demo mode to live data as soon as `firebase-config.js` is filled in.

## Sheet sync (HoumaHype Control sheet -> app)

The script in `../sheet-sync/Code.gs` copies players, staff roles and prices from the HoumaHype Control sheet into Firebase.

1. **Firestore > Rules**: paste the new `firestore.rules` and **Publish** (do this before using the new organizer page).
2. **Firebase console > Project settings (gear) > Service accounts > Generate new private key**. A .json file downloads. Keep it private; never put it in the repo or send it in chat.
3. Open the HoumaHype Control sheet > **Extensions > Apps Script**. Paste `Code.gs` over the default code and save.
4. Apps Script > **Project Settings (gear) > Script properties > Add script property**: name `SA_KEY`, value = the whole contents of the .json file.
5. Reload the sheet. A **HoumaHype** menu appears. Run **Dry run (no writes)** first and read the line it adds to the Sync Log. Google asks for permission the first time; approve it.
6. Run **Sync now (everything)**. Then **Install 5-minute trigger** so players follow the Status sheet automatically.

What each part does: starting Barhams are written once when a player is first created and are never overwritten; names and phones go to a staff-only collection; roles, permissions and prices are applied only when someone runs **Sync now**.
Staff sign in with the **Login email** from the Staff tab. Create each user in Authentication > Users (they set their own password), tick **Active** in the Staff tab, then run **Sync now**.
