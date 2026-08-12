/* =========================================================
   Firebase layer — auth + Firestore sync.

   Loaded straight from the CDN as ES modules so the project keeps
   working with no build step. `npm install firebase` would need a
   bundler; these imports are the same SDK, same version.

   Layout in Firestore:
     users/{uid}                  -> { currency, defaultIncome, incomes }
     users/{uid}/expenses/{id}    -> { date, amount, category, note, createdAt }
   ========================================================= */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, linkWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDr_H_0nOKKtUPker4G-cdXJOitohyLRWs',
  authDomain: 'expense-calculator-88fbe.firebaseapp.com',
  projectId: 'expense-calculator-88fbe',
  storageBucket: 'expense-calculator-88fbe.firebasestorage.app',
  messagingSenderId: '976312941564',
  appId: '1:976312941564:web:55fc6a27d59052a50e1079',
  measurementId: 'G-F133TGBF8G'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// persistentLocalCache keeps everything working offline — writes queue up
// locally and flush when the connection comes back.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

let uid = null;
let handlers = { onData: () => {}, onStatus: () => {} };
let unsubSettings = null;
let unsubExpenses = null;

// the two snapshot streams arrive separately; hold both and merge
let latestSettings = null;
let latestExpenses = null;
let seenSettings = false;
let seenExpenses = false;

const userDoc = () => doc(db, 'users', uid);
const expensesCol = () => collection(db, 'users', uid, 'expenses');

function emit() {
  // only report upward once both streams have delivered at least once,
  // otherwise the UI would flash a half-empty state
  if (!seenSettings || !seenExpenses) return;
  handlers.onData({
    settings: latestSettings || {},
    expenses: latestExpenses || []
  });
}

function subscribe() {
  unsubSettings = onSnapshot(userDoc(), (snap) => {
    latestSettings = snap.exists() ? snap.data() : {};
    seenSettings = true;
    emit();
  }, reportError);

  unsubExpenses = onSnapshot(expensesCol(), (snap) => {
    latestExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    seenExpenses = true;
    emit();
    handlers.onStatus({
      state: snap.metadata.fromCache ? 'offline' : 'synced',
      user: auth.currentUser
    });
  }, reportError);
}

/** Turns the setup mistakes everyone hits into instructions. */
export function authErrorMessage(err) {
  switch (err.code) {
    case 'auth/configuration-not-found':
      return 'Authentication is not set up yet — open the Firebase console → Authentication → Get started, then enable the Anonymous provider.';
    case 'auth/operation-not-allowed':
      return 'Anonymous sign-in is disabled — enable it under Firebase console → Authentication → Sign-in method.';
    case 'auth/unauthorized-domain':
      return `This domain (${location.hostname}) is not authorised — add it under Firebase console → Authentication → Settings → Authorized domains.`;
    default:
      return err.message;
  }
}

function reportError(err) {
  console.error('[firebase]', err);
  handlers.onStatus({
    state: 'error',
    // permission-denied almost always means the Firestore rules were never
    // updated from the default deny-all
    message: err.code === 'permission-denied'
      ? 'Firestore rules are blocking access — see firestore.rules in the repo.'
      : err.message,
    user: auth.currentUser
  });
}

/* ---------------- public API ---------------- */

export function initCloud(callbacks) {
  handlers = { ...handlers, ...callbacks };
  handlers.onStatus({ state: 'connecting', user: null });

  onAuthStateChanged(auth, (user) => {
    if (unsubSettings) { unsubSettings(); unsubSettings = null; }
    if (unsubExpenses) { unsubExpenses(); unsubExpenses = null; }
    seenSettings = seenExpenses = false;

    if (!user) {
      uid = null;
      signInAnonymously(auth).catch((err) => {
        handlers.onStatus({ state: 'error', message: authErrorMessage(err), user: null });
      });
      return;
    }

    uid = user.uid;
    handlers.onStatus({ state: 'connecting', user });
    subscribe();
  });
}

export async function cloudSaveSettings(settings) {
  if (!uid) return;
  await setDoc(userDoc(), settings, { merge: true });
}

export async function cloudAddExpense(expense) {
  if (!uid) return;
  await setDoc(doc(expensesCol(), expense.id), expense);
}

export async function cloudDeleteExpense(id) {
  if (!uid) return;
  await deleteDoc(doc(expensesCol(), id));
}

/** Wipes the cloud copy and writes `data` in its place — used by import. */
export async function cloudReplaceAll(data) {
  if (!uid) return;
  await cloudClearExpenses();
  await setDoc(userDoc(), {
    currency: data.currency,
    defaultIncome: data.defaultIncome,
    incomes: data.incomes
  });
  await writeExpensesInBatches(data.expenses);
}

export async function cloudClearAll() {
  if (!uid) return;
  await cloudClearExpenses();
  await setDoc(userDoc(), { currency: 'PKR', defaultIncome: 0, incomes: {} });
}

/** First-run helper: lifts existing localStorage data into the cloud. */
export async function cloudMigrate(data) {
  if (!uid) return;
  await setDoc(userDoc(), {
    currency: data.currency,
    defaultIncome: data.defaultIncome,
    incomes: data.incomes
  }, { merge: true });
  await writeExpensesInBatches(data.expenses);
}

async function cloudClearExpenses() {
  const snap = await getDocs(expensesCol());
  await runBatches(snap.docs, (batch, d) => batch.delete(d.ref));
}

async function writeExpensesInBatches(expenses) {
  await runBatches(expenses, (batch, e) => batch.set(doc(expensesCol(), e.id), e));
}

// Firestore caps a batch at 500 operations
async function runBatches(items, apply) {
  for (let i = 0; i < items.length; i += 450) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + 450)) apply(batch, item);
    await batch.commit();
  }
}

/* ---------------- optional Google account ---------------- */

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const user = auth.currentUser;

  // upgrading the anonymous account keeps the same uid, so nothing is lost
  if (user && user.isAnonymous) {
    try {
      return await linkWithPopup(user, provider);
    } catch (err) {
      // this Google account already owns data here — just switch to it
      if (err.code === 'auth/credential-already-in-use' ||
          err.code === 'auth/email-already-in-use') {
        return await signInWithPopup(auth, provider);
      }
      throw err;
    }
  }
  return await signInWithPopup(auth, provider);
}

export async function signOutUser() {
  await signOut(auth);
}

export { auth };
