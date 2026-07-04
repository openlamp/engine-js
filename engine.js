#!/usr/bin/env node
/* OpenLamp engine — Node.js port of engine.py (draft).
 *
 * CORE layer: drivers (persistent connections, one async loop per lamp), the
 * dispatcher (OpenLamp State = WLED-compatible state patch + legacy aliases),
 * groups, snapshots, animations (cycle/flash/tempo), connect-time sync, the
 * rainbow welcome sweep, and the local API on 127.0.0.1:8377
 * (/cmd /status /syntax + /json/state WLED-compat).
 *
 * It knows NOTHING about Stream Deck. Run ONE host at a time (this daemon OR
 * the Python plugin/daemon): each Tuya lamp accepts a single local connection
 * and both hosts bind port 8377.
 *
 * The only upward link is the on_change hook — a callback fired ~1.5 s after a
 * dispatch so a frontend can refresh whatever it displays.
 *
 * Differences vs the Python engine (documented in README.md):
 * - tinytuya -> tuyapi (protocol 3.5 support to be validated on real lamps);
 * - IPs come ONLY from the config (ips{subnet: ip} + last) — no ARP re-sweep,
 *   no router deauth (macOS/OpenWrt-specific, out of scope for the draft);
 * - threads/queues -> one async run-loop + FIFO command queue per lamp.
 *
 * Config: tuya-lamps.json (same schema as the Python engine — shared source
 * of truth). Override with OPENLAMP_CONFIG=<path> or new Engine({configPath}).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const API_PORT = 8377; // local API (127.0.0.1 only) — see createApi()
const SYNTAX_VERSION = '2.0'; // generic syntax = WLED-compatible state patch (OLS.md)

// ---------------------------------------------------------------- helpers ---

function log(...a) {
  // Timestamped stderr log (the Python engine writes to a plugin logfile; the
  // draft keeps it on stderr so `node engine.js` is self-contained).
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  process.stderr.write(`${hh}:${mm}:${ss} ${a.map(String).join(' ')}\n`);
}

function sleep(ms) {
  // unref'd: a lamp loop sleeping through backoff must never keep the process
  // alive on its own — the HTTP server (or the daemon keep-alive) is the ref.
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    if (t.unref) t.unref();
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms${label ? ' (' + label + ')' : ''}`)), ms);
    if (t.unref) t.unref();
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Kelly palette (most-differentiable first) — same RGB values as lamp.py.
const COLORS = {
  jaune: [255, 210, 0], violet: [150, 70, 170], orange: [255, 125, 0],
  bleuclair: [130, 195, 255], rouge: [230, 0, 40], vert: [0, 200, 80],
  rose: [255, 130, 170], bleu: [0, 100, 200],
};
const COLOR_ORDER = Object.keys(COLORS);
const PALIERS = { lueur: 1, veilleuse: 10, tamise: 30, moyen: 55, fort: 80, max: 100 };

// Tuya DP map (capability name -> DP id). Same DPs as tinytuya's bulb dpset.
const DPS = { switch: '20', mode: '21', brightness: '22', colourtemp: '23', colour: '24', timer: '26' };

function scale(rgb, pct) {
  // scale brightness (V = max(r,g,b)/255) to the wanted percent, keeping hue+sat
  const mx = Math.max(...rgb) || 1;
  const f = (255.0 * pct / 100.0) / mx;
  return rgb.map((c) => clamp(Math.round(c * f), 0, 255));
}

function curBriPct(dps) {
  // current brightness 0-100: in color mode = V of colour_data (DP24, HHHHSSSSVVVV, 0-1000)
  const mode = dps['21'] !== undefined ? dps['21'] : 'colour';
  const cd = typeof dps['24'] === 'string' ? dps['24'] : '';
  if ((mode === 'colour' || mode === 'color') && cd.length >= 12) {
    const v = parseInt(cd.slice(8, 12), 16);
    if (!Number.isNaN(v)) return clamp(Math.round(v / 10.0), 1, 100);
  }
  if (dps['22'] !== undefined && dps['22'] !== null) {
    const v = parseInt(dps['22'], 10);
    if (!Number.isNaN(v)) return clamp(Math.round(v / 10.0), 1, 100);
  }
  return 60;
}

const hex4 = (n) => clamp(Math.round(n), 0, 0xffff).toString(16).padStart(4, '0');

function rgbToHsvHex(r, g, b) {
  // DP24 encoding: HHHH SSSS VVVV — hue 0-360, sat 0-1000, value 0-1000 (hex).
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx / 255;
  return hex4(Math.round(h) % 360) + hex4(Math.round(s * 1000)) + hex4(Math.round(v * 1000));
}

function hsvToRgb01(h, s, v) {
  // colorsys.hsv_to_rgb port: h/s/v in 0-1, returns [r,g,b] in 0-1.
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// -------------------------------------------------------------- FIFO queue --

const Q_TIMEOUT = Symbol('timeout');

class CommandQueue {
  // FIFO with a blocking pop(timeout) — the JS equivalent of Python's
  // queue.Queue: keeps the "one in-flight command at a time" invariant.
  constructor() { this.items = []; this.waiters = []; }

  push(item) {
    const w = this.waiters.shift();
    if (w) w.resolve(item);
    else this.items.push(item);
  }

  pop(timeoutMs) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      const waiter = {};
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(Q_TIMEOUT);
      }, timeoutMs);
      if (t.unref) t.unref();
      waiter.resolve = (v) => { clearTimeout(t); resolve(v); };
      this.waiters.push(waiter);
    });
  }
}

// --------------------------------------------------------------- BaseLamp ---

class BaseLamp {
  // Common base: command queue + life loop. Subclasses: _connect/_exec/_heartbeat.
  constructor(conf, state) {
    this.c = conf;
    this.state = state;
    this.q = new CommandQueue();
    this.ok = false;
    this.stopped = false;
    this.bri = 60;
    this.isOn = true;
    this.rgb = [0, 100, 200];   // last RGB sent — used by tt/blackout/snapshot
    this.saved = null;          // state saved by blackout (restore replays it)
    this.engine = null;
    this._fails = 0;
  }

  get name() { return this.c.name || '?'; }

  trackedState() {
    // snapshot of the engine-side tracked state (snapshots, blackout/restore)
    return { on: this.isOn, bri: this.bri, rgb: [...this.rgb] };
  }

  statusRequest() {
    // synchronous-state request routed THROUGH the queue: executes AFTER the
    // commands already queued (FIFO order guaranteed) — debug + tests.
    return new Promise((resolve) => this.q.push({ __type: 'status', resolve }));
  }

  snapRequest() {
    // photo AFTER the queue (FIFO) — snapshots capture post-fade state.
    return new Promise((resolve) => this.q.push({ __type: 'snap', resolve }));
  }

  async _greet() {
    /* Rainbow welcome sweep: a clearly visible ~2.7 s pass through the whole
     * hue wheel, fired on connect / power-on before the sync state.
     * BEST-EFFORT and cosmetic: if a step glitches (flaky radio) we abandon
     * the sweep silently and let sync take over — the greeting must never
     * trigger a reconnect loop on a fragile lamp. Returns true if completed. */
    const steps = 9;
    for (let i = 0; i <= steps; i++) {
      const [r, g, b] = hsvToRgb01((i / steps) % 1.0, 1.0, 1.0);
      try {
        await this._exec({ on: true, bri: 255,
          col: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)] });
      } catch (e) {
        return false; // glitch -> stop sweeping, no reconnect
      }
      await sleep(2700 / steps);
    }
    return true;
  }

  start() {
    this._runPromise = this.run().catch((e) => log(this.name, 'run loop crashed:', e && e.stack || e));
  }

  async run() {
    let backoff = 3000;
    while (!this.stopped) {
      if (!this.ok) {
        let ok = false;
        try { ok = await this._connect(); }
        catch (e) { log(this.name, 'connect failed:', e && e.message || e); }
        if (this.stopped) break;
        if (!ok) {
          // progressive backoff 3->30 s: hammering a stuck lamp makes it worse
          // (single connection slot); give it air.
          this._fails += 1;
          await sleep(backoff);
          backoff = Math.min(30000, backoff * 2);
          continue;
        }
        this._fails = 0;
        // 1) "I'm online" rainbow sweep, 2) sync state (see Engine.syncPatch)
        try {
          const eng = this.engine;
          const greet = eng ? (eng.cfg.greet !== false) : true;
          const st = eng ? eng.syncPatch(this) : null;
          const prev = this.trackedState();
          if (greet) {
            const done = await this._greet();
            log(this.name, done ? 'rainbow welcome sweep'
                                : 'rainbow welcome sweep (partial — flaky radio)');
          }
          if (st) {
            await this._exec(st);
            log(this.name, 'synced on connect');
          } else if (greet && prev.on) {
            // no sync: give the lamp back its pre-greeting state
            await this._exec({ on: true, col: prev.rgb, bri: Math.round(prev.bri * 2.55) });
          }
        } catch (e) {
          // half-applied greet/sync = bastard state -> force a clean reconnect
          log(this.name, 'connect greet/sync failed:', e && e.message || e, '-> reconnect');
          this.ok = false;
          continue;
        }
      }
      backoff = 3000;
      const cmd = await this.q.pop(9000);
      if (this.stopped || cmd === null) break;
      if (cmd === Q_TIMEOUT) {
        try { await this._heartbeat(); }
        catch (e) { log(this.name, 'heartbeat lost -> reconnect'); this.ok = false; }
        continue;
      }
      if (cmd && cmd.__type === 'status') {
        try { cmd.resolve(await this._status()); }
        catch (e) { cmd.resolve({ error: String(e && e.message || e) }); this.ok = false; }
        continue;
      }
      if (cmd && cmd.__type === 'snap') {
        cmd.resolve(this.trackedState());
        continue;
      }
      try {
        await this._exec(cmd);
      } catch (e) {
        log(this.name, 'error:', e && e.message || e, '-> reconnect + retry');
        this.ok = false;
        try {
          if (await this._connect()) await this._exec(cmd);
        } catch (e2) {
          log(this.name, 'retry failed:', e2 && e2.message || e2);
          this.ok = false;
        }
      }
    }
  }
}

// --------------------------------------------------------------- TuyaLamp ---

function defaultTuyaFactory(conf, ip) {
  // Lazy require so an injected mock factory (tests) never touches tuyapi.
  const TuyAPI = require('tuyapi');
  return new TuyAPI({
    id: conf.device_id,
    key: conf.local_key,
    ip,
    version: '3.5',
    // find: false semantics — IPs come from the config, never from UDP discovery
    issueGetOnConnect: false,
    issueRefreshOnConnect: false,
  });
}

class TuyaLamp extends BaseLamp {
  // Persistent tuyapi socket. IPs come from config (ips{subnet: ip} + last).
  constructor(conf, state, deviceFactory) {
    super(conf, state);
    this.deviceFactory = deviceFactory || defaultTuyaFactory;
    this.dev = null;
  }

  _resolveIp() {
    const ips = this.c.ips || {};
    const last = this.c.last;
    if (last && ips[last]) return ips[last];
    const vals = Object.values(ips);
    return vals.length ? vals[0] : null;
  }

  _teardown() {
    const d = this.dev;
    this.dev = null;
    if (d) { try { d.disconnect(); } catch (e) { /* best effort */ } }
  }

  async _connect() {
    this.ok = false;
    this._teardown();
    const ip = this._resolveIp();
    if (!ip) return false;
    const d = this.deviceFactory(this.c, ip);
    // tuyapi emits 'error' events — unhandled, they crash the process.
    d.on('error', (e) => log(this.name, 'device error:', e && e.message || e));
    d.on('disconnected', () => { if (this.dev === d) this.ok = false; });
    await withTimeout(d.connect(), 5000, 'connect');
    const st = await withTimeout(d.get({}), 5000, 'status');
    const dps = (st && typeof st === 'object' && st.dps) ? st.dps : {};
    if (!dps || !Object.keys(dps).length) {
      try { d.disconnect(); } catch (e) { /* ignore */ }
      return false;
    }
    this.bri = curBriPct(dps);
    this.isOn = dps['20'] === undefined ? true : Boolean(dps['20']);
    // also recover the REAL color (DP24 = HHHH SSSS VVVV): without it, after a
    // reconnect the rgb tracking fell back to the default -> wrong snapshots
    const cd = dps['24'];
    if (typeof cd === 'string' && cd.length >= 12) {
      const h = parseInt(cd.slice(0, 4), 16) / 360.0;
      const s = parseInt(cd.slice(4, 8), 16) / 1000.0;
      if (!Number.isNaN(h) && !Number.isNaN(s)) {
        const [r, g, b] = hsvToRgb01(h % 1.0, Math.min(1, s), 1.0);
        this.rgb = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
      }
    }
    this.dev = d;
    this.ok = true;
    log(this.name, 'connected @', ip, 'bri:', this.bri, 'on:', this.isOn);
    return true;
  }

  async _heartbeat() {
    // tuyapi pings the socket internally; here we just verify the session is
    // still alive. A dead socket -> throw -> reconnect (same rule as Python).
    if (!this.dev || (this.dev.isConnected && !this.dev.isConnected())) {
      throw new Error('socket down');
    }
  }

  async _dps(caps) {
    // EXPLICIT multi-DP send in ONE packet, ACKED (shouldWaitForResponse):
    // blind sends silently lost commands in bursts on the Python engine
    // (2026-07-03) — an empty/failed response = zombie 3.5 session (TCP alive
    // but the lamp drops our packets) -> treat as failure -> reconnect.
    const out = {};
    for (const [k, v] of Object.entries(caps)) {
      const dp = DPS[k];
      if (dp) out[dp] = v;
    }
    if (!Object.keys(out).length) return;
    if (!this.dev) throw new Error('not connected');
    const r = await withTimeout(
      this.dev.set({ multiple: true, data: out, shouldWaitForResponse: true }),
      5000, 'set_multiple');
    if (r && typeof r === 'object' && r.Error) {
      throw new Error('set multiple: ' + r.Error);
    }
    if (!r) {
      // empty response = half-dead 3.5 session: socket lives but the lamp
      // drops our packets without replying. Empty = failure -> reconnect.
      throw new Error('empty response (dead session?)');
    }
  }

  async _colour(r, g, b) {
    await this._dps({ switch: true, mode: 'colour', colour: rgbToHsvHex(r, g, b) });
    this.isOn = true;
  }

  async _fadeTo(rgbTarget, pctTarget, durMs) {
    // tt EMULATED (native on WLED): step interpolation on the persistent
    // socket. MAX ~4 acked steps/s: at ~10/s the lamp firmware chokes and
    // drops the session mid-fade (measured 2026-07-03). Max 12 steps.
    const steps = Math.max(2, Math.min(12, Math.floor(durMs / 250)));
    const [r0, g0, b0] = this.rgb;
    const p0 = this.bri;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      // tracking updated at EVERY step: a crash mid-fade leaves exact state
      // (before: frozen bri/rgb -> wrong snapshots after an incident)
      this.rgb = [Math.round(r0 + (rgbTarget[0] - r0) * f),
                  Math.round(g0 + (rgbTarget[1] - g0) * f),
                  Math.round(b0 + (rgbTarget[2] - b0) * f)];
      this.bri = Math.round(p0 + (pctTarget - p0) * f);
      const [r, g, b] = scale(this.rgb, this.bri);
      await this._dps({ switch: true, mode: 'colour', colour: rgbToHsvHex(r, g, b) });
      if (i < steps) await sleep(Math.max(250, durMs / steps));
    }
    this.rgb = [...rgbTarget];
    this.bri = pctTarget;
    this.isOn = true;
  }

  async _apply(st) {
    // WLED-compatible state patch (OLS.md) translated to Tuya DPs.
    // Omitted fields = unchanged, like WLED.
    if ('nl' in st) {                                   // nightlight = countdown DP26
      const nl = st.nl || {};
      await this._dps({ timer: nl.on ? (parseInt(nl.dur || 0, 10) * 60) : 0 });
    }
    if (st.music) {                                     // extension
      await this._dps({ switch: true, mode: 'music' });
      this.isOn = true;
      return;
    }
    if ('scene' in st) {                                // extension: named scene
      const data = (this.c.scenes || {})[st.scene];
      if (data) {
        await this._dps({ switch: true, mode: 'scene', scene: data });
        this.isOn = true;
      }
      return;
    }
    if ('ps' in st) {                                   // preset -> stored scene
      await this._dps({ switch: true, mode: 'scene' });
      this.isOn = true;
      return;
    }
    if ('cct' in st) {                                  // warm<->cold white (0-255)
      const bri = st.bri;
      const pct = bri !== undefined && bri !== null ? Math.round(bri / 2.55) : this.bri;
      this.bri = clamp(pct, 1, 100);
      await this._dps({ switch: true, mode: 'white',
        brightness: Math.max(10, this.bri * 10),
        colourtemp: clamp(Math.round(st.cct / 255 * 1000), 0, 1000) });
      this.isOn = true;
      return;
    }
    const rgb = st.col ? st.col.slice(0, 3) : null;
    const bri = st.bri;
    const pct = bri !== undefined && bri !== null ? clamp(Math.round(bri / 2.55), 1, 100) : null;
    if (rgb || pct !== null) {
      const tt = st.tt;
      const tgtRgb = rgb || this.rgb;
      const tgtPct = pct !== null ? pct : this.bri;
      if (tt) {
        await this._fadeTo(tgtRgb, tgtPct, parseInt(tt, 10) * 100); // tt in x100 ms (WLED)
      } else {
        this.bri = tgtPct;
        const [r, g, b] = scale(tgtRgb, tgtPct);
        await this._colour(r, g, b);
        this.rgb = [...tgtRgb];
      }
    }
    if ('on' in st) {
      let v = st.on;
      if (v === 't') v = !this.isOn;
      await this._dps({ switch: Boolean(v) });
      this.isOn = Boolean(v);
    }
  }

  async _status() {
    // With acked sends (tuyapi shouldWaitForResponse) the ack buffer doesn't
    // pile up like tinytuya nowait mode did — a single fresh read suffices.
    const st = await withTimeout(this.dev.get({}), 5000, 'status');
    return (st && typeof st === 'object' && st.dps) ? st.dps : {};
  }

  async _exec(cmd) {
    if (typeof cmd === 'object' && cmd !== null) {      // syntax v2: WLED state patch
      await this._apply(cmd);
      return;
    }
    if (cmd === 'blackout') {                           // dark + remember prior state
      this.saved = this.trackedState();
      await this._dps({ switch: false });
      this.isOn = false;
      return;
    }
    if (cmd === 'restore') {                            // replay pre-blackout state
      const s = this.saved || {};
      if (s.on !== false) {
        this.bri = s.bri !== undefined ? s.bri : this.bri;
        this.rgb = s.rgb ? [...s.rgb] : this.rgb;
        const [r, g, b] = scale(this.rgb, this.bri);
        await this._colour(r, g, b);
      }
      return;
    }
    if (cmd === 'off') {
      await this._dps({ switch: false });
      this.isOn = false;
      return;
    }
    if (cmd === 'on') {
      await this._dps({ switch: true });
      this.isOn = true;
      return;
    }
    if (cmd === 'toggle') {                             // toggle (idea from the WLED plugin)
      await this._dps({ switch: !this.isOn });
      this.isOn = !this.isOn;
      return;
    }
    if (cmd.startsWith('wled:')) {                      // WLED-specific: skip
      return;
    }
    if (cmd.startsWith('set:')) {                       // ADVANCED: color + intensity
      const [, cname, pctStr] = cmd.split(':');
      const pct = clamp(parseInt(pctStr, 10), 1, 100);
      this.bri = pct;
      this.rgb = [...(COLORS[cname] || COLORS.bleu)];
      const [r, g, b] = scale(this.rgb, pct);
      await this._colour(r, g, b);
      return;
    }
    if (cmd.startsWith('white:')) {                     // white: intensity + temperature
      const [, briStr, tempStr] = cmd.split(':');
      this.bri = clamp(parseInt(briStr, 10), 1, 100);
      await this._dps({ switch: true, mode: 'white',
        brightness: Math.max(10, this.bri * 10),
        colourtemp: clamp(parseInt(tempStr, 10) * 10, 0, 1000) });
      this.isOn = true;
      return;
    }
    if (cmd.startsWith('scene:')) {                     // NAMED captured scene (config)
      const sname = cmd.split(':').slice(1).join(':');
      const data = (this.c.scenes || {})[sname];
      if (data) {
        await this._dps({ switch: true, mode: 'scene', scene: data });
        this.isOn = true;
      } else {
        log(this.name, 'unknown scene:', sname, '- capture it first');
      }
      return;
    }
    if (cmd.startsWith('countdown:')) {                 // off timer (minutes)
      await this._dps({ timer: Math.max(0, parseInt(cmd.split(':')[1], 10)) * 60 });
      return;
    }
    if (cmd.startsWith('preset:')) {                    // common: Tuya replays ITS scene
      await this._dps({ switch: true, mode: 'scene' }); // (the N only matters on WLED)
      this.isOn = true;
      return;
    }
    if (cmd.startsWith('mode:')) {                      // raw Tuya app modes (DP21)
      await this._dps({ switch: true, mode: cmd.split(':')[1] });
      this.isOn = true;
      return;
    }
    if (cmd in COLORS) {                                // color: keep intensity
      this.rgb = [...COLORS[cmd]];
      const [r, g, b] = scale(COLORS[cmd], this.bri);
      await this._colour(r, g, b);
      return;
    }
    let pct = PALIERS[cmd];
    if (pct === undefined && cmd.startsWith('bri:')) {
      pct = clamp(parseInt(cmd.split(':')[1], 10), 1, 100);
    }
    if (pct !== undefined) {                            // intensity: keep color
      this.bri = pct;
      const color = this.state.color || 'bleu';
      this.rgb = [...(COLORS[color] || COLORS.bleu)];
      const [r, g, b] = scale(this.rgb, pct);
      await this._colour(r, g, b);
      return;
    }
    log(this.name, 'unknown command:', cmd);
  }
}

// --------------------------------------------------------------- WledLamp ---

class WledLamp extends BaseLamp {
  /* EXPERIMENTAL — lamps/strips running WLED firmware (ESP32), local HTTP JSON
   * API. Never executed on real hardware. Config:
   * {"name": "...", "type": "wled", "host": "192.168.x.y"}. */
  async _post(payload) {
    const res = await fetch(`http://${this.c.host}/json/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    await res.arrayBuffer();
  }

  async _connect() {
    try {
      const res = await fetch(`http://${this.c.host}/json/info`,
                              { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer();
      this.ok = true;
      log(this.name, '(WLED) connected @', this.c.host);
      return true;
    } catch (e) {
      this.ok = false;
      return false;
    }
  }

  async _heartbeat() {
    const res = await fetch(`http://${this.c.host}/json/info`,
                            { signal: AbortSignal.timeout(2000) });
    await res.arrayBuffer();
  }

  async _status() {
    const res = await fetch(`http://${this.c.host}/json/state`,
                            { signal: AbortSignal.timeout(2000) });
    return res.json();
  }

  _seg(seg) {
    // config "segment": N -> this "lamp" only drives one zone of the strip
    if ('segment' in this.c) seg.id = this.c.segment;
    return seg;
  }

  _payload(p) {
    // config "transition": N -> fade (x100 ms) applied to every command
    if ('transition' in this.c && p.tt === undefined) p.tt = this.c.transition;
    return p;
  }

  async _apply(st) {
    // syntax v2 = the WLED API: quasi-passthrough
    const p = {};
    const seg = {};
    for (const k of ['on', 'bri', 'tt', 'ps', 'nl']) if (k in st) p[k] = st[k];
    for (const k of ['fx', 'sx', 'ix', 'pal', 'cct']) if (k in st) seg[k] = st[k];
    if (st.col) seg.col = [st.col.slice(0, 3)];
    if (Object.keys(seg).length) p.seg = [this._seg(seg)];
    if (!Object.keys(p).length) return;
    await this._post(this._payload(p));
    if ('on' in st && st.on !== 't') this.isOn = Boolean(st.on);
    else if (Object.keys(seg).length || 'bri' in st) this.isOn = true;
    if (st.col) this.rgb = st.col.slice(0, 3);
    if ('bri' in st) this.bri = clamp(Math.round(st.bri / 2.55), 1, 100);
  }

  async _exec(cmd) {
    if (typeof cmd === 'object' && cmd !== null) {      // syntax v2: WLED state patch
      await this._apply(cmd);
      return;
    }
    if (cmd === 'blackout') {
      this.saved = this.trackedState();
      await this._post({ on: false });
      this.isOn = false;
      return;
    }
    if (cmd === 'restore') {
      const s = this.saved || {};
      if (s.on !== false) {
        this.bri = s.bri !== undefined ? s.bri : this.bri;
        this.rgb = s.rgb ? [...s.rgb] : this.rgb;
        await this._post(this._payload({ on: true, bri: Math.round(this.bri * 2.55),
          seg: [this._seg({ col: [[...this.rgb]] })] }));
        this.isOn = true;
      }
      return;
    }
    if (cmd === 'off') {
      await this._post(this._payload({ on: false }));
      this.isOn = false;
      return;
    }
    if (cmd === 'on') {
      await this._post(this._payload({ on: true }));
      this.isOn = true;
      return;
    }
    if (cmd === 'toggle') {
      await this._post(this._payload({ on: 't' }));     // "t" = native WLED toggle
      this.isOn = !this.isOn;
      return;
    }
    if (cmd.startsWith('set:')) {                       // advanced: color + intensity
      const [, cname, pctStr] = cmd.split(':');
      const [r, g, b] = COLORS[cname] || COLORS.bleu;
      this.bri = clamp(parseInt(pctStr, 10), 1, 100);
      await this._post(this._payload({ on: true, bri: Math.round(this.bri * 2.55),
        seg: [this._seg({ col: [[r, g, b]] })] }));
      this.isOn = true;
      return;
    }
    if (cmd.startsWith('preset:')) {                    // common: WLED has 250 presets
      await this._post(this._payload({ ps: parseInt(cmd.split(':')[1], 10) }));
      this.isOn = true;
      return;
    }
    if (cmd.startsWith('wled:fx:')) {                   // animated effect: fx[:sx[:ix[:pal]]]
      const parts = cmd.split(':').slice(2);
      const fx = ['~', '~-', 'r'].includes(parts[0]) ? parts[0] : parseInt(parts[0], 10);
      const seg = this._seg({ fx });
      const keys = ['sx', 'ix', 'pal'];
      parts.slice(1).forEach((v, i) => { if (i < keys.length) seg[keys[i]] = parseInt(v, 10); });
      await this._post(this._payload({ on: true, seg: [seg] }));
      this.isOn = true;
      return;
    }
    if (cmd.startsWith('wled:psave:')) {                // save current state as preset N
      await this._post({ psave: parseInt(cmd.split(':')[2], 10) });
      return;
    }
    if (cmd.startsWith('mode:')) {
      log(this.name, '(WLED) Tuya modes not applicable — use WLED presets');
      return;
    }
    if (cmd in COLORS) {
      const [r, g, b] = COLORS[cmd];
      await this._post(this._payload({ on: true, seg: [this._seg({ col: [[r, g, b]] })] }));
      this.isOn = true;
      return;
    }
    let pct = PALIERS[cmd];
    if (pct === undefined && cmd.startsWith('bri:')) {
      pct = clamp(parseInt(cmd.split(':')[1], 10), 1, 100);
    }
    if (pct !== undefined) {
      this.bri = pct;
      await this._post(this._payload({ on: true, bri: Math.round(pct * 2.55) }));
      this.isOn = true;
    }
  }
}

function makeLamp(conf, state, deviceFactory) {
  return conf.type === 'wled' ? new WledLamp(conf, state)
                              : new TuyaLamp(conf, state, deviceFactory);
}

// -------------------------------------------------------------- local API ---

function createApi(engine, port) {
  /* LOCAL front door (architecture principle): a Tuya lamp accepts a single
   * local connection — held by this process. Every other frontend (CLI,
   * Bome "Execute file", macOS shortcuts, scripts…) goes THROUGH the engine.
   * 127.0.0.1 only, never exposed to the network.
   *
   *   GET  /cmd?c=<command>[&lamps=L1,L2] -> {"ok": bool, "targets": [...]}
   *   GET  /status[?full=1]               -> {"L1": {"connected","on","bri"}, ...}
   *   GET  /syntax                        -> machine-readable OLS contract
   *   GET  /json/state                    -> aggregated WLED-style state
   *   POST /json/state[?lamps=...]        -> apply an OLS patch (WLED-compat)
   */
  const server = http.createServer((req, res) => {
    const reply = (body, code = 200) => {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(code, { 'Content-Type': 'application/json',
                            'Content-Length': data.length });
      res.end(data);
    };
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); }
    catch (e) { res.writeHead(400); res.end(); return; }
    const lampsParam = (u.searchParams.get('lamps') || '').split(',').filter(Boolean);

    if (req.method === 'POST') {
      // WLED-compatible endpoint (OpenLamp State): a JSON state patch applies
      // to the targeted lamps (?lamps=..., empty = all).
      if (u.pathname !== '/json/state') { res.writeHead(404); res.end(); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let st;
        try {
          st = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          if (typeof st !== 'object' || st === null || Array.isArray(st)) throw new Error('not a dict');
        } catch (e) {
          reply({ error: 9 }, 400);
          return;
        }
        const ok = engine.dispatch(st, { lamps: lampsParam });
        reply({ success: Boolean(ok) });                // same response as WLED
      });
      return;
    }

    if (req.method !== 'GET') { res.writeHead(404); res.end(); return; }

    if (u.pathname === '/json/state') {
      // aggregated WLED-style state + per-lamp detail as an extension
      const first = engine.lamps[0];
      reply({
        on: engine.lamps.some((l) => l.isOn),
        bri: Math.round((first ? first.bri : 60) * 2.55),
        lamps: Object.fromEntries(engine.lamps.map((l) => [l.name, l.trackedState()])),
      });
      return;
    }
    if (u.pathname === '/cmd' && u.searchParams.get('c')) {
      const cmd = u.searchParams.get('c');
      const settings = { lamps: lampsParam };
      const ok = engine.dispatch(cmd, settings);
      const targets = engine.targets(settings).map((l) => l.name);
      log('api /cmd:', cmd, '->', targets.join(',') || '-');
      reply({ ok, cmd, targets });
      return;
    }
    if (u.pathname === '/syntax') {
      // public contract of syntax v2 (see OLS.md)
      reply({
        version: SYNTAX_VERSION,
        base: 'WLED /json/state (patch : champs omis = inchanges)',
        keys: ['on', 'bri', 'col', 'cct', 'ps', 'tt', 'nl', 'fx', 'sx', 'ix', 'pal'],
        extensions: ['scene', 'music'],
        commands: ['blackout', 'restore', 'snap:save:<nom>', 'snap:<nom>'],
        aliases: ['<couleur>', '<palier>', 'bri:N', 'set:c:p', 'white:b:t',
                  'scene:nom', 'preset:N', 'mode:music', 'countdown:min',
                  'wled:fx:...', 'on', 'off', 'toggle'],
      });
      return;
    }
    if (u.pathname === '/status') {
      const body = Object.fromEntries(engine.lamps.map((l) => [l.name, {
        connected: l.ok, on: l.isOn, bri: l.bri, type: l.c.type || 'tuya',
      }]));
      if (!u.searchParams.get('full')) { reply(body); return; }
      // PHYSICAL re-read through the persistent connections (FIFO, hence after
      // any queued commands) — debug + tests
      Promise.all(engine.lamps.map((l) =>
        withTimeout(l.statusRequest(), 8000, l.name)
          .then((dps) => { body[l.name].dps = dps; })
          .catch(() => {})
      )).then(() => reply(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (e) => log(`local API unavailable (port ${port}):`, e.message));
  server.listen(port, '127.0.0.1', () => log(`local API ready on 127.0.0.1:${port}`));
  return server;
}

// ------------------------------------------------------------------ Engine --

class Engine {
  /* OpenLamp engine host: owns the lamps (persistent connections), the
   * dispatcher, groups, snapshots, animations, sync and the local API.
   * Frontend-agnostic — the only upward link is the on_change hook. */
  constructor(opts = {}) {
    this.configPath = opts.configPath || process.env.OPENLAMP_CONFIG
                      || path.join(__dirname, 'tuya-lamps.json');
    this.apiPort = opts.port || API_PORT;
    this.deviceFactory = opts.deviceFactory || null;
    this.cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    if (!this.cfg.state) this.cfg.state = { color: 'bleu' };
    this.state = this.cfg.state;
    this.lamps = [];
    this.anims = new Map();   // lamp name -> stop() of the running animation
    this.on_change = null;    // frontend hook, called ~1.5 s after a dispatch
    this._dirty = false;
    this._startLamps();
    this.server = createApi(this, this.apiPort); // CLI / MIDI / Bome front door
    // deferred config save: writing to a File-Provider-backed folder (Google
    // Drive) can block for seconds -> keep it OUT of the keypress critical path
    this._saverTimer = setInterval(() => {
      if (!this._dirty) return;
      this._dirty = false;
      try { fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2)); }
      catch (e) { log('config save failed:', e.message); }
    }, 2000);
    if (this._saverTimer.unref) this._saverTimer.unref();
  }

  _startLamps() {
    for (const l of this.lamps) { l.stopped = true; l.q.push(null); }
    this.lamps = (this.cfg.lamps || []).map((c) => makeLamp(c, this.state, this.deviceFactory));
    for (const l of this.lamps) {
      l.engine = this;             // for connect-time sync
      l.start();
    }
  }

  syncPatch(lamp) {
    /* Multi-lamp sync (global "sync" config param): when a lamp connects,
     * align it — with the state of ALREADY-connected lamps if any (rejoining
     * mid-set), else with the configured default state. The group stays
     * coherent. Config: "sync": {"enabled": true, "state": {...OLS patch}}. */
    const sync = this.cfg.sync || {};
    if (!sync.enabled) return null;
    const others = this.lamps.filter((l) => l !== lamp && l.ok);
    if (others.length) {
      const o = others[0];
      return { on: o.isOn, col: [...o.rgb], bri: Math.round(o.bri * 2.55) };
    }
    const st = sync.state;
    return (st && typeof st === 'object') ? { ...st } : null;
  }

  _sceneNames() {
    const names = new Set();
    for (const l of this.lamps) for (const n of Object.keys(l.c.scenes || {})) names.add(n);
    return [...names].sort();
  }

  // ----- engine animations (cycle / flash / tempo) -----
  _stopAnims(tgts) {
    for (const l of tgts) {
      const stop = this.anims.get(l.name);
      if (stop) { this.anims.delete(l.name); stop(); }
    }
  }

  _startAnim(tgts, stopFn) {
    this._stopAnims(tgts);
    for (const l of tgts) this.anims.set(l.name, stopFn);
  }

  _animCmd(cmd, settings) {
    /* cycle:c1,c2[,..][@ms] | flash:couleur[@ms] | tempo:bpm | animstop.
     * Rates are capped: the lamp firmware drops the session beyond
     * ~4 acked commands/s (measured 2026-07-03). */
    const tgts = this.targets(settings);
    if (cmd === 'animstop') { this._stopAnims(tgts); return true; }
    if (cmd.startsWith('cycle:')) {
      const [cols, ms] = splitOnce(cmd.slice(6), '@');
      const colors = cols.split(',').filter((c) => c in COLORS);
      const list = colors.length ? colors : ['jaune', 'bleu'];
      const interval = Math.max(400, parseInt(ms || '800', 10));
      let i = 0;
      const tick = () => {
        const col = COLORS[list[i % list.length]];
        for (const l of tgts) l.q.push({ col: [...col] });
        i += 1;
      };
      tick();                                  // first color immediately (like Python)
      const t = setInterval(tick, interval);
      if (t.unref) t.unref();
      this._startAnim(tgts, () => clearInterval(t));
      return tgts.length > 0 && tgts.every((l) => l.ok);
    }
    if (cmd.startsWith('flash:')) {
      const [cname, ms] = splitOnce(cmd.slice(6), '@');
      const dur = Math.max(150, parseInt(ms || '300', 10));
      const col = [...(COLORS[cname] || [255, 255, 255])];
      const saved = Object.fromEntries(tgts.map((l) => [l.name, l.trackedState()]));
      for (const l of tgts) l.q.push({ col, bri: 255 });
      let cancelled = false;
      const t = setTimeout(() => {
        if (cancelled) return;
        for (const l of tgts) {                // back to the pre-flash state
          const s = saved[l.name];
          l.q.push(s.on ? { on: true, col: s.rgb, bri: Math.round(s.bri * 2.55) }
                        : { on: false });
        }
      }, dur);
      if (t.unref) t.unref();
      this._startAnim(tgts, () => { cancelled = true; clearTimeout(t); });
      return tgts.length > 0 && tgts.every((l) => l.ok);
    }
    if (cmd.startsWith('tempo:')) {
      const bpm = clamp(parseInt(cmd.split(':')[1], 10) || 100, 20, 120);
      const beat = 60000.0 / bpm;
      let stopped = false;
      let t = null;
      let phase = 0;
      const step = () => {
        if (stopped) return;
        if (phase === 0) {
          for (const l of tgts) l.q.push({ bri: 255 }); // pulse on the beat
          t = setTimeout(step, beat * 0.3);
        } else {
          for (const l of tgts) l.q.push({ bri: 50 });
          t = setTimeout(step, beat * 0.7);
        }
        if (t.unref) t.unref();
        phase ^= 1;
      };
      step();
      this._startAnim(tgts, () => { stopped = true; if (t) clearTimeout(t); });
      return tgts.length > 0 && tgts.every((l) => l.ok);
    }
    return false;
  }

  targets(settings) {
    /* Targeted lamps. settings.lamps = lamp OR GROUP names; empty = all.
     * Groups live in the config: "groups": {"front": ["L1"], ...}. */
    const names = (settings || {}).lamps || [];
    if (!names.length) return this.lamps;
    const groups = this.cfg.groups || {};
    const expanded = [];
    for (const n of names) expanded.push(...(groups[n] || [n]));
    return this.lamps.filter((l) => expanded.includes(l.name));
  }

  dispatch(cmd, settings) {
    // syntax v2: a WLED-compatible JSON state patch passes through as-is
    if (typeof cmd === 'string' && cmd.startsWith('{')) {
      try { cmd = JSON.parse(cmd); }
      catch (e) { log('invalid JSON patch:', e.message); return false; }
    }
    // snapshots: photo/recall of every targeted lamp's state
    if (typeof cmd === 'string' && cmd.startsWith('snap:')) {
      if (cmd.startsWith('snap:save:')) {
        // capture THROUGH each lamp's queue: guarantees photographing the
        // state AFTER in-flight commands (a running fade, etc.)
        const name = cmd.split(':').slice(2).join(':');
        const tgts = this.targets(settings);
        const holder = {};
        Promise.all(tgts.map((l) =>
          withTimeout(l.snapRequest(), 30000, l.name)
            .then((s) => { holder[l.name] = s; })
            .catch(() => {})
        )).then(() => {
          if (!this.cfg.snapshots) this.cfg.snapshots = {};
          this.cfg.snapshots[name] = holder;
          this._dirty = true;
          log(`snapshot '${name}' saved (${Object.keys(holder).length} lamps)`);
        });
        return true;
      }
      const name = cmd.split(':').slice(1).join(':');
      const snap = (this.cfg.snapshots || {})[name];
      if (!snap) { log('unknown snapshot:', name); return false; }
      const tgts = this.targets(settings);
      this._stopAnims(tgts);
      for (const l of tgts) {
        const s = snap[l.name];
        if (!s) continue;
        if (s.on !== false) {
          l.q.push({ on: true, col: s.rgb,
                     bri: Math.round((s.bri !== undefined ? s.bri : 60) * 2.55) });
        } else {
          l.q.push({ on: false });
        }
      }
      return tgts.length > 0 && tgts.every((l) => l.ok);
    }
    if (typeof cmd === 'string' &&
        (cmd === 'animstop' || cmd.startsWith('cycle:') ||
         cmd.startsWith('flash:') || cmd.startsWith('tempo:'))) {
      return this._animCmd(cmd, settings);
    }
    const tgts = this.targets(settings);
    this._stopAnims(tgts);        // any normal command kills the running animation
    if (typeof cmd === 'string') {
      if (cmd in COLORS) this.state.color = cmd;
      else if (cmd.startsWith('set:')) this.state.color = cmd.split(':')[1]; // remember color too
    }
    for (const l of tgts) l.q.push(cmd);
    // frontend hook (e.g. refresh Status keys) ~1.5 s later, once the queued
    // commands have run. Only engine -> frontend link.
    const cb = this.on_change;
    if (cb) {
      const t = setTimeout(cb, 1500);
      if (t.unref) t.unref();
    }
    // NO config save here: the deferred saver persists in the background
    // (every 2 s when dirty) — see constructor.
    this._dirty = true;
    return tgts.length > 0 && tgts.every((l) => l.ok);
  }

  stop() {
    // clean teardown (tests + graceful daemon exit)
    this._stopAnims(this.lamps);
    for (const l of this.lamps) {
      l.stopped = true;
      l.q.push(null);
      if (l._teardown) l._teardown();
    }
    clearInterval(this._saverTimer);
    if (this.server) this.server.close();
  }
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

module.exports = {
  Engine, TuyaLamp, WledLamp, BaseLamp, makeLamp, createApi,
  COLORS, COLOR_ORDER, PALIERS, DPS, scale, curBriPct, rgbToHsvHex, hsvToRgb01,
  API_PORT, SYNTAX_VERSION, log,
};

// ------------------------------------------------------------------ daemon --

if (require.main === module) {
  /* daemon mode — run the engine WITHOUT any frontend (equivalent of daemon.py).
   * RULE — run ONE host at a time: this daemon and the Python plugin/daemon all
   * own the single local connection each Tuya lamp allows, and all bind 8377. */
  log('daemon: starting engine (headless)');
  const eng = new Engine();
  log(`daemon: engine up — local API on 127.0.0.1:${eng.apiPort}`);
  const keepAlive = setInterval(() => {}, 3600 * 1000); // survives even if the port is busy
  const bye = () => { log('daemon: stopping'); clearInterval(keepAlive); eng.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
