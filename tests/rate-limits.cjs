const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { patchRequestHandler } = require('../scripts/patch-discord.cjs');

const assetModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/assets.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { module: assetModule, exports: assetModule.exports, require, Buffer });
const policy = assetModule.exports.rejectLongAssetWait;
const handlerFile = path.join(path.dirname(require.resolve('discord.js-selfbot-v13/package.json')), 'src/rest/RequestHandler.js');
const handlerSource = fs.readFileSync(handlerFile, 'utf8');

function fixture(responses) {
  let now = 1700000000000;
  const sleeps = [];
  let calls = 0;
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(handlerSource, { module, exports: module.exports, Date: Clock,
    require: (name) => {
      if (name === 'node:timers/promises') return { setTimeout: async (ms) => { sleeps.push(ms); now += ms; } };
      if (name === 'node:timers') return { setTimeout: (callback, ms) => {
        sleeps.push(ms); now += ms; callback(); return { unref() {} };
      } };
      return require(name.startsWith('.') ? path.resolve(path.dirname(handlerFile), name) : name);
    }
  });
  const client = new EventEmitter();
  client.options = { rejectOnRateLimit: policy, restTimeOffset: 0, retryLimit: 0, invalidRequestWarningInterval: 0 };
  const rateEvents = [];
  client.on('rateLimit', (event) => rateEvents.push(event));
  const manager = { client, globalLimit: Infinity, globalRemaining: Infinity, globalReset: 0, globalDelay: null };
  const handler = new module.exports(manager);
  const request = { method: 'post', path: '/guilds/123/emojis', route: '/guilds/:id/emojis', options: {}, retries: 0,
    make: async () => {
      const data = responses[calls++];
      if (!data) throw new Error('Unexpected extra request');
      return data;
    }
  };
  return { handler, request, manager, sleeps, rateEvents, calls: () => calls, advance: (ms) => { now += ms; }, now: () => now };
}
function response(status, headers = {}, body = {}) {
  return { status, ok: status === 200, headers: { get: (name) => headers[name] ?? (name === 'content-type' ? 'application/json' : null) },
    json: async () => body, arrayBuffer: async () => Buffer.alloc(0) };
}
const normalBucket = { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '0.01' };

test('HTTP 429 sublimit uses its actual 60-second wait and releases the queue without sleeping', async () => {
  const f = fixture([response(429, { ...normalBucket, 'retry-after': '60' }, { retry_after: 60, global: false })]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.timeout === 60000);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.rateEvents[0].timeout, 60000);
  assert.equal(f.handler.queue.remaining, 0);
  // A subsequent upload must not ignore the outstanding Discord cooldown.
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.timeout === 60000);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.sleeps, []);
});
test('JSON retry_after is honored when Retry-After is absent', async () => {
  const f = fixture([response(429, normalBucket, { retry_after: 60, global: false })]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.timeout === 60000);
  assert.equal(f.rateEvents[0].timeout, 60000);
  assert.deepEqual(f.sleeps, []);
});
test('short sublimits wait the entire required interval before retrying', async () => {
  const f = fixture([response(429, { ...normalBucket, 'retry-after': '10' }, { retry_after: 10 }), response(200, {}, { id: 'new' })]);
  const result = await f.handler.push(f.request);
  assert.equal(result.id, 'new');
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.sleeps, [10000]);
  assert.equal(f.rateEvents[0].timeout, 10000);
});
test('deferred upload becomes eligible only after the recorded cooldown expires', async () => {
  const f = fixture([response(429, normalBucket, { retry_after: 60 }), response(200, {}, { id: 'new' })]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError');
  f.advance(61000);
  assert.equal((await f.handler.push(f.request)).id, 'new');
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.sleeps, []);
});
test('global JSON rate limits remain shared with other resources', async () => {
  const f = fixture([response(429, {}, { retry_after: 60, global: true }), response(200, {}, { id: 'channel' })]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.global);
  assert.equal(f.manager.globalRemaining, 0);
  assert.equal(f.manager.globalReset, f.now() + 60000);
  f.request.path = '/guilds/123/channels'; f.request.route = '/guilds/:id/channels';
  assert.equal((await f.handler.push(f.request)).id, 'channel');
  assert.deepEqual(f.sleeps, [60000]);
});
test('preemptive rejection creates no orphan sleep timer', async () => {
  const f = fixture([]);
  f.handler.remaining = 0; f.handler.reset = f.now() + 60000;
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.timeout === 60000);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.calls(), 0);
  assert.equal(f.handler.queue.remaining, 0);
});
test('a 429 without a usable deadline ends instead of retrying indefinitely', async () => {
  const f = fixture([response(429)]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError' && error.timeout === 0);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.sleeps, []);
});
test('dependency patch is idempotent and rejects unsupported library source', () => {
  assert.ok(handlerSource.includes('LIAM_CLONER_RATE_LIMIT_FIX_311'));
  assert.equal(patchRequestHandler(handlerSource), handlerSource);
  assert.throws(() => patchRequestHandler('unsupported source'), /biblioteca Discord cambió/);
});

test('deferred cooldowns survive handler sweeping until their deadline expires', async () => {
  const f = fixture([response(429, normalBucket, { retry_after: 60 })]);
  await assert.rejects(f.handler.push(f.request), (error) => error.name === 'RateLimitError');
  assert.equal(f.handler._inactive, false);
  f.advance(61000);
  assert.equal(f.handler._inactive, true);
});
test('reapplying the patch upgrades the earlier cooldown-sweeping behavior safely', () => {
  const earlier = handlerSource.replace(/get _inactive\(\) \{[\s\S]*?\n  \}/,
    'get _inactive() {\n    return this.queue.remaining === 0 && !this.limited;\n  }');
  const upgraded = patchRequestHandler(earlier);
  assert.match(upgraded, /this\.assetSublimits\.size === 0/);
  assert.equal(patchRequestHandler(upgraded), upgraded);
});
