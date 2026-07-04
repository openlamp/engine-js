# OpenLamp Engine — JavaScript port

**A faithful Node.js port of [openlamp/engine](https://github.com/openlamp/engine)**
(the Python reference implementation), for environments that prefer JS over Python —
e.g. Stream Deck plugins packaged on the official Node SDK, or any npm-based stack.

Same contract, same behavior: [OpenLamp State](https://github.com/openlamp/engine/blob/main/OLS.md)
patches + legacy aliases, persistent per-lamp connections (tuyapi, protocol 3.5),
acked multi-DP sets, groups, snapshots, animations (paced ≤4 cmd/s), connect-time
sync, rainbow welcome sweep, and the identical local API on `127.0.0.1:8377`
(`/cmd`, `/status`, `/syntax`, WLED-compat `/json/state`). Frontends cannot tell
which engine is serving them — the two are interchangeable behind the API.

## Status

- ✅ Offline-validated: 25 assertions on mocked devices (`npm test`).
- ✅ Live-validated on real Tuya lamps (2026-07-04): protocol 3.5 session
  negotiation, connect + rainbow greet + sync writes, color commands acked
  (`ok:true`), auto-deauth integration — both lamps held concurrently.
- ◐ One fix pending live confirmation: state readback now uses a plain DPS query
  (`get({})`) — `get({schema:true})` made the 3.5 firmware drop the session.

## Run

```sh
npm install
node engine.js        # headless daemon; config = tuya-lamps.json next to engine.js
npm test              # offline mock test (port 18377)
```

**One host at a time**: never run this alongside the Python engine host (Stream
Deck plugin or daemon.py) — each Tuya lamp accepts a single local connection and
every host binds port 8377.

Part of the [OpenLamp](https://github.com/openlamp/openlamp) family. Made by
**BenLab** with the help of Claude.
