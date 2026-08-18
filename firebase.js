/* =========================================================
   Firebase layer — auth + Firestore sync.

   Loaded straight from the CDN as ES modules so the project keeps
   working with no build step. `npm install firebase` would need a
   bundler; these imports are the same SDK, same version.

   Layout in Firestore:
     users/{uid}                  -> { currency, defaultIncome, incomes,
                                       displayName, photo }
     users/{uid}/expenses/{id}    -> { date, amount, category, note, createdAt }
     users/{uid}/receivables/{id} -> { person, amount, note, date, createdAt,
                                       payments: [{ id, amount, date }] }
   ========================================================= */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, updatePassword, sendPasswordResetEmail,
  EmailAuthProvider, GoogleAuthProvider,
  linkWithCredential, linkWithPopup, signInWithPopup, reauthenticateWithCredential
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
let unsubReceivables = null;

// the three snapshot streams arrive separately; hold each and merge
let latestSettings = null;
let latestExpenses = null;
let latestReceivables = null;
let seenSettings = false;
let seenExpenses = false;
let seenReceivables = false;
// streams that errored, so the UI can keep what it already had for them
let failed = { settings: false, expenses: false, receivables: false };

const userDoc = () => doc(db, 'users', uid);
const expensesCol = () => collection(db, 'users', uid, 'expenses');
const receivablesCol = () => collection(db, 'users', uid, 'receivables');

function emit() {
  // only report upward once both streams have delivered at least once,
  // otherwise the UI would flash a half-empty state
  if (!seenSettings || !seenExpenses || !seenReceivables) return;
  handlers.onData({
    settings: latestSettings || {},
    expenses: latestExpenses || [],
    receivables: latestReceivables || [],
    failed: { ...failed }
  });
}

/**
 * A stream that cannot be read must not hold the whole app hostage — mark it
 * delivered as empty so the streams that did load can still render, then
 * surface the error.
 */
function streamFailed(name, markDelivered) {
  return (err) => {
    failed[name] = true;
    markDelivered();
    emit();
    reportError(err);
  };
}

function subscribe() {
  unsubSettings = onSnapshot(userDoc(), (snap) => {
    latestSettings = snap.exists() ? snap.data() : {};
    seenSettings = true;
    failed.settings = false;
    emit();
  }, streamFailed('settings', () => { latestSettings = {}; seenSettings = true; }));

  unsubExpenses = onSnapshot(expensesCol(), (snap) => {
    latestExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    seenExpenses = true;
    failed.expenses = false;
    emit();
    handlers.onStatus({
      state: snap.metadata.fromCache ? 'offline' : 'synced',
      user: auth.currentUser
    });
  }, streamFailed('expenses', () => { latestExpenses = []; seenExpenses = true; }));

  unsubReceivables = onSnapshot(receivablesCol(), (snap) => {
    latestReceivables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    seenReceivables = true;
    failed.receivables = false;
    emit();
  }, streamFailed('receivables', () => { latestReceivables = []; seenReceivables = true; }));
}

function unsubscribeAll() {
  if (unsubSettings) { unsubSettings(); unsubSettings = null; }
  if (unsubExpenses) { unsubExpenses(); unsubExpenses = null; }
  if (unsubReceivables) { unsubReceivables(); unsubReceivables = null; }
  seenSettings = seenExpenses = seenReceivables = false;
  latestSettings = latestExpenses = latestReceivables = null;
  failed = { settings: false, expenses: false, receivables: false };
}

/** Turns the setup mistakes everyone hits into instructions. */
export function authErrorMessage(err) {
  switch (err.code) {
    case 'auth/configuration-not-found':
      return 'Authentication is not set up yet — open the Firebase console → Authentication → Get started, then enable the Email/Password and Anonymous providers.';
    case 'auth/operation-not-allowed':
      return 'That sign-in method is disabled — enable it under Firebase console → Authentication → Sign-in method.';
    case 'auth/unauthorized-domain':
      return `This domain (${location.hostname}) is not authorised — add it under Firebase console → Authentication → Settings → Authorized domains.`;
    case 'auth/invalid-email':          return 'That email address does not look right.';
    case 'auth/email-already-in-use':   return 'An account already exists with that email. Try signing in instead.';
    case 'auth/weak-password':          return 'Password is too weak — use at least 6 characters.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':         return 'Email or password is incorrect.';
    case 'auth/too-many-requests':      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/requires-recent-login':  return 'For security, sign out and back in before changing your password.';
    case 'auth/popup-blocked':          return 'Your browser blocked the popup — allow popups for this site and retry.';
    case 'auth/network-request-failed': return 'Network problem — check your connection and try again.';
    default: return err.message;
  }
}

function reportError(err) {
  console.error('[firebase]', err);
  handlers.onStatus({
    state: 'error',
    code: err.code,
    // permission-denied almost always means the Firestore rules were never
    // updated from the default deny-all
    message: err.code === 'permission-denied'
      ? 'Firestore rules are blocking access — publish the current firestore.rules, which now cover the receivables collection too.'
      : authErrorMessage(err),
    user: auth.currentUser
  });
}

/* ---------------- session ---------------- */

export function initCloud(callbacks) {
  handlers = { ...handlers, ...callbacks };
  handlers.onStatus({ state: 'connecting', user: null });

  onAuthStateChanged(auth, (user) => {
    unsubscribeAll();

    if (!user) {
      uid = null;
      handlers.onStatus({ state: 'signed-out', user: null });
      return;
    }

    uid = user.uid;
    handlers.onStatus({ state: 'connecting', user });
    subscribe();
  });
}

export function currentUser() {
  return auth.currentUser;
}

/* ---------------- sign in / register ---------------- */

export async function continueAsGuest() {
  await signInAnonymously(auth);
}

export async function loginWithEmail(email, password) {
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function registerWithEmail(email, password, name) {
  const existing = auth.currentUser;
  const credential = EmailAuthProvider.credential(email.trim(), password);
  let result;

  // upgrading a guest keeps the same uid, so entries already logged survive
  if (existing && existing.isAnonymous) {
    try {
      result = await linkWithCredential(existing, credential);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use' || err.code === 'auth/credential-already-in-use') {
        result = await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        throw err;
      }
    }
  } else {
    result = await createUserWithEmailAndPassword(auth, email.trim(), password);
  }

  if (name && name.trim()) {
    await updateProfile(result.user, { displayName: name.trim() });
  }
  return result.user;
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const user = auth.currentUser;

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

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOutUser() {
  unsubscribeAll();
  await signOut(auth);
}

/* ---------------- profile ---------------- */

export function hasPasswordProvider() {
  const user = auth.currentUser;
  return !!user && user.providerData.some((p) => p.providerId === 'password');
}

export async function changePassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');

  // Firebase requires a fresh login before a password change
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

export async function saveProfile({ name, photo }) {
  const user = auth.currentUser;
  if (!user) return;

  if (typeof name === 'string') {
    await updateProfile(user, { displayName: name.trim() });
  }
  // the photo is kept in Firestore rather than the auth profile: auth
  // photoURL is meant for short URLs, not inline image data
  const patch = {};
  if (typeof name === 'string') patch.displayName = name.trim();
  if (photo !== undefined) patch.photo = photo;
  if (Object.keys(patch).length) await setDoc(userDoc(), patch, { merge: true });
}

/* ---------------- data ---------------- */

export async function cloudSaveSettings(settings) {
  if (!uid) return;
  await setDoc(userDoc(), settings, { merge: true });
}

export async function cloudAddExpense(expense) {
  if (!uid) return;
  await setDoc(doc(expensesCol(), expense.id), expense);
}

/** Settling a category rewrites a whole batch of expenses at once. */
export async function cloudSaveExpenses(expenses) {
  if (!uid) return;
  await writeExpensesInBatches(expenses);
}

export async function cloudDeleteExpense(id) {
  if (!uid) return;
  await deleteDoc(doc(expensesCol(), id));
}

/** Writes the whole receivable, payment history included. */
export async function cloudSaveReceivable(receivable) {
  if (!uid) return;
  await setDoc(doc(receivablesCol(), receivable.id), receivable);
}

export async function cloudDeleteReceivable(id) {
  if (!uid) return;
  await deleteDoc(doc(receivablesCol(), id));
}

/** Wipes the cloud copy and writes `data` in its place — used by import. */
export async function cloudReplaceAll(data) {
  if (!uid) return;
  await cloudClearExpenses();
  await cloudClearReceivables();
  await setDoc(userDoc(), {
    currency: data.currency,
    defaultIncome: data.defaultIncome,
    incomes: data.incomes
  }, { merge: true });
  await writeExpensesInBatches(data.expenses);
  await writeReceivablesInBatches(data.receivables || []);
}

export async function cloudClearAll() {
  if (!uid) return;
  await cloudClearExpenses();
  await cloudClearReceivables();
  await setDoc(userDoc(), {
    currency: 'PKR', defaultIncome: 0, incomes: {}, budgets: {}, accounts: []
  }, { merge: true });
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
  await writeReceivablesInBatches(data.receivables || []);
}

async function cloudClearExpenses() {
  const snap = await getDocs(expensesCol());
  await runBatches(snap.docs, (batch, d) => batch.delete(d.ref));
}

async function cloudClearReceivables() {
  const snap = await getDocs(receivablesCol());
  await runBatches(snap.docs, (batch, d) => batch.delete(d.ref));
}

async function writeExpensesInBatches(expenses) {
  await runBatches(expenses, (batch, e) => batch.set(doc(expensesCol(), e.id), e));
}

async function writeReceivablesInBatches(receivables) {
  await runBatches(receivables, (batch, r) => batch.set(doc(receivablesCol(), r.id), r));
}

// Firestore caps a batch at 500 operations
async function runBatches(items, apply) {
  for (let i = 0; i < items.length; i += 450) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + 450)) apply(batch, item);
    await batch.commit();
  }
}

export { auth };
