const fs = require('node:fs');
const path = require('node:path');

const marker = 'LIAM_CLONER_RATE_LIMIT_FIX_311';
const oldInactive = '    return this.queue.remaining === 0 && !this.limited;';
const newInactive = `    // Keep the handler until deferred per-operation cooldowns expire.
    for (const [key, until] of this.assetSublimits) {
      if (until <= Date.now()) this.assetSublimits.delete(key);
    }
    return this.queue.remaining === 0 && !this.limited && this.assetSublimits.size === 0;`;
function patchRequestHandler(source) {
  if (source.includes(marker)) {
    if (source.includes(newInactive)) return source;
    if (source.split(oldInactive).length !== 2) throw new Error('No se pudo verificar la conservación de las pausas de Discord.');
    return source.replace(oldInactive, newInactive);
  }
  function replace(before, after) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error('La biblioteca Discord cambió: no se puede aplicar el fix de esperas con seguridad.');
    source = source.replace(before, after);
  }
  replace('    this.limit = -1;', `    this.limit = -1;
    // ${marker}: retain per-operation cooldowns after a deferred request.
    this.assetSublimits = new Map();`);
  replace(oldInactive, newInactive);
  replace('  async execute(request, captchaKey, captchaToken) {', `  async execute(request, captchaKey, captchaToken) {
    const cooldownKey = request.method + ':' + request.path;
    const pendingCooldown = (this.assetSublimits.get(cooldownKey) || 0) - Date.now();
    if (pendingCooldown > 0) {
      this.manager.client.emit(RATE_LIMIT, {
        timeout: pendingCooldown, limit: this.limit, method: request.method,
        path: request.path, route: request.route, global: false,
      });
      await this.onRateLimit(request, this.limit, pendingCooldown, false);
      await sleep(pendingCooldown);
    }
    this.assetSublimits.delete(cooldownKey);`);
  // Reject before creating a sleep timer. Rejected requests must release the queue.
  replace('      if (isGlobal) {\n        // If this is the first task to reach the global timeout, set the global delay',
    '      await this.onRateLimit(request, limit, timeout, isGlobal);\n\n      if (isGlobal) {\n        // If this is the first task to reach the global timeout, set the global delay');
  replace('      // Determine whether a RateLimitError should be thrown\n      await this.onRateLimit(request, limit, timeout, isGlobal); // eslint-disable-line no-await-in-loop\n\n', '');
  const before = `        await this.onRateLimit(request, limit, timeout, isGlobal);

        // If caused by a sublimit, wait it out here so other requests on the route can be handled
        if (sublimitTimeout) {
          await sleep(sublimitTimeout);
        }
        return this.execute(request);`;
  const after = `        // The real 429 wait may live in retry-after / JSON, rather than bucket reset.
        const rateBody = await parseResponse(res).catch(() => ({}));
        const bodyWait = Number(rateBody?.retry_after) * 1000;
        const actualTimeout = Math.max(0, Number.isFinite(timeout) ? timeout : 0,
          sublimitTimeout || 0, Number.isFinite(bodyWait) ? bodyWait : 0);
        const actualGlobal = isGlobal || rateBody?.global === true;
        if (actualGlobal) {
          this.manager.globalRemaining = 0;
          this.manager.globalReset = Math.max(this.manager.globalReset || 0, Date.now() + actualTimeout);
        } else if (actualTimeout > 0) {
          this.assetSublimits.set(cooldownKey, Date.now() + actualTimeout);
        }
        this.manager.client.emit(RATE_LIMIT, {
          timeout: actualTimeout, limit, method: request.method,
          path: request.path, route: request.route, global: actualGlobal,
        });
        // Do not retry indefinitely if Discord gives no usable retry deadline.
        if (actualTimeout <= 0) throw new RateLimitError({
          timeout: 0, limit, method: request.method, path: request.path,
          route: request.route, global: actualGlobal,
        });
        await this.onRateLimit(request, limit, actualTimeout, actualGlobal);
        await sleep(actualTimeout);
        this.assetSublimits.delete(cooldownKey);
        return this.execute(request);`;
  replace(before, after);
  return source;
}
function install() {
  const packageFile = require.resolve('discord.js-selfbot-v13/package.json');
  const handler = path.join(path.dirname(packageFile), 'src/rest/RequestHandler.js');
  const before = fs.readFileSync(handler, 'utf8');
  const after = patchRequestHandler(before);
  if (after !== before) fs.writeFileSync(handler, after);
  console.log('Fix de esperas Discord 3.1.1 aplicado.');
}
if (require.main === module) install();
module.exports = { patchRequestHandler };
