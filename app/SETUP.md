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
