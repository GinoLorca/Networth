# Networth

A private net-worth board for one person. It links to your bank once (read-only, through
[SimpleFIN Bridge](https://bridge.simplefin.org)) and from then on everything is automatic:
balances and transactions arrive from the bank feed, and the rest — recurring bills, the pay
schedule, your spending baseline, the daily rounds, net worth — is worked out for you.
Nothing is ever imported by hand.

It treats personal finance as a chess game in progress: net worth is the evaluation, cash is
the clock, each day is a round against your own habit, and each transaction is a move on the
scoresheet.

## Privacy

- There is no server. The app is a static page; your data lives in your browser's own storage.
- The bank link is a read-only SimpleFIN key that never leaves the device it was linked on. It
  is not part of any backup the app makes.
- The page's security policy only allows connections to SimpleFIN Bridge. There are no
  analytics, no fonts or scripts from other sites, and no cookies.
- This repository contains no one's financial data. The sample game is fictional.

## Using it

1. Open the site. On an iPhone, add it to the Home Screen first and open it from there.
2. Create a SimpleFIN Bridge account, connect your bank there, and copy a setup token.
3. Paste the token into Networth. That is the last thing you will ever type into it.

## Working on it

No dependencies and no build step in development.

```
node tools/serve.mjs      # http://localhost:4173/  (add ?demo=1 for the sample game)
node --test               # unit tests
node tools/build.mjs      # writes docs/ — the single-file site that GitHub Pages serves
```

`ARCHITECTURE.md` is the specification: the data model, every calculation, and the rules the
interface follows.
