# Expense Calculator

A clean, no-signup expense tracker. Set your monthly income, tap a date on the calendar to log what you spent, and watch your remaining budget update instantly. Works for every month, past and future.

## Features

**Monthly Expense tab**
- Set a total income per month, or one default income that applies to every month
- Calendar view for the month — each day shows what you spent on it
- Click any date to add an expense (amount, category, optional note)
- Every expense is subtracted from that month's budget in real time
- Live stats: income, spent this month, remaining budget
- Budget progress bar that turns red when you go over
- Expense list grouped by category, each with its total, share and count —
  fold a category away, or switch to one flat list
- Settle a whole category once you are reimbursed for it: those entries stop
  counting toward the month's spending and that much budget is freed, while
  the entries stay on record in a "Settled this month" section and can be
  put back at any time
- Category breakdown for the month
- Move to any month with the ‹ › arrows

**Total Expenses Till Now tab**
- All-time totals: expenses, income, net savings, number of entries
- Spending by month
- All-time category breakdown
- Month-by-month summary table

**Accounts**
- Register with email and password, or continue with Google
- Password reset by email, and change-password from the profile panel
- Profile photo upload and editable display name
- Guest mode for trying it without signing up — registering later upgrades
  the guest account in place, so nothing logged as a guest is lost
- Sign out clears the local cache, so a shared device never shows the
  previous person's figures

**To Receive tab**
- Log money someone owes you: person, amount, date given, and a note saying what it was for
- Open an entry to record part payments as they come in
- Each payment is kept with its date, so you get a running history
- Remaining balance and a progress bar update as you go; entries mark themselves settled
- "Mark fully received" closes out whatever is left in one tap
- Filter by not-settled, settled, or all

**Extras**
- Every entry is saved to Firebase (Cloud Firestore) in real time
- Works offline — changes queue locally and upload when you reconnect
- Optional Google sign-in to sync the same data across your phone and laptop
- Currency picker (PKR, INR, USD, EUR, GBP, AED, SAR)
- Export / import your data as a JSON backup
- Fully responsive — works on phone and desktop

Categories: Petrol, Lunch, Dinner, House, Bike, Given to someone, Office expense, Load, Manna, Other.

## Firebase setup (required)

The app runs without Firebase — it just falls back to browser-only storage and shows
a warning. To turn on cloud sync, do these three things once in the
[Firebase console](https://console.firebase.google.com/project/expense-calculator-88fbe):

**1. Enable authentication**
Authentication → Get started → Sign-in method → enable **Email/Password**,
**Google**, and **Anonymous** (anonymous powers the "continue as guest" button;
skip it only if you remove that option).

**2. Publish the security rules**
Firestore Database → Rules → paste the contents of [`firestore.rules`](firestore.rules) → Publish.

The default rules are `allow read, write: if false`, which blocks the app completely.
Do **not** replace them with `if true` — this repo is public, so the project id is
visible to anyone, and open rules would let a stranger read or delete your expenses.
The included rules scope every document to its owner's uid.

**3. Authorise your domains**
Authentication → Settings → Authorized domains → add your Vercel domain
(`localhost` is allowed by default).

### Is it safe that the API key is in the repo?

Yes. Firebase web API keys are public identifiers, not credentials — they only say
*which* project to talk to. Access is controlled entirely by the security rules in
step 2, which is why getting those right matters.

### How data is stored

```
users/{uid}                 -> { currency, defaultIncome, incomes,
                                 displayName, photo }
users/{uid}/expenses/{id}   -> { date, amount, category, note, createdAt,
                                 settled, settledOn }
users/{uid}/receivables/{id}
                            -> { person, amount, note, date, createdAt,
                                 payments: [{ id, amount, date }] }
```

Payments live inside their receivable rather than in their own collection: a
debt has a handful of repayments at most, and keeping them together means one
document read and no join.

### Why the avatar is not in Firebase Storage

Storage requires the Blaze (pay-as-you-go) plan for buckets created on recent
projects. To stay on the free tier, the app crops and shrinks your picture to a
256×256 JPEG in the browser (~2–20KB) and keeps the data URL in your Firestore
document. The rules cap it at 300KB, well inside the 1MB document limit.

## Running it locally

No build step and no `node_modules`. The Firebase SDK is imported as ES modules
straight from Google's CDN, which keeps deployment a plain static upload — the
`npm install firebase` route would need a bundler like Vite to produce the same result.

Because it uses ES modules, it must be served over http rather than opened as a
`file://` path:

```bash
npx serve .
```

## Deploying

It's a static site, so any static host works. On Vercel:

```bash
npx vercel --prod
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure — tabs, calendar, stats, modal |
| `styles.css` | All styling (dark theme, responsive) |
| `app.js` | State, calculations, rendering, cloud wiring |
| `firebase.js` | Auth and Firestore sync |
| `firestore.rules` | Security rules to paste into the console |

## Local cache format

Firestore is the source of truth; this mirror under the `expense-calculator-v1`
key in `localStorage` exists so the first paint is instant and the app still
works if Firebase is unreachable:

```json
{
  "currency": "PKR",
  "defaultIncome": 60000,
  "incomes": { "2026-08": 75000 },
  "expenses": [
    {
      "id": "1754900000000-a1b2c3d",
      "date": "2026-08-05",
      "amount": 1200,
      "category": "Petrol",
      "note": "bike fuel",
      "createdAt": 1754900000000
    }
  ]
}
```

`incomes` holds per-month overrides; any month without one falls back to `defaultIncome`.
