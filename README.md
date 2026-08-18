# Expense Calculator

A clean, no-signup expense tracker. Set your monthly income, tap a date on the calendar to log what you spent, and watch your remaining budget update instantly. Works for every month, past and future.

## Features

Four pages, following the layout of the reference app.

**Home**
- What you have: every account with its balance and a combined net figure
- Your monthly expense: donut chart with a colour-coded legend
- Your budget: a monthly cap per category, amber near the limit and red past it

**Money**
- Salary for the month, or one default that applies to every month
- Calendar view where each day shows what went out on it
- Click a date, or the floating + button, to log an expense
- Expenses grouped by category, foldable, sortable by date
- Settle a category once you are reimbursed for it

**Insights**
- This month against last, with the direction of travel
- Average and highest month, busiest category, average spend per day
- Category comparison, six month trend, and the all-time totals

**Savings**
- What is in the savings account
- Salary received, spent, and kept, all time
- Money owed to you, with part payments recorded against each person

**Accounts and salary**

Mark one account as *salary* and one as *savings*. Salary is credited to its
account, and expenses come out of it by default, so the balance tracks what is
actually left. Naming a different account on an expense overrides that.

Categories: Home, Family, Food and drink, Petrol, Office expense, Personal,
Love, Mobile topup.

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
users/{uid}                 -> { currency, defaultIncome, incomes, budgets,
                                 accounts: [{ id, name, openingBalance, type }],
                                 displayName, photo }
users/{uid}/expenses/{id}   -> { date, amount, category, note, createdAt,
                                 settled, settledOn, accountId }
users/{uid}/receivables/{id}
                            -> { person, amount, note, date, createdAt,
                                 payments: [{ id, amount, date }] }
```

Payments live inside their receivable rather than in their own collection: a
debt has a handful of repayments at most, and keeping them together means one
document read and no join.

Budgets and accounts sit on the user document rather than in collections of
their own, for the same reason and one more: the existing rule already covers
that document, so adding them needed no rules change.

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
