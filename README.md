# JEV trading bot

A local, paper-first USDT spot trading research tool. It records Binance market data, asks TypeSafe JEV narrow questions about short-term setups, checks observed net outcomes and risk limits in code, and displays the result in a local dashboard. An optional GPT-6 Luna API review runs every five minutes and may propose bounded strategy changes.

**Live orders are disabled.** The Binance order adapter is present for isolated testnet checks, but the running bot never constructs or arms it. Raising the dashboard's order cap does not turn on live trading. The default paper float is 10 USDT and the maximum paper order is 0.20 USDT.

## Requirements

- macOS with Node.js 24 or later.
- Internet access to Binance market data, TypeSafe and OpenAI for their respective features.
- `JEV_API_KEY` for JEV decisions and `OPENAI_API_KEY` for strategy reviews. Without a key, its feature remains offline and the dashboard still opens.
- Check the three provider price variables in `.env` against your account rates before paid use; they determine the displayed spend and the daily API spending gate.

## Start locally

```sh
cp .env.example .env
chmod 600 .env
# Add the keys to .env in a local editor.
npm run web:install
npm run web:build
npm test
npm run typecheck
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The app listens only on the local loopback interface. Provider keys stay in `.env`, which Git ignores. Do not give any Binance API key withdrawal or margin permission.

For frontend development, run `npm --prefix web run dev` separately and open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to the backend on port 3000.

## Operation

- The feed scans Binance's USDT spot listings and watches detailed order-book/trade data for the highest-volume candidates and any held token.
- A JEV response does not place a paper trade by itself. The policy also requires a fresh book, sufficient liquidity, a positive lower-bound net outcome from at least 30 prior comparable observations for that token, and all risk gates.
- Paper entries use price-limited orders that may remain open, fill in parts against visible ask quantity, or expire after 30 seconds. Reserved USDT stays in total portfolio value and leaves the available balance until it fills or is cancelled. Exits use the latest fresh bid with estimated fees and slippage.
- Each five-minute AI review defaults to no change when evidence is weak. The backend validates every proposed change and keeps user-set caps outside model control.
- Pause trading stops new assessments and entries while paper exits remain active. Resume trading restarts entries. Liquidate cancels pending buys, pauses trading and sells all paper holdings for USDT at a fresh bid. If the book is stale, it waits for the next fresh quote and shows a pending state. Kill stops new decisions and closes a paper position at a fresh bid; if there is no fresh book, it closes on the next fresh update. Kill remains latched until the local state is reset deliberately.
- Local sleep or lost connectivity pauses fresh decisions. API use is capped at US$1 per UTC day by default, although a single in-flight request can take the total slightly past the cap.

The dashboard reports paper balances and graphs portfolio value from samples recorded every ten seconds. Its range controls cover 15 minutes, one hour, 24 hours, seven days and all recorded history. The graph begins when this version of the app first runs; earlier balances cannot be reconstructed. It does not read Binance account balances until the live account adapter has been separately validated and connected. The `web/dist` build is served by the backend.

## Replay and validation

Run `npm test` and `npm run typecheck` after changes. Recorded snapshots, decisions, trades, reviews and usage are held in `data/trading-bot.sqlite`. Run `npm run replay` after enough recorded data exists. Paper results and replay reports are research evidence, not proof of future profitability. The order adapter's testnet tests exercise API formatting and recovery paths; testnet liquidity does not establish live execution quality.

## Start on login

After the app has run successfully by hand, run `zsh scripts/install-launch-agent.sh` to create and start a macOS LaunchAgent. The installer copies the runnable source, built dashboard, current database and local `.env` into `~/Library/Application Support/JEVTradingBot`, since background login services may not be able to read the Documents folder. Rerun the installer after changing the code or `.env`; the runtime database is retained. The Mac must remain awake and connected for the feed to run. Logs go to the runtime copy's `data/launchd.out.log` and `data/launchd.err.log`.

## Desktop app

Run `zsh scripts/install-desktop-app.sh` to put `JEV Trading Bot.app` on the Desktop. Double-clicking it opens the local dashboard in its own window and tries to start the login service if necessary. The app displays an error if the service remains unavailable. Rebuild the dashboard and rerun both installers after changing the web interface or bot code. The Desktop app displays the bot's paper account only; it does not enable live exchange trading.
