# Ahmed Finance OS — Alpha 0.2

Personal, text-based finance terminal. Data stays in the browser's IndexedDB (`FinanceDB`) and works offline. Google Sheets is an optional automatic backup relay; it is not the primary datastore.

## Daily use

Type `help` in the terminal. The default entry style is guided; change it with `settings entry quick` for one-line commands.

```text
exp 120 coffee c morning latte
inc 5000 salary t
fuel 500 45200 full c station name
move 1000 c t
```

Wallet codes start with: `C Cash`, `T Telda`, `N NBK`, `B CIB`, `I InstaPay`, `O Other`. The app remembers the most recently used wallet.

## Main commands

| Command | Purpose |
| --- | --- |
| `dash` | Today, week, month, due and wallet dashboard. |
| `exp`, `inc`, `fuel` | Guided transaction entry. |
| `list`, `filter <category>`, `search <text>` | Find transactions. |
| `edit <row>`, `delete <row>`, `undo` | Change listed data safely. |
| `category [list|add|rename|hide]` | Manage categories. |
| `wallet [list|add|rename|hide]` | Manage wallets. |
| `fuel stats` | Fuel cost and efficiency report. |
| `due add`, `due list`, `due done <row>` | Manage reminders and payments. |
| `favorite` or `fav` | Saved command templates. |
| `repeat`, `move`, `report`, `backup` | Shortcuts, transfers, reports and JSON backup. |
| `settings` | Entry, fuel price, dashboard and color choices. |

Fuel has no category. Enter cost, odometer, `full` or `partial`, optional wallet, and note. Liters are calculated from `settings fuelprice <EGP>`.

## Google Sheets backup (optional)

The included Vercel endpoint `api/sync.js` forwards a complete encrypted-transport JSON backup after each local change. To enable it, create a Google Apps Script Web App (or another private receiver) that writes the received JSON to your chosen Sheet, then set this Vercel environment variable:

```text
GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
```

Do not put Google credentials or Web App secrets in browser JavaScript. Until this variable is configured, the app stays local and displays `LOCAL / READY`.

## Data safety

- Updating the Vercel deployment does not erase `FinanceDB` on the same browser and domain.
- Clearing browser website data, using private browsing, or moving to a different domain starts a separate local database.
- Use `backup` regularly. Alpha 0.2 exports all records, including hidden and soft-deleted records.
