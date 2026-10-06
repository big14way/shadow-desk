# Shadow Desk

**A peer-to-peer ZEC desk where the price is public and the participants are not.**

ZECATHON · Track: Private Markets

- The seller's ZEC sits in a **FROST 2-of-3 escrow** shared by buyer, seller and an arbiter.
- Every escrow is a fresh shielded address that looks like any other on-chain.
- Bank details travel as **encrypted Zcash memos** that the server never sees.
- After each trade, the desk publishes only **the price, a size range and an hour**.

> Work in progress — see the commit history for build steps.
