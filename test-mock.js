#!/usr/bin/env node
/* Offline smoke test for the OpenLamp engine JS port.
 * NO network, NO real lamps: tuyapi is replaced by a mocked device object
 * injected through Engine({deviceFactory}). Uses port 18377 so it can run
 * alongside a real engine on 8377. */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Engine, COLORS } = require('./engine');

const TEST_PORT = 18377;
const CONFIG_PATH = path.join(__dirname, 'test-lamps.tmp.json');

// ------------------------------------------------------------ mock device ---

class MockTuyaDevice {
  // Mimics the tuyapi surface the driver uses: connect/disconnect/isConnected/
  // get({schema})/set({multiple,data,shouldWaitForResponse})/on(event).
  constructor(conf, ip) {
    this.conf = conf;
    this.ip = ip;
    this.connected = false;
    this.sets = []; // every acked multi-DP send, for assertions
    // colour mode, V=1000 (100%), hue 0 sat 1000 -> engine reads bri=100
    this.dps = { 20: true, 21: 'colour', 22: 1000, 24: '000003e803e8', 26: 0 };
  }
  on() { /* events unused by the mock */ }
  async connect() { this.connected = true; return true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async get() { return { devId: this.conf.device_id, dps: { ...this.dps } }; }
  async set(opts) {
    this.sets.push(opts);
    Object.assign(this.dps, opts.data || {});
    return { dps: { ...(opts.data || {}) } }; // truthy ack, like a live 3.5 session
  }
  async refresh() { return this.get(); }
}

const devices = {}; // lamp name -> mock instance
const deviceFactory = (conf, ip) => (devices[conf.name] = new MockTuyaDevice(conf, ip));

// --------------------------------------------------------------- test rig ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for: ' + label);
}

// drain: a snapRequest goes through the FIFO queue, so awaiting it guarantees
// every previously dispatched command has been executed.
const drain = (engine) => Promise.all(engine.lamps.map((l) => l.snapRequest()));

function writeTestConfig() {
  const cfg = {
    lamps: [
      { name: 'L1', mac: 'aa:aa:aa:aa:aa:01', device_id: 'devid-L1',
        local_key: 'key-L1', ips: { '192.168.1': '192.168.1.101' }, last: '192.168.1' },
      { name: 'L2', mac: 'aa:aa:aa:aa:aa:02', device_id: 'devid-L2',
        local_key: 'key-L2', ips: { '192.168.1': '192.168.1.102' }, last: '192.168.1' },
    ],
    groups: { front: ['L1'], back: ['L2'] },
    sync: { enabled: false },
    snapshots: {},
    state: { color: 'bleu' },
    greet: false, // skip the 2.7 s rainbow sweep — keeps the test fast + deterministic
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  ok -', label);
}

async function main() {
  writeTestConfig();
  const engine = new Engine({ configPath: CONFIG_PATH, port: TEST_PORT, deviceFactory });
  let changed = 0;
  engine.on_change = () => { changed += 1; };

  try {
    // -- connection ----------------------------------------------------------
    await waitFor(() => engine.lamps.every((l) => l.ok), 'both lamps connected');
    check('both mock lamps connect (find:false, IPs from config)',
          engine.lamps.every((l) => l.ok));
    check('IP resolved from config ips{subnet}', devices.L1.ip === '192.168.1.101');
    check('initial bri read from DP24 V (colour mode)',
          engine.lamps.every((l) => l.bri === 100));

    // -- color alias ---------------------------------------------------------
    check('dispatch(vert) accepted', engine.dispatch('vert', {}) === true);
    await drain(engine);
    const L1 = engine.lamps[0], L2 = engine.lamps[1];
    check('color alias tracks rgb on all lamps',
          JSON.stringify(L1.rgb) === JSON.stringify(COLORS.vert) &&
          JSON.stringify(L2.rgb) === JSON.stringify(COLORS.vert));
    const lastSet = devices.L1.sets[devices.L1.sets.length - 1];
    check('colour sent as explicit multi-DP acked set (DP21=colour)',
          lastSet.multiple === true && lastSet.shouldWaitForResponse === true &&
          lastSet.data['21'] === 'colour' && lastSet.data['20'] === true);
    // vert (0,200,80) @100% -> scaled to V=255 -> hue 144 = 0x0090
    check('DP24 HSV hex encodes hue 144 for vert',
          lastSet.data['24'].startsWith('0090'));
    check('engine state.color updated', engine.state.color === 'vert');

    // -- OLS patch -----------------------------------------------------------
    check('dispatch OLS patch accepted',
          engine.dispatch('{"col": [0, 200, 80], "bri": 128}', {}) === true);
    await drain(engine);
    check('patch bri 128 -> 50% tracked', L1.bri === 50 && L2.bri === 50);
    check('patch col tracked', JSON.stringify(L1.rgb) === JSON.stringify([0, 200, 80]));

    // -- blackout / restore --------------------------------------------------
    engine.dispatch('blackout', {});
    await drain(engine);
    check('blackout turns lamps off + remembers state',
          !L1.isOn && !L2.isOn && L1.saved && L1.saved.on === true &&
          L1.saved.bri === 50);
    const offSet = devices.L1.sets[devices.L1.sets.length - 1];
    check('blackout sends DP20=false', offSet.data['20'] === false);
    engine.dispatch('restore', {});
    await drain(engine);
    check('restore replays pre-blackout state',
          L1.isOn && L1.bri === 50 &&
          JSON.stringify(L1.rgb) === JSON.stringify([0, 200, 80]));

    // -- snapshots -----------------------------------------------------------
    check('snap:save dispatch accepted', engine.dispatch('snap:save:test', {}) === true);
    await waitFor(() => engine.cfg.snapshots.test &&
                        Object.keys(engine.cfg.snapshots.test).length === 2,
                  'snapshot captured');
    check('snapshot captured both lamps with tracked state',
          engine.cfg.snapshots.test.L1.bri === 50 &&
          JSON.stringify(engine.cfg.snapshots.test.L1.rgb) === JSON.stringify([0, 200, 80]));

    // -- group targeting -----------------------------------------------------
    engine.dispatch('rouge', { lamps: ['front'] }); // group front = [L1]
    await drain(engine);
    check('group targeting: L1 changed, L2 untouched',
          JSON.stringify(L1.rgb) === JSON.stringify(COLORS.rouge) &&
          JSON.stringify(L2.rgb) === JSON.stringify([0, 200, 80]));
    check('targets() expands groups',
          engine.targets({ lamps: ['front'] }).map((l) => l.name).join(',') === 'L1');

    // -- snapshot recall -----------------------------------------------------
    engine.dispatch('snap:test', {});
    await drain(engine);
    check('snap recall restores saved rgb on L1',
          JSON.stringify(L1.rgb) === JSON.stringify([0, 200, 80]) && L1.bri === 50);

    // -- HTTP API ------------------------------------------------------------
    const syntax = await (await fetch(`http://127.0.0.1:${TEST_PORT}/syntax`)).json();
    check('/syntax responds with OLS contract v2.0',
          syntax.version === '2.0' && syntax.keys.includes('col') &&
          syntax.extensions.includes('scene'));
    const status = await (await fetch(`http://127.0.0.1:${TEST_PORT}/status`)).json();
    check('/status reports both lamps connected',
          status.L1 && status.L1.connected === true &&
          status.L2 && status.L2.connected === true && status.L2.type === 'tuya');
    const post = await (await fetch(
      `http://127.0.0.1:${TEST_PORT}/json/state?lamps=back`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ col: [255, 210, 0] }) })).json();
    await drain(engine);
    check('POST /json/state (WLED-compat) applies patch to targeted group',
          post.success === true &&
          JSON.stringify(L2.rgb) === JSON.stringify([255, 210, 0]) &&
          JSON.stringify(L1.rgb) === JSON.stringify([0, 200, 80]));
    const agg = await (await fetch(`http://127.0.0.1:${TEST_PORT}/json/state`)).json();
    check('GET /json/state aggregates like WLED', agg.on === true && agg.lamps.L1);

    // -- on_change hook + deferred save --------------------------------------
    await sleep(2200); // > 1.5 s hook delay and > 2 s saver period
    check('on_change hook fired after dispatch', changed > 0);
    const savedCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    check('deferred config save persisted the snapshot',
          savedCfg.snapshots.test && savedCfg.snapshots.test.L1.bri === 50);

    console.log(`\nPASS — ${passed} assertions OK`);
  } finally {
    engine.stop();
    try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* ignore */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\nFAIL —', e && e.stack || e); process.exit(1); },
);
