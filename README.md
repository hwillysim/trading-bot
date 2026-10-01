# JEV trading bot

A local, paper-first USDT spot trading research tool. It records Binance market data, asks TypeSafe JEV narrow questions about short-term setups, checks observed net outcomes and risk limits in code, and displays the result in a local dashboard. An optional GPT-6 Luna API review runs every five minutes and records suggestions for review.

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

- The feed watches liquid USDT markets and current movers, with BTC/ETH context and correctly parsed five-level books. Order-size estimates use the effective order amount. Price volatility is sampled by time rather than message count.
- Version 2 detects early buying acceleration and pullback recovery. JEV receives recent price history, trade flow, book information, market context and explicit costs. It evaluates return bands and cost-clearing potential at 30, 60 and 120 seconds.
- New paper entries need a forecast above costs plus a 3-basis-point margin and earlier measured JEV-managed net outcomes for the matching setup, volatility, horizon and JEV cost-probability band. At least 30 samples across five separate five-minute time blocks are required. The lower estimate of mean net return must exceed the margin. The bot collects shadow evidence while this requirement is unmet. Existing exploratory data cannot qualify version 2 entries. JEV output is a judgement, not a calibrated financial probability or proof of profitability.
- Every eligible candidate can start a separate shadow episode, at most once per coin every five minutes. Identical aggressive entries compare fixed-time exits, volatility stops and JEV-managed volatility stops. A fourth comparison tests passive entry with fixed-time exits. Passive fills require recorded selling through the entry bid after consuming the visible queue and proposed order quantity. Missing quotes and unfilled passive orders are counted separately, not as zero-return trades. Shadow positions do not change your paper balance.
- Actual paper buys consume visible asks, charge fees and apply slippage. Quantities follow the exchange filters. Exits consume visible bids, can fill partially and do not repeatedly consume the same book update. There is no live order path in the running engine.
- Holdings and JEV shadow positions are reassessed about every three seconds, with bounded concurrency, rate-limit backoff and the existing daily API budget. An assessment expires after ten seconds. The expected fluctuation over five seconds sets a trailing allowance of 10 to 40 basis points, fixed at entry. The protective loss limit is 80 basis points. The stop only moves upwards. Fresh favourable assessments can extend the planned hold by 30 seconds at a time, up to the original deadline, which is the smaller of five minutes and the configured holding cap. Extensions require positive remaining potential. A timer checks deadlines even when a fresh quote has not changed.
- Pause cancels pending buys, aborts JEV and LLM requests already in flight, and stops all new calls to both providers. Local protective exits and planned holding deadlines remain active. A late response cannot place an order or update the strategy. Calls submitted before cancellation may still be billed by the provider.
- Kill Bot aborts providers, cancels pending buys and closes paper holdings using fresh bids. It waits for a fresh book or further liquidity when necessary. Once holdings are closed, Restart trading resumes with the existing cash balance and history. Resume also restarts a paused bot. No new paper run is required.
- Maximum simultaneous tokens is editable from 1 to 50. Upgrading an existing five-position configuration starts with 10 slots. Float, order size, daily loss and API spending limits remain in force. Effective order size is the smallest of the order cap, float times position fraction and available cash.
- The five-minute LLM review records suggestions without applying changes during the experiment. Its accounting includes both entry and exit fees, correctly clears earlier completed trades and handles partial exits. It also sees the shadow comparison results.
- Sleep and connectivity loss stop fresh decisions. An overdue holding exits when fresh executable quotes return. The app cannot execute while the Mac is asleep or disconnected. API use retains its configured daily UTC budget, with a conservative reservation for concurrent requests.

The dashboard retains the existing portfolio chart and balance history. Strategy comparisons show their own coverage and mean net returns, separate from paper-account returns. Settings can start a fresh paper run only when the bot is paused and has no holdings or pending orders. Installation retains the current ledger and runtime credentials, and saves a database backup and the previous runtime before replacing code.

## Replay and validation

Run `npm test` and `npm run typecheck` after changes. Recorded snapshots, decisions, trades, reviews and usage are held in `data/trading-bot.sqlite`. Run `npm run replay` after enough recorded data exists. Paper results and replay reports are research evidence, not proof of future profitability. The order adapter's testnet tests exercise API formatting and recovery paths; testnet liquidity does not establish live execution quality.

## Start on login

After the app has run successfully by hand, run `zsh scripts/install-launch-agent.sh` to create and start a macOS LaunchAgent. The installer copies the runnable source, built dashboard, current database and local `.env` into `~/Library/Application Support/JEVTradingBot`, since background login services may not be able to read the Documents folder. Rerun the installer after changing the code; the runtime database and its credentials are retained. Update credentials through the dashboard Settings page. The Mac must remain awake and connected for the feed to run. Logs go to the runtime copy's `data/launchd.out.log` and `data/launchd.err.log`.

## Desktop app

Run `zsh scripts/install-desktop-app.sh` to put `JEV Trading Bot.app` on the Desktop. Double-clicking it opens the local dashboard in its own window and tries to start the login service if necessary. The app displays an error if the service remains unavailable. Rebuild the dashboard and rerun both installers after changing the web interface or bot code. The Desktop app displays the bot's paper account only; it does not enable live exchange trading.
