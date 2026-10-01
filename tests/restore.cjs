const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function moduleAt(file, imports, context = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  vm.runInNewContext(code, {
    exports, require: (name) => {
      if (name === '../assets' || name === './assets') return assets;
      if (name === './progress') return progress;
      if (name === '../roles' || name === './roles') return roleNames;
      if (name === 'node-fetch' && !(name in imports)) return async () => { throw new Error('Unexpected network access'); };
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    }, console, Buffer, process, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: require("node:path").resolve("src/src"), ...context
  });
  return exports;
}
const assets = moduleAt('src/assets.ts', { 'node:crypto': require('node:crypto') });
const progress = moduleAt('src/progress.ts', {}, { process: { stdout: { isTTY: false, write() {} } } });
const roleNames = moduleAt('src/roles.ts', {});
const helpers = moduleAt('src/src/util.ts', {
  'node-fetch': () => {},
  '../settings': { configOptions2: { ignoreTickets: false }, t: (s) => s },
  'gradient-string': () => (s) => s
});

function data(type) {
  return { name: 'example', type, permissions: [], threads: [], messages: [] };
}
test('text channel creation resolves after permissions are restored', async () => {
  let restored = false;
  const channel = { permissionOverwrites: { set: async () => { restored = true; } } };
  const guild = { features: [], channels: { create: async () => channel } };
  assert.equal(await helpers.loadChannel(data('GUILD_TEXT'), guild), channel);
  assert.equal(restored, true);
});
test('channel and category API failures reject instead of hanging', async () => {
  const guild = { channels: { create: async () => { throw new Error('Denied'); } } };
  await assert.rejects(helpers.loadChannel(data('GUILD_TEXT'), guild), /Denied/);
  await assert.rejects(helpers.loadCategory(data('GUILD_CATEGORY'), guild), /Denied/);
});
test('restore waits for categories before creating their children', async () => {
  const calls = [];
  const loader = moduleAt('src/src/load.ts', {
    'gradient-string': () => (s) => s,
    '../settings': { t: (s) => s },
    './util': {
      ...helpers,
      communityChannelIds: () => new Set(),
      loadCategory: async () => { calls.push('category'); return 'parent'; },
      loadChannel: async (d, g, parent) => { calls.push(parent); }
    }
  });
  await loader.loadChannels({}, { channels: {
    categories: [{ children: [data('GUILD_TEXT')] }], others: [data('GUILD_VOICE')]
  } }, {});
  assert.deepEqual(calls, ['category', 'parent', null]);
});

const { Collection } = require('discord.js-selfbot-v13');
const collection = (items) => new Collection(items.map((item, index) => [String(index), item]));
test('message backup paginates past 100 messages and zero never fetches', async () => {
  let requests = 0;
  const source = { messages: { fetch: async ({ limit }) => {
    const start = requests++ * 100;
    return collection(Array.from({ length: limit }, (_, i) => ({
      id: String(start + i), author: { username: 'u', displayAvatarURL: () => null },
      content: `message ${start + i}`, embeds: [], attachments: collection([]), pinned: false
    })));
  } } };
  assert.equal((await helpers.fetchChannelMessages(source, { maxMessagesPerChannel: 0 })).length, 0);
  assert.equal(requests, 0);
  assert.equal((await helpers.fetchChannelMessages(source, { maxMessagesPerChannel: 150 })).length, 150);
  assert.equal(requests, 2);
});
test('cleanup waits for deletion and respects excluded emojis', async () => {
  const calls = [];
  const guild = {
    id: 'target',
    setAFKChannel: async () => {}, setSystemChannel: async () => {}, setWidgetSettings: async () => {},
    channels: { cache: collection([{ delete: async () => { await Promise.resolve(); calls.push('channel'); } }]) },
    roles: { cache: collection([{ id: 'r', editable: true, delete: async () => calls.push('role') }]) },
    emojis: { cache: collection([{ delete: async () => calls.push('emoji') }]) }
  };
  await helpers.clearGuild(guild, ['emojis']);
  assert.deepEqual(calls, ['channel', 'role']);
});
test('duplicate role names keep separate permission IDs', async () => {
  const guild = { roles: { cache: new Collection([
    ['a', { id: 'a', name: 'same' }], ['b', { id: 'b', name: 'same' }]
  ]) }, channels: { create: async () => ({ permissionOverwrites: { set: async (perms) => {
    assert.equal(perms[0].id, 'b');
  } } }) } };
  helpers.startRoleRestore(guild);
  helpers.rememberRole(guild, 'original-b', 'b');
  await helpers.loadCategory({ name: 'category', permissions: [
    { roleName: 'same', roleId: 'original-b', allow: '1', deny: '0' }
  ] }, guild);
});

function restoreEngine(calls, failure) {
  const stages = {};
  for (const stage of ['loadConfig', 'loadRoles', 'loadChannels', 'loadAFK', 'loadEmojis', 'loadEmbedChannel']) {
    stages[stage] = async () => {
      await Promise.resolve();
      calls.push(stage);
      if (stage === failure) throw new Error('Discord rejected restore');
    };
  }
  return moduleAt('src/src/index.ts', {
    'discord.js-selfbot-v13': require('discord.js-selfbot-v13'),
    'node-fetch': () => {}, path: require('node:path'), fs, util: require('node:util'),
    './create': {}, './load': stages,
    './community': { prepareCommunity: async () => {}, restoreCommunity: async () => {}, captureCommunity: async () => {} },
    './util': { ...helpers, clearGuild: async () => { await Promise.resolve(); calls.push('clear'); } }
  });
}
function destination() {
  return {
    id: 'target', ownerId: 'account', client: { user: { id: 'account' } },
    members: { fetch: async () => ({ id: 'account' }) },
    roles: { cache: collection([]) }
  };
}
test('full restore waits for cleanup, roles, channels, and final settings in order', async () => {
  const calls = [];
  await restoreEngine(calls).load({ guildID: 'source' }, destination());
  assert.deepEqual(calls, ['clear', 'loadConfig', 'loadRoles', 'loadChannels', 'loadEmojis', 'loadAFK', 'loadEmbedChannel']);
});
test('restore propagates Discord failure and does not claim completion', async () => {
  const calls = [];
  await assert.rejects(restoreEngine(calls, 'loadChannels').load({ guildID: 'source' }, destination()), /Discord rejected/);
  assert.deepEqual(calls, ['clear', 'loadConfig', 'loadRoles', 'loadChannels']);
});
test('restoring over the source is rejected before any deletion', async () => {
  const calls = [];
  await assert.rejects(restoreEngine(calls).load({ guildID: 'target' }, destination()), /different guilds/);
  assert.deepEqual(calls, []);
});

test('forum structure backup includes nested and standalone forums', async () => {
  const guild = { roles: { cache: collection([]) } };
  const forum = (id, parent) => ({
    id, type: 'GUILD_FORUM', name: id, parent, position: 1, guild,
    permissionOverwrites: { cache: collection([]) }, threads: { cache: collection([]) }, nsfw: false,
    topic: 'Forum rules', rateLimitPerUser: 5, defaultThreadRateLimitPerUser: 10,
    defaultAutoArchiveDuration: 1440, defaultSortOrder: 'CREATION_DATE', defaultForumLayout: 'LIST_VIEW',
    availableTags: [{ id: 'old-id', name: 'Help', moderated: false, emoji: { id: null, name: '❓' } }],
    defaultReactionEmoji: { id: 'source-custom-emoji', name: 'custom' }
  });
  const category = { type: 'GUILD_CATEGORY', name: 'category', position: 0, guild,
    permissionOverwrites: { cache: collection([]) } };
  const nested = forum('nested', category);
  const standalone = forum('standalone', null);
  category.children = collection([nested]);
  guild.channels = { cache: collection([category, nested, standalone]) };
  const create = moduleAt('src/src/create.ts', { 'node-fetch': () => {}, './util': helpers });
  const backup = await create.getChannels(guild, { maxMessagesPerChannel: 0 });
  assert.equal(backup.categories[0].children[0].type, 'GUILD_FORUM');
  assert.equal(backup.others[0].name, 'standalone');
  assert.equal(backup.others[0].availableTags[0].emoji.name, '❓');
  assert.equal(backup.others[0].availableTags[0].id, undefined);
  assert.equal(backup.others[0].defaultReactionEmoji.id, 'source-custom-emoji');
});

test('community destination recreates forums with tags and settings', async () => {
  let createdOptions;
  let archiveDuration;
  const channel = { type: 'GUILD_FORUM',
    permissionOverwrites: { set: async () => {} },
    setDefaultAutoArchiveDuration: async (value) => { archiveDuration = value; } };
  const guild = { features: ['COMMUNITY'], channels: { create: async (name, options) => {
    createdOptions = options;
    return channel;
  } } };
  const forum = { ...data('GUILD_FORUM'), topic: 'Rules', nsfw: true,
    availableTags: [{ name: 'Help' }], defaultAutoArchiveDuration: 1440,
    defaultForumLayout: 'LIST_VIEW', defaultThreadRateLimitPerUser: 12 };
  await helpers.loadChannel(forum, guild);
  assert.equal(createdOptions.type, 'GUILD_FORUM');
  assert.equal(createdOptions.topic, 'Rules');
  assert.equal(createdOptions.availableTags[0].name, 'Help');
  assert.equal(createdOptions.defaultThreadRateLimitPerUser, 12);
  assert.equal(archiveDuration, 1440);
});

test('destination without community receives a text channel instead of failing', async () => {
  let options;
  const guild = { features: [], channels: { create: async (name, value) => {
    options = value;
    return { type: 'GUILD_TEXT', permissionOverwrites: { set: async () => {} } };
  } } };
  await helpers.loadChannel({ ...data('GUILD_FORUM'), topic: 'Rules', nsfw: false, availableTags: [] }, guild);
  assert.equal(options.type, 'GUILD_TEXT');
  assert.equal(options.topic, 'Rules');
  assert.equal(options.availableTags, undefined);
});

function communityDestination(channels) {
  return {
    id: 'target', features: ['COMMUNITY'],
    rulesChannelId: 'rules', publicUpdatesChannelId: 'updates', safetyAlertsChannelId: 'alerts',
    setAFKChannel: async () => {}, setSystemChannel: async () => {}, setWidgetSettings: async () => {},
    channels: { cache: new Collection(channels.map((channel) => [channel.id, channel])) },
    roles: { cache: collection([]) }, emojis: { cache: collection([]) }
  };
}
test('cleanup preserves all mandatory community channels and deletes ordinary channels', async () => {
  const deleted = [];
  const guild = communityDestination(['rules', 'updates', 'alerts', 'ordinary'].map((id) => ({
    id, name: id, delete: async () => { deleted.push(id); }
  })));
  await helpers.clearGuild(guild);
  assert.deepEqual(deleted, ['ordinary']);
});
test('Discord code 50074 preserves a required channel missing from cache metadata', async () => {
  let deleted = false;
  const guild = communityDestination([
    { id: 'unknown-required', name: 'required', delete: async () => { throw { code: 50074 }; } },
    { id: 'ordinary', delete: async () => { deleted = true; } }
  ]);
  await helpers.clearGuild(guild);
  assert.equal(deleted, true);
});
test('cleanup still reports unrelated Discord deletion errors', async () => {
  const guild = communityDestination([{ id: 'ordinary', delete: async () => { throw new Error('Missing permissions'); } }]);
  await assert.rejects(helpers.clearGuild(guild), /Missing permissions/);
});
test('community restore reuses the existing rules channel by its source role', async () => {
  const target = { id: 'rules', name: 'old-rules', type: 'GUILD_TEXT' };
  const guild = communityDestination([target]);
  let reused;
  const loader = moduleAt('src/src/load.ts', {
    'gradient-string': () => (s) => s, '../settings': { t: (s) => s },
    './util': { ...helpers, communityChannelIds: helpers.communityChannelIds,
      loadChannel: async (source, guild, category, options, existing) => { reused = existing; } }
  });
  await loader.loadChannels(guild, {
    community: { rulesChannelId: 'source-rules' },
    channels: { categories: [], others: [{ ...data('GUILD_TEXT'), id: 'source-rules', name: 'new-rules', nsfw: false }] }
  }, { clearGuildBeforeRestore: true });
  assert.equal(reused, target);
});

const community = moduleAt('src/src/community.ts', { './util': helpers, 'node-fetch': async () => { throw new Error('Unexpected network access'); } });
const json = (value) => JSON.parse(JSON.stringify(value));
function autoGuild(previous = []) {
  const calls = [];
  const rules = (id) => ({
    patch: async ({ data }) => { calls.push({ operation: 'patch', id, data }); },
    delete: async () => { calls.push({ operation: 'delete', id }); }
  });
  rules.get = async () => previous;
  rules.post = async ({ data }) => { calls.push({ operation: 'post', data }); };
  const guild = { id: 'target', features: [], ownerId: 'owner',
    client: { user: { id: 'account' }, api: { guilds: () => ({ 'auto-moderation': { rules } }) } },
    roles: { cache: new Collection([['role-new', { id: 'role-new', name: 'Staff' }]]) },
    channels: { cache: new Collection([['channel-new', { id: 'channel-new', name: 'log' }]]) },
    emojis: { cache: collection([]) }
  };
  helpers.startRoleRestore(guild);
  helpers.startChannelRestore(guild);
  helpers.rememberRole(guild, 'role-source', 'role-new');
  helpers.rememberChannel(guild, 'channel-source', 'channel-new');
  return { guild, calls };
}
function autoRule(extra = {}) {
  return { id: 'source-rule', name: 'Profile filter', event_type: 2, trigger_type: 6,
    trigger_metadata: { keyword_filter: ['blocked'], regex_patterns: ['pattern'], allow_list: ['safe'], future_field: true },
    actions: [{ type: 4, metadata: { future_field: 'retained' } }, { type: 2, metadata: { channel_id: 'channel-source' } }],
    exempt_roles: ['role-source'], exempt_channels: ['channel-source'], enabled: true, ...extra };
}
test('raw AutoMod preserves new trigger types and metadata while remapping IDs', async () => {
  const { guild, calls } = autoGuild();
  const source = autoRule();
  await community.restoreCommunity(guild, { autoMod: [source] }, { clearGuildBeforeRestore: true });
  const payload = calls[0].data;
  assert.equal(payload.trigger_type, 6);
  assert.equal(payload.event_type, 2);
  assert.equal(payload.trigger_metadata.future_field, true);
  assert.deepEqual(json(payload.exempt_roles), ['role-new']);
  assert.deepEqual(json(payload.exempt_channels), ['channel-new']);
  assert.equal(payload.actions[1].metadata.channel_id, 'channel-new');
  assert.equal(payload.actions[0].metadata.future_field, 'retained');
  assert.equal(source.actions[1].metadata.channel_id, 'channel-source');
});
test('missing AutoMod exemptions reject the rule instead of broadening its effect', async () => {
  const { guild, calls } = autoGuild([{ id: 'existing', name: 'Safety rule', trigger_type: 6 }]);
  const events = [];
  await community.restoreCommunity(guild, { autoMod: [autoRule({ exempt_roles: ['missing'] })] }, {
    clearGuildBeforeRestore: true, onEvent: (event) => events.push(event)
  });
  assert.deepEqual(calls, []);
  assert.equal(events[0].kind, 'failed');
  assert.match(events[0].reason, /rol exento/);
});
test('existing AutoMod slots are reused without sending immutable trigger_type in PATCH', async () => {
  const { guild, calls } = autoGuild([{ id: 'old', name: 'Different name', trigger_type: 6 }]);
  await community.restoreCommunity(guild, { autoMod: [autoRule()] }, { clearGuildBeforeRestore: true });
  assert.equal(calls[0].operation, 'patch');
  assert.equal(calls[0].id, 'old');
  assert.equal(calls[0].data.name, 'Profile filter');
  assert.equal(calls[0].data.trigger_type, undefined);
  assert.equal(calls.length, 1);
});
test('onboarding replaces all source role/channel IDs and creates fresh prompt IDs', () => {
  const { guild } = autoGuild();
  const source = { enabled: true, mode: 1, default_channel_ids: ['channel-source'], prompts: [{
    id: 'source-prompt', type: 0, title: 'Choose', single_select: false, required: true, in_onboarding: true,
    options: [{ id: 'source-option', title: 'Staff', channel_ids: ['channel-source'], role_ids: ['role-source'] }]
  }] };
  const result = community.remapOnboarding(source, guild);
  assert.deepEqual(json(result.default_channel_ids), ['channel-new']);
  assert.deepEqual(json(result.prompts[0].options[0].role_ids), ['role-new']);
  assert.equal(result.prompts[0].id, '0');
  assert.equal(result.prompts[0].options[0].id, '0');
  assert.equal(source.prompts[0].id, 'source-prompt');
});
test('onboarding refuses unresolved default channels', () => {
  const { guild } = autoGuild();
  assert.throws(() => community.remapOnboarding({ enabled: true, default_channel_ids: ['missing'], prompts: [] }, guild), /no disponible/);
});
test('unlimited history reads every page and stops at an empty page', async () => {
  let calls = 0;
  const channel = { name: 'history', messages: { fetch: async () => {
    const start = calls++ * 100;
    return collection(Array.from({ length: Math.max(0, Math.min(100, 250 - start)) }, (_, i) => ({
      id: String(start + i), author: { username: 'user', displayAvatarURL: () => null },
      content: 'text', embeds: [], attachments: collection([])
    })));
  } } };
  assert.equal((await helpers.fetchChannelMessages(channel, { maxMessagesPerChannel: -1 })).length, 250);
  assert.equal(calls, 4);
});
test('thread backup fetches both active and archived threads', async () => {
  const calls = [];
  const channel = { availableTags: [], threads: { cache: collection([]), fetchActive: async (cache, options) => {
    calls.push(options.archived);
    return { hasMore: false, threads: collection([{ id: options.archived ? 'archived' : 'active',
      type: 'GUILD_PUBLIC_THREAD', name: 'post', archived: options.archived, locked: false,
      autoArchiveDuration: 1440, rateLimitPerUser: 0, appliedTags: [] }]) };
  } } };
  const result = await helpers.fetchThreads(channel, { maxMessagesPerChannel: 0 });
  assert.deepEqual(calls, [false, true]);
  assert.equal(result.length, 2);
  assert.equal(result[1].archived, true);
});
test('forum publications restore original starter and replies in chronological order', async () => {
  const sent = [];
  let deleted = 0;
  let archivedAfterMessages;
  const webhook = { send: async (payload) => { sent.push(payload); return { id: 'new-message', channelId: 'new-post' }; },
    delete: async () => { deleted++; } };
  const channel = { type: 'GUILD_FORUM', name: 'forum', availableTags: [{ id: 'new-tag', name: 'Help' }],
    createWebhook: async () => webhook };
  const thread = { id: 'new-post', name: 'post', parent: channel, isThread: () => true,
    setArchived: async () => { archivedAfterMessages = sent.length; } };
  const { guild } = autoGuild();
  guild.channels.fetch = async () => thread;
  await helpers.restoreChannelHistory(channel, { type: 'GUILD_FORUM', threads: [{ id: 'old-post', name: 'Help me',
    autoArchiveDuration: 1440, archived: true, locked: false, appliedTagNames: ['Help'],
    messages: [{ username: 'Reply', content: 'second', embeds: [], files: [] }, { username: 'Starter', content: 'first', embeds: [], files: [] }]
  }] }, guild, { clearGuildBeforeRestore: true, maxMessagesPerChannel: -1 });
  assert.equal(sent[0].username, 'Starter');
  assert.equal(sent[0].threadName, 'Help me');
  assert.deepEqual(json(sent[0].appliedTags), ['new-tag']);
  assert.equal(sent[1].username, 'Reply');
  assert.equal(sent[1].threadId, 'new-post');
  assert.equal(archivedAfterMessages, 2);
  assert.equal(deleted, 2);
  assert.equal(helpers.resolveChannelId(guild, 'old-post'), 'new-post');
});
test('shared members receive mapped roles while absent members are reported without invitations', async () => {
  const { guild } = autoGuild();
  let assigned;
  guild.members = { fetch: async () => new Collection([['shared', { id: 'shared', user: { username: 'Shared' },
    roles: { cache: collection([{ id: 'bot-role', managed: true }]), set: async (roles) => { assigned = roles; } } }]]) };
  const events = [];
  await community.restoreCommunity(guild, { memberRoles: [
    { userId: 'shared', roleIds: ['role-source'] }, { userId: 'absent', roleIds: [] }
  ] }, { clearGuildBeforeRestore: true, onEvent: (event) => events.push(event) });
  assert.deepEqual(json(assigned), ['bot-role', 'role-new']);
  assert.equal(events.find((event) => event.feature === 'miembros no transferibles').count, 1);
});

test('animated emoji backup retains image bytes and restricted role IDs', async () => {
  const bytes = Buffer.from('GIF89a animated image');
  const snapshot = moduleAt('src/src/create.ts', {
    './util': helpers, 'node-fetch': async () => ({ ok: true, arrayBuffer: async () => bytes })
  });
  const emoji = { id: 'emoji-source', name: 'dance', animated: true, url: 'https://example.invalid/dance.gif',
    roles: { cache: new Collection([['role-source', {}]]) } };
  const result = await snapshot.getEmojis({ emojis: { cache: collection([emoji]) } }, { saveImages: 'base64' });
  assert.equal(result[0].base64, bytes.toString('base64'));
  assert.equal(result[0].id, 'emoji-source');
  assert.equal(result[0].animated, true);
  assert.deepEqual(json(result[0].roleIds), ['role-source']);
});
test('emoji upload preserves bytes, role restrictions, and the new emoji mapping', async () => {
  const { guild } = autoGuild();
  const loader = moduleAt('src/src/load.ts', { './util': helpers });
  const bytes = Buffer.from('GIF89a animated image');
  let uploaded;
  guild.emojis.create = async (file, name, options) => {
    uploaded = { file, name, options }; return { id: 'emoji-new' };
  };
  const events = [];
  await loader.loadEmojis(guild, { emojis: [{ id: 'emoji-source', name: 'dance',
    base64: bytes.toString('base64'), roleIds: ['role-source'] }] }, { onEvent: (e) => events.push(e) });
  assert.equal(uploaded.file, `data:image/gif;base64,${bytes.toString('base64')}`);
  assert.deepEqual(json(uploaded.options.roles), ['role-new']);
  assert.equal(helpers.resolveEmojiId(guild, 'emoji-source'), 'emoji-new');
  assert.equal(events.find((event) => event.kind === 'copied').feature, 'emojis');
});
test('sticker upload uses embedded GIF bytes and preserves name, tags and description', async () => {
  const { guild } = autoGuild();
  const bytes = Buffer.from('GIF89a sticker');
  let uploaded;
  guild.stickers = { cache: collection([]), fetch: async () => collection([]),
    create: async (...args) => { uploaded = args; } };
  const events = [];
  await community.restoreCommunity(guild, { stickers: [{ name: 'liam', tags: 'smile',
    description: 'Animated sticker', format: 'GIF', url: 'https://example.invalid/sticker.gif',
    base64: bytes.toString('base64') }] }, { clearGuildBeforeRestore: true, onEvent: (e) => events.push(e) });
  assert.deepEqual(uploaded[0].attachment, bytes);
  assert.equal(uploaded[0].name, 'sticker.gif');
  assert.equal(uploaded[1], 'liam');
  assert.equal(uploaded[2], 'smile');
  assert.equal(uploaded[3].description, 'Animated sticker');
  assert.equal(events.find((event) => event.kind === 'copied').feature, 'stickers');
});
test('sticker capacity errors identify the rejected sticker and cloning continues', async () => {
  const { guild } = autoGuild();
  guild.stickers = { cache: collection([]), create: async () => {
    throw Object.assign(new Error('Maximum stickers reached'), { code: 30039 });
  } };
  const events = [];
  await community.restoreCommunity(guild, { stickers: [
    { name: 'full', tags: 'smile', format: 'PNG', url: 'https://example.invalid/sticker.png', base64: Buffer.from('PNG').toString('base64') },
    { name: 'unsupported', tags: 'smile', format: 'LOTTIE', url: 'https://example.invalid/sticker.json' }
  ] }, { clearGuildBeforeRestore: false, onEvent: (e) => events.push(e) });
  const outcomes = events.filter((event) => event.kind !== 'progress');
  assert.equal(outcomes[0].kind, 'failed');
  assert.equal(outcomes[0].name, 'full');
  assert.match(outcomes[0].reason, /30039/);
  assert.equal(outcomes[1].kind, 'skipped');
  assert.equal(outcomes[1].name, 'unsupported');
});
test('recreated messages remap custom emojis, role mentions and channel links', async () => {
  const { guild } = autoGuild();
  helpers.rememberEmoji(guild, '12345678901234567', '98765432109876543');
  helpers.rememberChannel(guild, '12345678901234568', '98765432109876544');
  helpers.rememberRole(guild, '12345678901234569', '98765432109876545');
  let sent;
  const channel = { name: 'test', isThread: () => false, createWebhook: async () => ({
    send: async (payload) => { sent = payload; return { id: 'message' }; }, delete: async () => {}
  }) };
  await helpers.loadMessages(channel, [{ username: 'liam',
    content: '<a:dance:12345678901234567> <#12345678901234568> <@&12345678901234569>'
  }], guild, { maxMessagesPerChannel: -1 });
  assert.equal(sent.content, '<a:dance:98765432109876543> <#98765432109876544> <@&98765432109876545>');
  assert.deepEqual(json(sent.allowedMentions), { parse: [] });
});

const cli = moduleAt('src/cli.ts', {
  'node:fs': fs, 'node:path': require('node:path'), './src/index': {}, './src/util': helpers
});
test('CLI accepts full-history mode and rejects invalid message limits and server IDs', () => {
  assert.equal(cli.parseMessageLimit(''), 0);
  assert.equal(cli.parseMessageLimit('-1'), -1);
  assert.equal(cli.parseMessageLimit('0'), 0);
  assert.throws(() => cli.parseMessageLimit('-2'));
  assert.throws(() => cli.parseMessageLimit('NaN'));
  assert.throws(() => cli.parseMessageLimit('1.5'));
  assert.throws(() => cli.validateGuildId('discord.gg/invite'));
  assert.equal(cli.validateGuildId(' 123456789012345678 '), '123456789012345678');
});
test('explicit backup restoration allows the original destination ID, while ordinary cloning still refuses it', async () => {
  const calls = [];
  await restoreEngine(calls).load({ guildID: 'target' }, destination(), { clearGuildBeforeRestore: true, restoreSnapshot: true });
  assert.equal(calls.includes('loadChannels'), true);
});
test('community preparation failure removes temporary channels and reports a partial capability', async () => {
  const deleted = [];
  let created = 0;
  const guild = { features: [], channels: { create: async () => {
    const id = String(created++);
    return { delete: async () => deleted.push(id) };
  } }, setCommunity: async () => { throw new Error('Community unavailable'); } };
  const events = [];
  await community.prepareCommunity(guild, { isCommunity: true }, { enableCommunity: true, onEvent: (event) => events.push(event) });
  assert.deepEqual(deleted, ['0', '1']);
  assert.equal(events[0].kind, 'failed');
  assert.equal(events[0].feature, 'activar Comunidad');
});
test('stage channels are recreated as stages on community destinations', async () => {
  let options;
  const guild = { features: ['COMMUNITY'], maximumBitrate: 64000, channels: { create: async (name, value) => {
    options = value;
    return { id: 'new-stage', type: 'GUILD_STAGE_VOICE', permissionOverwrites: { set: async () => {} } };
  } } };
  await helpers.loadChannel({ ...data('GUILD_STAGE_VOICE'), id: 'old-stage', bitrate: 128000, userLimit: 0 }, guild);
  assert.equal(options.type, 'GUILD_STAGE_VOICE');
  assert.equal(options.bitrate, 64000);
  assert.equal(helpers.resolveChannelId(guild, 'old-stage'), 'new-stage');
});

test('malformed backups and unsupported channel types are rejected before restoration', () => {
  const engine = restoreEngine([]);
  assert.throws(() => engine.validateBackup({ name: 'invalid' }), /respaldo válido/);
  assert.throws(() => engine.validateBackup({ name: 'server', guildID: 'source', roles: [], emojis: [], bans: [],
    channels: { categories: [], others: [{ name: 'channel', type: 'UNKNOWN', permissions: [] }] } }), /canal inválido/);
});

async function cliFlow(t, confirmation, fails = false) {
  const os = require('node:os');
  const path = require('node:path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloner-cli-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceId = '123456789012345678';
  const targetId = '223456789012345678';
  const source = { id: sourceId, name: 'Source' };
  const target = { id: targetId, name: 'Target' };
  const sequence = [];
  const fakeBackup = {
    create: async (guild, options) => {
      sequence.push(`backup:${guild.name}`);
      assert.equal(options.includeCommunity, true);
      assert.equal(options.maxMessagesPerChannel, 0);
      assert.equal(options.includeThreads, false);
      assert.deepEqual(json(options.doNotBackup), ['memberRoles']);
      return { id: guild === target ? '900000000000000002' : '900000000000000001', guildID: guild.id,
        name: guild.name, roles: [], emojis: [], bans: [], warnings: [], channels: { categories: [], others: [] } };
    },
    load: async (data, guild, options) => {
      sequence.push('write:destination');
      assert.equal(options.enableCommunity, true);
      assert.equal(options.maxMessagesPerChannel, 0);
      if (fails) throw new Error('Missing permissions during copy');
    }
  };
  const menu = moduleAt('src/cli.ts', {
    'node:fs': fs, 'node:path': path, './src/util': helpers,
    './src/index': { __esModule: true, default: fakeBackup, storageFolder: () => path.join(temporary, 'backups'),
      validateDestination: async () => sequence.push('preflight') }
  }, { console: { log() {}, error() {} } });
  const answers = ['1', sourceId, targetId, '', confirmation, '0'];
  const readline = { question: (text, callback) => {
    if (!answers.length) throw new Error('CLI requested an unexpected prompt');
    if (text.includes('CLONAR')) sequence.push('confirmation');
    callback(answers.shift());
  }, close() {} };
  const client = { guilds: { fetch: async (id) => id === sourceId ? source : target }, destroy() {} };
  await menu.runMenu(client, readline);
  const files = fs.readdirSync(path.join(temporary, 'reports'));
  const report = JSON.parse(fs.readFileSync(path.join(temporary, 'reports', files[0]), 'utf8'));
  return { sequence, report };
}
test('CLI takes a destination snapshot before confirmation and performs no writes when cancelled', async (t) => {
  const { sequence, report } = await cliFlow(t, '');
  assert.deepEqual(sequence, ['backup:Source', 'preflight', 'backup:Target', 'confirmation']);
  assert.equal(report.status, 'cancelado');
  assert.equal(report.targetBackupId, '900000000000000002');
});
test('CLI writes only after confirmation and retains the recovery ID on Discord failure', async (t) => {
  const { sequence, report } = await cliFlow(t, 'CLONAR', true);
  assert.deepEqual(sequence, ['backup:Source', 'preflight', 'backup:Target', 'confirmation', 'write:destination']);
  assert.equal(report.status, 'interrumpido por error');
  assert.equal(report.targetBackupId, '900000000000000002');
  assert.match(report.error, /Missing permissions/);
});

test('quick snapshots never request messages or enumerate threads', async () => {
  let reads = 0;
  const channel = { id: 'text', type: 'GUILD_TEXT', name: 'general', position: 0,
    guild: { roles: { cache: collection([]) } }, permissionOverwrites: { cache: collection([]) },
    messages: { fetch: async () => { reads++; throw new Error('History must not be fetched'); } },
    threads: { cache: collection([]), fetchActive: async () => { reads++; throw new Error('Threads must not be fetched'); } } };
  const result = await helpers.fetchTextChannelData(channel, { maxMessagesPerChannel: 0, includeThreads: false });
  assert.equal(reads, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(result.threads.length, 0);
});
test('restoring a historical snapshot with zero message limit never creates a message webhook', async () => {
  let webhooks = 0;
  const channel = { name: 'general', createWebhook: async () => { webhooks++; throw new Error('Not allowed'); } };
  await helpers.loadMessages(channel, [{ username: 'user', content: 'old message' }], {}, { maxMessagesPerChannel: 0 });
  assert.equal(webhooks, 0);
});
test('emoji slots are independent and exhausted slots do not trigger failed API requests', async () => {
  const { guild } = autoGuild();
  guild.emojis.cache = new Collection(Array.from({ length: 50 }, (_, i) => [`static-${i}`, { id: `static-${i}`, animated: false }]));
  let calls = 0;
  guild.emojis.create = async () => { calls++; return { id: 'animated-new' }; };
  const loader = moduleAt('src/src/load.ts', { './util': helpers });
  const source = [{ id: 'too-many', name: 'static', animated: false, base64: Buffer.from('PNG').toString('base64') },
    { id: 'animated-source', name: 'animated', animated: true, base64: Buffer.from('GIF89a').toString('base64') }];
  const events = [];
  await loader.loadEmojis(guild, { emojis: source }, { onEvent: (e) => events.push(e) });
  assert.equal(calls, 1);
  assert.equal(events.find((e) => e.name === 'static' && e.kind !== 'progress').kind, 'skipped');
  assert.equal(helpers.resolveEmojiId(guild, 'animated-source'), 'animated-new');
});
test('long emoji rate limits defer remaining assets without repeated requests', async () => {
  const { guild } = autoGuild();
  let calls = 0;
  guild.emojis.create = async () => {
    calls++; throw Object.assign(new Error('Rate limit'), { name: 'RateLimitError', timeout: 60000 });
  };
  const events = [];
  await moduleAt('src/src/load.ts', { './util': helpers }).loadEmojis(guild,
    { emojis: ['first', 'second', 'third'].map((name) => ({ name, animated: false, base64: Buffer.from('PNG').toString('base64') })) },
    { onEvent: (e) => events.push(e) });
  assert.equal(calls, 1);
  assert.equal(events.filter((e) => e.kind === 'failed').length, 1);
  assert.equal(events.filter((e) => e.kind === 'skipped').length, 2);
  assert.match(events.find((e) => e.kind === 'failed').reason, /60 s/);
});
test('rate-limit policy only declines long optional asset uploads and respects other waits', () => {
  const base = { timeout: 60000, method: 'post', path: '/guilds/123/emojis' };
  assert.equal(assets.rejectLongAssetWait(base), true);
  assert.equal(assets.rejectLongAssetWait({ ...base, timeout: 15000 }), false);
  assert.equal(assets.rejectLongAssetWait({ ...base, method: 'GET' }), false);
  assert.equal(assets.rejectLongAssetWait({ ...base, method: 'DELETE' }), false);
  assert.equal(assets.rejectLongAssetWait({ ...base, path: '/guilds/123/channels' }), false);
  assert.equal(assets.rejectLongAssetWait({ ...base, path: '/guilds/123/stickers' }), true);
});
test('emoji reuse requires identical bytes and format, even when names collide', () => {
  const base = Buffer.from('image bytes').toString('base64');
  const source = { emojis: [{ id: 'source', name: 'same', animated: false, base64: base },
    { id: 'different', name: 'same', animated: true, base64: base }] };
  const target = { emojis: [{ id: 'wrong-image', name: 'same', animated: false, base64: Buffer.from('different bytes').toString('base64') },
    { id: 'right', name: 'same', animated: false, base64: base }] };
  assert.deepEqual(json(assets.planEmojiReuse(source, target)), { source: 'right' });
});
test('cleanup preserves reusable and managed emojis and updates deleted cache entries immediately', async () => {
  const deleted = [];
  const guild = { id: 'target', roles: { cache: collection([]) }, emojis: { cache: new Collection([
    ['reuse', { id: 'reuse', delete: async () => deleted.push('reuse') }],
    ['managed', { id: 'managed', managed: true, name: 'integration', delete: async () => deleted.push('managed') }],
    ['old', { id: 'old', delete: async () => deleted.push('old') }]
  ]) } };
  await helpers.clearGuild(guild, ['channels'], { clearGuildBeforeRestore: true, reuseEmojiIds: { source: 'reuse' } });
  assert.deepEqual(deleted, ['old']);
  assert.equal(guild.emojis.cache.has('old'), false);
  assert.equal(guild.emojis.cache.has('reuse'), true);
  assert.equal(guild.emojis.cache.has('managed'), true);
});
test('identical emojis are edited for mapped restrictions rather than uploaded again', async () => {
  const { guild } = autoGuild();
  guild.emojis.cache.set('reused', { id: 'reused', animated: false });
  let edits = 0;
  guild.emojis.create = async () => { throw new Error('Must reuse'); };
  guild.emojis.edit = async (id, options) => { edits++; assert.deepEqual(json(options.roles), ['role-new']); return { id }; };
  await moduleAt('src/src/load.ts', { './util': helpers }).loadEmojis(guild,
    { emojis: [{ id: 'source', name: 'same', roleIds: ['role-source'] }] }, { reuseEmojiIds: { source: 'reused' } });
  assert.equal(edits, 1);
  assert.equal(helpers.resolveEmojiId(guild, 'source'), 'reused');
});
test('sticker deletions synchronize caches before quota checks and recreate the image', async () => {
  const { guild } = autoGuild();
  const cache = new Collection(Array.from({ length: 5 }, (_, index) => [String(index), {
    id: String(index), name: 'same', delete: async () => {}, edit: async () => { throw new Error('Deleted sticker must not be edited'); }
  }]));
  let created = 0;
  guild.stickers = { cache, fetch: async () => new Collection(cache), create: async () => { created++; } };
  await community.restoreCommunity(guild, { stickers: [{ name: 'same', tags: 'smile', format: 'PNG',
    base64: Buffer.from('image').toString('base64') }] }, { clearGuildBeforeRestore: true });
  assert.equal(cache.size, 0);
  assert.equal(created, 1);
});
test('limited downloads preserve order and never exceed four simultaneous transfers', async () => {
  let active = 0;
  let peak = 0;
  const result = await assets.mapLimited([1, 2, 3, 4, 5, 6, 7], 4, async (item) => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--; return item * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(json(result), [2, 4, 6, 8, 10, 12, 14]);
});
test('image download deadlines abort the actual request and clear the deadline timer', async () => {
  let cleared = false;
  const timed = moduleAt('src/assets.ts', { 'node:crypto': require('node:crypto') }, {
    setTimeout: (callback) => { queueMicrotask(callback); return 1; }, clearTimeout: () => { cleared = true; }
  });
  await assert.rejects(timed.imageBytes(async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
  }), 'https://example.invalid/image.png'), /Request aborted/);
  assert.equal(cleared, true);
});
test('deferred forum emoji references are patched after upload without changing tag IDs', async () => {
  const { guild } = autoGuild();
  helpers.rememberChannel(guild, 'forum-source', 'forum-new');
  helpers.rememberEmoji(guild, 'emoji-source', 'emoji-new');
  let patch;
  guild.channels.cache.set('forum-new', { type: 'GUILD_FORUM', availableTags: [{ id: 'tag-new', name: 'Help' }],
    edit: async (data) => { patch = data; } });
  await helpers.restoreForumEmojis(guild, { id: 'forum-source', type: 'GUILD_FORUM', name: 'forum',
    availableTags: [{ name: 'Help', moderated: false, emoji: { id: 'emoji-source', name: 'custom' } }],
    defaultReactionEmoji: { id: 'emoji-source', name: 'custom' } }, {});
  assert.equal(patch.availableTags[0].id, 'tag-new');
  assert.equal(patch.availableTags[0].emoji.id, 'emoji-new');
  assert.equal(patch.defaultReactionEmoji.id, 'emoji-new');
});

function terminalFixture() {
  const { EventEmitter } = require('node:events');
  const input = new EventEmitter();
  input.isTTY = true; input.isRaw = false;
  input.setEncoding = () => {}; input.resume = () => {}; input.pause = () => {};
  input.setRawMode = (value) => { input.isRaw = value; };
  let output = '';
  const stream = { isTTY: true, columns: 40, write: (value) => { output += value; } };
  let interrupted = false;
  const { TerminalInput } = moduleAt('src/terminal.ts', {});
  const terminal = new TerminalInput(input, stream, () => { interrupted = true; });
  return { terminal, input, stream, output: () => output, interrupted: () => interrupted };
}
test('token input displays stars, supports deletion and never echoes the secret', () => {
  const fixture = terminalFixture();
  let token;
  fixture.terminal.secretQuestion('Token', (answer) => { token = answer; });
  fixture.input.emit('data', 'secretX\u007fY\r');
  assert.equal(token, 'secretY');
  assert.match(fixture.output(), /\*\*\*\*\*\*\*/);
  assert.equal(fixture.output().includes('secret'), false);
  fixture.terminal.close();
  assert.equal(fixture.input.isRaw, false);
});
test('terminal editing stays on its input line and discards input while the copy is busy', () => {
  const fixture = terminalFixture();
  fixture.stream.write('MENU MUST REMAIN\n');
  fixture.input.emit('data', 'CLONAR\r');
  let answer;
  fixture.terminal.question('Confirmación', (value) => { answer = value; });
  fixture.input.emit('data', '\u007f\u007f\u001b[A\u000cCLONAR\r');
  assert.equal(answer, 'CLONAR');
  assert.ok(fixture.output().startsWith('MENU MUST REMAIN\n'));
  assert.equal(/\u001b\[(?:2J|3J|H)/.test(fixture.output()), false);
  fixture.terminal.close();
});
test('terminal navigation and CRLF paste do not submit a second answer', () => {
  const fixture = terminalFixture();
  let answer;
  fixture.terminal.question('ID', (value) => { answer = value; });
  fixture.input.emit('data', '123\u001b[D\u007f4\r\naccidental\r');
  assert.equal(answer, '143');
  let next;
  fixture.terminal.question('Siguiente', (value) => { next = value; });
  fixture.input.emit('data', '0\r');
  assert.equal(next, '0');
  fixture.terminal.close();
});
test('progress shows rate-limit countdowns and only clears its own current line', () => {
  const fixture = terminalFixture();
  const display = new progress.ProgressDisplay(fixture.stream);
  display.start('5/8 · Emojis');
  display.update('dance', 3, 50);
  display.rateLimit({ timeout: 60000 });
  display.stop();
  assert.match(fixture.output(), /3\/50/);
  assert.match(fixture.output(), /Discord espera 60s/);
  assert.equal(/\u001b\[(?:2J|3J|H)/.test(fixture.output()), false);
  assert.equal(progress.elapsedTime(65000), '01:05');
  fixture.terminal.close();
});
test('missing membership screening is treated as disabled instead of a read failure', async () => {
  const warnings = [];
  const guild = { features: ['COMMUNITY'], client: { api: { guilds: () => ({
    'member-verification': { get: async () => { throw { code: 10068, message: 'Unknown Guild Member Verification Form' }; } }
  }) } } };
  const snapshot = {};
  await community.captureCommunity(guild, snapshot, { doNotBackup: ['memberRoles', 'autoMod', 'stickers', 'bans', 'events', 'welcome', 'onboarding'],
    onWarning: (warning) => warnings.push(warning) });
  assert.equal(warnings.length, 0);
  assert.deepEqual(json(snapshot.screening), { enabled: false, form_fields: [] });
});

test('unrestricted identical emojis need no upload or edit request', async () => {
  const { guild } = autoGuild();
  guild.emojis.cache.set('reused', { id: 'reused', animated: false, roles: { cache: collection([]) } });
  guild.emojis.create = guild.emojis.edit = async () => { throw new Error('No API write should be needed'); };
  const result = await moduleAt('src/src/load.ts', { './util': helpers }).loadEmojis(guild,
    { emojis: [{ id: 'source', name: 'same', roleIds: [] }] }, { reuseEmojiIds: { source: 'reused' } });
  assert.equal(result.length, 1);
  assert.equal(helpers.resolveEmojiId(guild, 'source'), 'reused');
});

test('an upload pause still maps identical unrestricted emojis without further requests', async () => {
  const { guild } = autoGuild();
  guild.emojis.cache.set('existing', { id: 'existing', animated: false, roles: { cache: collection([]) } });
  let calls = 0;
  guild.emojis.create = async () => {
    calls++; throw Object.assign(new Error('Rate limit'), { name: 'RateLimitError', timeout: 60000 });
  };
  guild.emojis.edit = async () => { throw new Error('No edit should be needed'); };
  const result = await moduleAt('src/src/load.ts', { './util': helpers }).loadEmojis(guild, { emojis: [
    { id: 'new', name: 'new', animated: false, base64: Buffer.from('PNG').toString('base64') },
    { id: 'source-existing', name: 'same', roleIds: [] }
  ] }, { reuseEmojiIds: { 'source-existing': 'existing' } });
  assert.equal(calls, 1);
  assert.equal(result.length, 1);
  assert.equal(helpers.resolveEmojiId(guild, 'source-existing'), 'existing');
});

test('role names preserve valid styling and repair empty, invisible and oversized Unicode names', () => {
  assert.equal(roleNames.normaliseRoleName('☆ Staff ☆', 'rol-1').name, '☆ Staff ☆');
  assert.equal(roleNames.normaliseRoleName('   ', 'rol-2').name, 'rol-2');
  assert.equal(roleNames.normaliseRoleName('\u200b\u2800\u3164\uFE0F', 'rol-3').name, 'rol-3');
  assert.equal(roleNames.normaliseRoleName('abc\u0000def', 'rol-4').name, 'abcdef');
  const name = roleNames.normaliseRoleName('x' + '😀'.repeat(70), 'rol-5').name;
  assert.ok(name.length <= 100);
  assert.equal(Array.from(name).at(-1), '😀');
  assert.equal(roleNames.normaliseRoleName('A'.repeat(100), 'rol-6').changed, false);
});
function roleDestination(create) {
  let next = 0;
  const cache = collection([]);
  return { features: [], roles: { cache, create: async (options) => {
    if (create) await create(options);
    const role = { id: `new-${++next}`, name: options.name };
    cache.set(role.id, role); return role;
  }, setPositions: async () => {}, everyone: { edit: async () => ({ id: 'everyone' }) } } };
}
const roleData = (id, name, position = 1) => ({ id, name, position, color: '#123456', permissions: '1', hoist: false, mentionable: false });
test('role creation sends repaired names and modern colors while preserving source-ID mappings', async () => {
  const events = [];
  const guild = roleDestination(async (options) => {
    assert.ok(options.name.length >= 1 && options.name.length <= 100);
    assert.equal(options.color, undefined);
    assert.equal(options.colors.primaryColor, '#123456');
  });
  const source = [roleData('empty', '\u2800', 1), roleData('long', '😀'.repeat(70), 2)];
  await moduleAt('src/src/load.ts', { './util': helpers }).loadRoles(guild, { roles: source }, { onEvent: (e) => events.push(e) });
  assert.equal(helpers.resolveRoleId(guild, 'empty'), 'new-1');
  assert.equal(helpers.resolveRoleId(guild, 'long'), 'new-2');
  assert.equal(events.filter((e) => e.feature === 'nombre de rol ajustado').length, 2);
  assert.equal(source[1].name, '😀'.repeat(70));
});
test('Discord name rejection retries once with a plain role name then continues', async () => {
  const names = [];
  const guild = roleDestination(async (options) => {
    names.push(options.name);
    if (options.name === 'old-spacer') throw Object.assign(new Error('Invalid Form Body\nname: Must be between 1 and 100 in length.'), { code: 50035 });
  });
  await moduleAt('src/src/load.ts', { './util': helpers }).loadRoles(guild,
    { roles: [roleData('source', 'old-spacer'), roleData('second', 'staff', 2)] }, {});
  assert.deepEqual(names, ['old-spacer', 'rol-1', 'staff']);
  assert.equal(helpers.resolveRoleId(guild, 'source'), 'new-1');
  assert.equal(helpers.resolveRoleId(guild, 'second'), 'new-2');
});
test('unrecoverable per-role form errors are reported without mapping a missing role or stopping other roles', async () => {
  const events = [];
  const guild = roleDestination(async (options) => {
    if (options.name === 'bad') throw Object.assign(new Error('Invalid Form Body\ncolors: invalid'), { code: 50035 });
  });
  await moduleAt('src/src/load.ts', { './util': helpers }).loadRoles(guild,
    { roles: [roleData('bad-id', 'bad'), roleData('good-id', 'good', 2)] }, { onEvent: (e) => events.push(e) });
  assert.equal(helpers.resolveRoleId(guild, 'bad-id'), undefined);
  assert.equal(helpers.resolveRoleId(guild, 'good-id'), 'new-1');
  assert.match(events.find((e) => e.kind === 'failed').reason, /bad-id/);
});
test('permission and network failures stop role creation with the affected role identified', async () => {
  const guild = roleDestination(async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); });
  await assert.rejects(moduleAt('src/src/load.ts', { './util': helpers }).loadRoles(guild,
    { roles: [roleData('owner-access', 'Admin')] }, {}), /owner-access.*Discord 50013/);
});
test('unmapped explicit role IDs do not fall back to an unrelated same-name role', async () => {
  let applied;
  const guild = { roles: { cache: new Collection([['wrong', { id: 'wrong', name: 'same' }]]) },
    channels: { create: async () => ({ permissionOverwrites: { set: async (permissions) => { applied = permissions; } } }) } };
  await helpers.loadCategory({ name: 'category', permissions: [
    { roleId: 'failed-source-role', roleName: 'same', allow: '8', deny: '0' }
  ] }, guild, {});
  assert.equal(applied.length, 0);
});
test('backup selection accepts displayed indices and actual IDs and validates missing entries', () => {
  const ids = ['1555032405105049603', '1555015008247742464'];
  assert.equal(cli.selectBackupId('1', ids), ids[0]);
  assert.equal(cli.selectBackupId('2', ids), ids[1]);
  assert.equal(cli.selectBackupId(ids[0], ids), ids[0]);
  assert.equal(cli.selectBackupId('', ids), undefined);
  assert.equal(cli.selectBackupId('0', ids), undefined);
  assert.throws(() => cli.selectBackupId('4', ids), /Selección no válida/);
  assert.throws(() => cli.selectBackupId('999999999999999999', ids), /Selección no válida/);
});
async function restoreSelectionFlow(t, selection, cancel = false) {
  const path = require('node:path');
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloner-restore-select-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldId = '1555015008247742464';
  const newId = '1555032405105049603';
  const targetId = '223456789012345678';
  const data = (id, timestamp) => ({ id, createdTimestamp: timestamp, purpose: 'destination', guildID: targetId,
    name: 'Liam server', roles: [], emojis: [], bans: [], channels: { categories: [], others: [] } });
  const snapshots = new Map([[oldId, data(oldId, 100)], [newId, data(newId, 200)]]);
  const reads = [];
  const writes = [];
  const prompts = [];
  const logs = [];
  const fakeBackup = { list: async () => [oldId, newId], create: async () => data('1555039999999999999', 300),
    load: async (source, guild, options) => {
      assert.equal(options.restoreSnapshot, true); assert.equal(options.maxMessagesPerChannel, 0); writes.push(source.id);
    } };
  const menu = moduleAt('src/cli.ts', {
    'node:fs': fs, 'node:path': path, './src/util': helpers,
    './src/index': { __esModule: true, default: fakeBackup, storageFolder: () => path.join(temporary, 'backups'),
      getBackupData: async (id) => { reads.push(id); if (!snapshots.has(id)) throw new Error('Unexpected missing snapshot'); return snapshots.get(id); },
      validateDestination: async () => {} }
  }, { console: { log: (text) => logs.push(text), error: (text) => logs.push(text) } });
  const answers = ['3', ...selection, ...(cancel ? [] : [targetId, 'CLONAR']), '0'];
  await menu.runMenu({ guilds: { fetch: async () => ({ id: targetId, name: 'Target' }) }, destroy() {} }, {
    question: (text, callback) => { prompts.push(text); assert.ok(answers.length, 'No unexpected extra question'); callback(answers.shift()); }, close() {}
  });
  return { reads, writes, prompts, logs, oldId, newId };
}
test('restoration displays saved backups first and selects the latest by list number', async (t) => {
  const result = await restoreSelectionFlow(t, ['1']);
  assert.deepEqual(result.writes, [result.newId]);
  assert.ok(result.logs.some((log) => log.includes('destino previo')));
  assert.equal(result.prompts.some((prompt) => prompt.includes('ID del respaldo')), false);
});
test('invalid backup number stays in the selector and never attempts to open 4.json', async (t) => {
  const result = await restoreSelectionFlow(t, ['4', '2']);
  assert.deepEqual(result.writes, [result.oldId]);
  assert.equal(result.reads.includes('4'), false);
  assert.ok(result.logs.some((log) => log.includes('Selección no válida')));
});
test('cancelling backup selection performs no restoration or destination snapshot', async (t) => {
  const result = await restoreSelectionFlow(t, ['0'], true);
  assert.deepEqual(result.writes, []);
  assert.equal(result.prompts.some((prompt) => prompt.includes('servidor donde restaurarlo')), false);
});
test('missing backup files show a recovery hint instead of raw ENOENT or a Discord error', async () => {
  await assert.rejects(restoreEngine([]).getBackupData('99999999999999999999999999'), /No existe el respaldo.*lista de respaldos/);
  assert.match(helpers.errorReason(Object.assign(new Error('no file'), { code: 'ENOENT' })), /^Error ENOENT:/);
});
