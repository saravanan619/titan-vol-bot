# TitanX volume bot (testnet only)

UI-driving volume farming bot for the TitanX testnet perp DEX
(testnet.titanx.cc). It opens and closes fast, max-leverage BTC positions
to generate trading fees, which are what earn points (weekly epochs,
tickets from fees paid, pro-rata share of a weekly pool).

**Testnet only. No real money. No private keys, no API calls, no
credentials in this repo.**

## How it works

The bot clicks the same buttons a human clicks. It never touches
IndexedDB, never extracts keys, and never calls the API directly. The
app itself signs every request with its own session.

## Run it (bookmarklet)

1. Save this as a bookmark (name it TitanX Bot), with the URL below as
   the bookmark address:

   `javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/saravanan619/titan-vol-bot@main/titan-vol-bot-final.js';document.body.appendChild(s);})();`

2. In your browser, log in to testnet.titanx.cc and open the BTC trade page.
3. Tap the TitanX Bot bookmark. Wait for the control panel to say READY.
4. Press START in the panel. It does not auto-start.

If tapping the bookmark does nothing, the site blocked the loaded
script. Fall back to pasting `titan-vol-bot-final.js` into the DevTools
console on the trade page instead.

## Run it (console)

Paste `titan-vol-bot-final.js` into the DevTools console on the BTC
trade page, wait for READY, press START.

## Safety

- Full size: 95% of available balance as margin per trade, max leverage,
  hold 5s, 30s gap between round trips, alternate long/short.
- Max hold: any open position is force-closed after 30s, no matter what.
- Failed close: farming halts, rescue mode keeps retrying the close
  until the position is gone. It never walks away from an open position.
- Balance floor: stops below 2,000 USDCx and tries the faucet once.
- Kill switch: panel STOP button, `__titanVolBot.stop()` in the console,
  or localStorage key `titan:volbot:kill` = `"1"`.
- `__titanVolBot.status()` shows the live tally.
