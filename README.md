# Expense Calculator

A clean, no-signup expense tracker. Set your monthly income, tap a date on the calendar to log what you spent, and watch your remaining budget update instantly. Works for every month, past and future.

## Features

**Monthly Expense tab**
- Set a total income per month, or one default income that applies to every month
- Calendar view for the month — each day shows what you spent on it
- Click any date to add an expense (amount, category, optional note)
- Every expense is subtracted from that month's budget in real time
- Live stats: income, spent, remaining budget, daily average
- Budget progress bar that turns red when you go over
- Category breakdown for the month
- Move to any month with the ‹ › arrows

**Total Expenses Till Now tab**
- All-time totals: expenses, income, net savings, number of entries
- Spending by month
- All-time category breakdown
- Month-by-month summary table

**Extras**
- Currency picker (PKR, INR, USD, EUR, GBP, AED, SAR)
- Export / import your data as a JSON backup
- Fully responsive — works on phone and desktop
- Data is stored in your browser's `localStorage`; nothing is sent to a server

## Running it locally

No build step, no dependencies. Either open `index.html` directly in a browser, or serve the folder:

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
| `app.js` | State, storage, calculations, rendering |

## Data format

Everything lives under the `expense-calculator-v1` key in `localStorage`:

```json
{
  "currency": "PKR",
  "defaultIncome": 60000,
  "incomes": { "2026-08": 75000 },
  "expenses": [
    { "id": 1, "date": "2026-08-05", "amount": 1200, "category": "Food", "note": "lunch" }
  ]
}
```

`incomes` holds per-month overrides; any month without one falls back to `defaultIncome`.
