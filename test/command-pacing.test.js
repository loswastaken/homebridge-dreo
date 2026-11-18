// Tests for per-device command pacing, merging and confirmation (upstream issues #152 and #154).
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const util = require('node:util');
const CommandQueue = require('../dist/CommandQueue').default;
const { validateCommandQueueOptions } = require('../dist/CommandQueue');
const DreoAPI = require('../dist/DreoAPI').default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Short timings so the suite runs quickly
const INTERVAL = 120;
const COALESCE = 30;
const CONFIRM = 300;

// Waits for a condition instead of sleeping a fixed time, so tests aren't flaky under load
async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(5);
  }
  return false;
}

// A queue with a capturing send. Confirmation is off unless a test asks for it.
function makeQueue(t, options = {}) {
  const sent = [];
  const warns = [];
  const log = { ...silentLog, warn: (...args) => warns.push(util.format(...args)) };
  const queue = new CommandQueue((sn, params) => sent.push({ at: Date.now(), sn, params }), log, {
    commandIntervalMs: INTERVAL,
    commandCoalesceMs: COALESCE,
    commandConfirmTimeoutMs: 0,
    ...options,
  });
  t.after(() => queue.stop());
  return { queue, sent, warns };
}

test('a single command is sent once with exactly the caller\'s params', async (t) => {
  const { queue, sent } = makeQueue(t);
  const start = Date.now();
  queue.enqueue('SN1', { fanon: true });

  assert.ok(await waitFor(() => sent.length === 1));
  assert.deepStrictEqual(sent[0].params, { fanon: true });
  assert.strictEqual(sent[0].sn, 'SN1');
  assert.ok(sent[0].at - start >= COALESCE - 1, 'waits for the merge window');
  assert.ok(sent[0].at - start < INTERVAL + 200, 'is not held back');

  await sleep(INTERVAL + 50);
  assert.strictEqual(sent.length, 1);
});

test('a scene burst to one device is merged into one command', async (t) => {
  const { queue, sent } = makeQueue(t);
  queue.enqueue('SN1', { fanon: true });
  queue.enqueue('SN1', { fanon: true, windlevel: 4 });
  queue.enqueue('SN1', { oscon: true });

  assert.ok(await waitFor(() => sent.length === 1));
  await sleep(INTERVAL + 50);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].params, { fanon: true, windlevel: 4, oscon: true });
});

test('light and fan writes are sent separately, light first, spaced by the interval', async (t) => {
  const { queue, sent } = makeQueue(t);
  queue.enqueue('SN1', { lighton: true, brightness: 50 });
  queue.enqueue('SN1', { fanon: true });

  assert.ok(await waitFor(() => sent.length === 2));
  assert.deepStrictEqual(sent[0].params, { lighton: true, brightness: 50 });
  assert.deepStrictEqual(sent[1].params, { fanon: true });
  assert.ok(sent[1].at - sent[0].at >= INTERVAL - 1, `spacing ${sent[1].at - sent[0].at}ms`);
});

test('writes outside the merge window are sent in order, spaced by the interval', async (t) => {
  const { queue, sent } = makeQueue(t);
  queue.enqueue('SN1', { fanon: true });
  await sleep(COALESCE + 20);
  queue.enqueue('SN1', { oscon: true });
  await sleep(COALESCE + 20);
  queue.enqueue('SN1', { windlevel: 2 });

  assert.ok(await waitFor(() => sent.length === 3));
  assert.deepStrictEqual(sent.map((s) => s.params), [{ fanon: true }, { oscon: true }, { windlevel: 2 }]);
  assert.ok(sent[1].at - sent[0].at >= INTERVAL - 1, `spacing ${sent[1].at - sent[0].at}ms`);
  assert.ok(sent[2].at - sent[1].at >= INTERVAL - 1, `spacing ${sent[2].at - sent[1].at}ms`);
});

test('a burst to one device does not delay another device', async (t) => {
  const { queue, sent } = makeQueue(t);
  const start = Date.now();
  queue.enqueue('A', { fanon: true });
  queue.enqueue('A', { lighton: true });
  queue.enqueue('A', { fanon: true, lighton: true });
  queue.enqueue('B', { fanon: true });

  assert.ok(await waitFor(() => sent.filter((s) => s.sn === 'A').length === 3));
  const b = sent.filter((s) => s.sn === 'B');
  assert.strictEqual(b.length, 1);
  assert.ok(b[0].at - start < INTERVAL, `device B waited ${b[0].at - start}ms`);
  assert.ok(b[0].at < sent.filter((s) => s.sn === 'A')[1].at, 'B is sent before A\'s second command');
});

test('slider updates replace a pending value and only the final one is sent', async (t) => {
  // A longer interval keeps the batch pending for the whole slider drag, even under load
  const { queue, sent } = makeQueue(t, { commandIntervalMs: 400 });
  queue.enqueue('SN1', { fanon: true });
  assert.ok(await waitFor(() => sent.length === 1));

  // The device is now inside its interval, so these wait in one pending batch
  queue.enqueue('SN1', { windlevel: 1 });
  for (const level of [2, 3, 4]) {
    await sleep(COALESCE + 5);
    queue.enqueue('SN1', { windlevel: level });
  }

  assert.ok(await waitFor(() => sent.length === 2));
  await sleep(100);
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1].params, { windlevel: 4 });
});

test('interval 0 turns the queue off: immediate synchronous sends, no merging', (t) => {
  const { queue, sent } = makeQueue(t, { commandIntervalMs: 0, commandCoalesceMs: 0, commandConfirmTimeoutMs: CONFIRM });
  const first = { fanon: true };
  queue.enqueue('SN1', first);
  assert.strictEqual(sent.length, 1, 'sent before enqueue returns');
  assert.strictEqual(sent[0].params, first, 'the caller\'s own object');

  queue.enqueue('SN1', { fanon: true, windlevel: 4 });
  queue.enqueue('SN1', { oscon: true });
  assert.deepStrictEqual(sent.map((s) => s.params), [{ fanon: true }, { fanon: true, windlevel: 4 }, { oscon: true }]);
});

test('a control-report confirms the command and nothing is resent', async (t) => {
  const { queue, sent } = makeQueue(t, { commandConfirmTimeoutMs: CONFIRM });
  queue.enqueue('SN1', { fanon: true, windlevel: 3 });
  assert.ok(await waitFor(() => sent.length === 1));
  queue.handleMessage({ devicesn: 'SN1', method: 'control-reply', reported: { fanon: true, windlevel: 3 } });
  queue.handleMessage({ devicesn: 'SN1', method: 'control-report', reported: { windlevel: 3 } });

  await sleep(CONFIRM + INTERVAL + 100);
  assert.strictEqual(sent.length, 1);
});

test('a control-reply alone does not confirm: the command is resent exactly once', async (t) => {
  const { queue, sent, warns } = makeQueue(t, { commandConfirmTimeoutMs: CONFIRM });
  queue.enqueue('SN1', { fanon: true });
  assert.ok(await waitFor(() => sent.length === 1));
  queue.handleMessage({ devicesn: 'SN1', method: 'control-reply', reported: { fanon: true } });

  assert.ok(await waitFor(() => sent.length === 2));
  assert.ok(sent[1].at - sent[0].at >= CONFIRM - 1, 'resent after the timeout');
  assert.deepStrictEqual(sent[1].params, { fanon: true });

  // The resend is confirmed, so there is no warning
  queue.handleMessage({ devicesn: 'SN1', method: 'report', reported: { fanon: true } });
  await sleep(CONFIRM + INTERVAL + 100);
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(warns, []);
});

test('a newer write before the timeout cancels the resend', async (t) => {
  const { queue, sent } = makeQueue(t, { commandConfirmTimeoutMs: CONFIRM });
  queue.enqueue('SN1', { fanon: true });
  assert.ok(await waitFor(() => sent.length === 1));
  queue.enqueue('SN1', { windlevel: 3 });
  assert.ok(await waitFor(() => sent.length === 2));
  queue.handleMessage({ devicesn: 'SN1', method: 'control-report', reported: { windlevel: 3 } });

  await sleep(CONFIRM + INTERVAL + 100);
  assert.deepStrictEqual(sent.map((s) => s.params), [{ fanon: true }, { windlevel: 3 }]);
});

test('a resend is never resent, and an ignored resend warns once per device', async (t) => {
  const { queue, sent, warns } = makeQueue(t, { commandConfirmTimeoutMs: CONFIRM });
  queue.enqueue('SN1', { fanon: true });
  assert.ok(await waitFor(() => sent.length === 2));
  assert.ok(await waitFor(() => warns.length === 1));
  assert.strictEqual(warns[0], 'Dreo device SN1 did not confirm fanon after a resend');

  await sleep(CONFIRM + INTERVAL + 100);
  assert.strictEqual(sent.length, 2);

  // A second ignored command within 10 minutes is resent but not warned about again
  queue.enqueue('SN1', { oscon: true });
  assert.ok(await waitFor(() => sent.length === 4));
  await sleep(CONFIRM + 100);
  assert.strictEqual(warns.length, 1);
});

test('stop() drops queued commands, sends nothing afterwards and leaves no timers', async (t) => {
  const { queue, sent } = makeQueue(t, { commandConfirmTimeoutMs: CONFIRM });
  queue.enqueue('A', { fanon: true });
  assert.ok(await waitFor(() => sent.length === 1));
  queue.enqueue('A', { lighton: true });
  queue.enqueue('B', { fanon: true });
  queue.stop();
  queue.enqueue('A', { oscon: true });

  for (const device of queue.devices.values()) {
    assert.strictEqual(device.timer, undefined);
    assert.deepStrictEqual(device.awaiting, []);
    assert.deepStrictEqual(device.batches, []);
  }
  await sleep(CONFIRM + INTERVAL + 100);
  assert.strictEqual(sent.length, 1);
});

test('option validation: defaults, invalid values and the coalesce limit', () => {
  const check = (config) => {
    const warns = [];
    const options = validateCommandQueueOptions(config, { ...silentLog, warn: (...args) => warns.push(util.format(...args)) });
    return { options, warns };
  };
  const defaults = { commandIntervalMs: 600, commandCoalesceMs: 100, commandConfirmTimeoutMs: 3000 };

  assert.deepStrictEqual(check(undefined), { options: defaults, warns: [] });
  assert.deepStrictEqual(check({ name: 'Dreo Platform', options: {} }), { options: defaults, warns: [] });
  assert.deepStrictEqual(check({ commandIntervalMs: null }), { options: defaults, warns: [] });
  assert.deepStrictEqual(
    check({ commandIntervalMs: 1000, commandCoalesceMs: 0, commandConfirmTimeoutMs: 0 }).options,
    { commandIntervalMs: 1000, commandCoalesceMs: 0, commandConfirmTimeoutMs: 0 },
  );

  for (const [key, value] of [
    ['commandIntervalMs', 5001],
    ['commandIntervalMs', -1],
    ['commandIntervalMs', '600'],
    ['commandCoalesceMs', 2.5],
    ['commandConfirmTimeoutMs', 20000],
  ]) {
    const { options, warns } = check({ [key]: value });
    assert.deepStrictEqual(options, defaults, `${key}=${value}`);
    assert.strictEqual(warns.length, 1, `${key}=${value}`);
    assert.ok(warns[0].includes(key), warns[0]);
  }

  // The merge window is clamped to the interval; only an explicit value is warned about
  let result = check({ commandIntervalMs: 200, commandCoalesceMs: 500 });
  assert.strictEqual(result.options.commandCoalesceMs, 200);
  assert.strictEqual(result.warns.length, 1);
  assert.ok(result.warns[0].includes('commandCoalesceMs'));
  result = check({ commandIntervalMs: 0 });
  assert.deepStrictEqual(result.options, { commandIntervalMs: 0, commandCoalesceMs: 0, commandConfirmTimeoutMs: 3000 });
  assert.deepStrictEqual(result.warns, []);
});

test('DreoAPI.control sends a paced control message over the websocket', async (t) => {
  const api = new DreoAPI({ log: silentLog, config: { options: {} } });
  const messages = [];
  api.ws = { send: (data) => messages.push(data), stop: () => {} };
  t.after(() => api.stopWebSocket());

  api.control('SN1', { fanon: true });
  assert.strictEqual(messages.length, 0, 'held for the merge window');
  assert.ok(await waitFor(() => messages.length === 1));

  const message = JSON.parse(messages[0]);
  assert.strictEqual(message.deviceSn, 'SN1');
  assert.strictEqual(message.method, 'control');
  assert.deepStrictEqual(message.params, { fanon: true });
  assert.strictEqual(typeof message.timestamp, 'number');
  assert.deepStrictEqual(Object.keys(message), ['deviceSn', 'method', 'params', 'timestamp']);
});
