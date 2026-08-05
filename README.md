# Ahmed Finance OS — Alpha 0.2

Personal, text-based finance terminal. Data is stored locally in IndexedDB for offline use and synchronized to Neon Postgres through private Vercel functions.

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

## Neon cloud sync and PIN

The Vercel project must be connected to the Neon database. Add one Environment Variable in Vercel before deploying:

```text
APP_PIN=choose-a-private-numeric-or-long PIN
```

Apply it to **Production** only and keep it marked Sensitive. `DATABASE_URL` is already added by the Neon integration; never copy it into source code.

On the deployed Vercel URL, the app asks for `APP_PIN` before reading or writing cloud data. Each local change is then pushed to Neon, while IndexedDB remains available as the offline copy. Opening the same app on a new device and entering the PIN downloads the saved cloud data.

## Data safety

- Updating the Vercel deployment does not erase `FinanceDB` on the same browser and domain.
- Clearing browser website data, using private browsing, or moving to a different domain starts a separate local database.
- Use `backup` regularly. Alpha 0.2 exports all records, including hidden and soft-deleted records.
