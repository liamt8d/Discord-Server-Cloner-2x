import type {
  Guild, GuildChannel, CategoryChannel, TextChannel, NewsChannel, VoiceChannel, StageChannel,
  ForumChannel, MediaChannel, ThreadChannel, Message, OverwriteData, GuildChannelCreateOptions,
  DefaultReactionEmoji, WebhookMessageOptions
} from 'discord.js-selfbot-v13';
import type {
  CategoryData, ChannelPermissionsData, CreateOptions, LoadOptions, MessageData,
  TextChannelData, VoiceChannelData, ForumChannelData, ThreadChannelData, CloneEvent
} from './types';
import { configOptions2 } from '../settings';

export type ChannelData = TextChannelData | VoiceChannelData | ForumChannelData;
const roles = new WeakMap<Guild, Map<string, string>>();
const channels = new WeakMap<Guild, Map<string, string>>();
const emojis = new WeakMap<Guild, Map<string, string>>();
const retained = new WeakMap<Guild, Set<string>>();
export function emit(options: LoadOptions, event: CloneEvent) { options.onEvent?.(event); }
export function errorReason(error: unknown): string {
  const value = error as { code?: number | string; message?: string };
  const prefix = typeof value?.code === 'number' ? `Discord ${value.code}: ` : value?.code ? `Error ${value.code}: ` : '';
  return `${prefix}${value?.message ?? String(error)}`;
}
export function startRoleRestore(guild: Guild) { roles.set(guild, new Map()); }
export function startChannelRestore(guild: Guild) { channels.set(guild, new Map()); emojis.set(guild, new Map()); }
export function rememberRole(guild: Guild, sourceId: string, targetId: string) {
  if (sourceId) roles.get(guild)?.set(sourceId, targetId);
}
export function rememberChannel(guild: Guild, sourceId: string, targetId: string) {
  if (!channels.has(guild)) channels.set(guild, new Map());
  if (sourceId) channels.get(guild)?.set(sourceId, targetId);
}
export function rememberEmoji(guild: Guild, sourceId: string, targetId: string) {
  if (!emojis.has(guild)) emojis.set(guild, new Map());
  if (sourceId) emojis.get(guild)?.set(sourceId, targetId);
}
export function resolveRoleId(guild: Guild, id: string): string | undefined {
  return roles.get(guild)?.get(id) ?? (guild.roles.cache.has(id) ? id : undefined);
}
export function resolveChannelId(guild: Guild, id: string): string | undefined {
  return channels.get(guild)?.get(id) ?? (guild.channels.cache.has(id) ? id : undefined);
}
export function resolveEmojiId(guild: Guild, id: string): string | undefined {
  return emojis.get(guild)?.get(id) ?? (guild.emojis.cache.has(id) ? id : undefined);
}
export function resetCommunityRetention(guild: Guild) { retained.delete(guild); }
export function communityChannelIds(guild: Guild): Set<string> {
  return new Set([guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId,
    ...(retained.get(guild) ?? [])].filter(Boolean));
}

export function fetchChannelPermissions(channel: GuildChannel): ChannelPermissionsData[] {
  return Array.from(channel.permissionOverwrites.cache.values()).map((perm) => ({
    type: perm.type, roleId: perm.type === 'role' ? perm.id : undefined,
    memberId: perm.type === 'member' ? perm.id : undefined,
    roleName: channel.guild.roles.cache.get(perm.id)?.name ?? '',
    allow: perm.allow.bitfield.toString(), deny: perm.deny.bitfield.toString()
  }));
}
async function permissionsFor(data: ChannelPermissionsData[], guild: Guild, options: LoadOptions): Promise<OverwriteData[]> {
  const result: OverwriteData[] = [];
  for (const perm of data) {
    if (perm.type === 'member') {
      try {
        await guild.members.fetch(perm.memberId);
        result.push({ id: perm.memberId, type: 'member', allow: BigInt(perm.allow), deny: BigInt(perm.deny) });
      } catch (error) {
        emit(options, { kind: 'skipped', feature: 'permisos de miembro', name: perm.memberId,
          reason: `El miembro no está disponible en el destino: ${errorReason(error)}` });
      }
      continue;
    }
    const mapped = perm.roleId && resolveRoleId(guild, perm.roleId);
    const legacyMatches = !perm.roleId ? guild.roles.cache.filter((r) => r.name === perm.roleName) : undefined;
    const role = mapped ? guild.roles.cache.get(mapped) : legacyMatches?.size === 1 ? legacyMatches.first() : undefined;
    if (role) result.push({ id: role.id, type: 'role', allow: BigInt(perm.allow), deny: BigInt(perm.deny) });
    else emit(options, { kind: 'skipped', feature: 'permisos de rol', name: perm.roleName,
      reason: 'No hay rol equivalente en el destino (por ejemplo, un rol administrado por un bot).' });
  }
  return result;
}

export async function fetchVoiceChannelData(channel: VoiceChannel | StageChannel): Promise<VoiceChannelData> {
  return { id: channel.id, type: channel.type, name: channel.name, position: channel.position,
    parent: channel.parent?.name, bitrate: channel.bitrate, userLimit: channel.userLimit,
    rtcRegion: channel.rtcRegion, videoQualityMode: channel.videoQualityMode,
    permissions: fetchChannelPermissions(channel) };
}
export async function fetchChannelMessages(channel: TextChannel | NewsChannel | ThreadChannel, options: CreateOptions): Promise<MessageData[]> {
  const limit = options.maxMessagesPerChannel ?? 100;
  if (!Number.isInteger(limit) || limit < -1) throw new Error('El límite de mensajes debe ser -1, 0 o un entero positivo.');
  const result: MessageData[] = [];
  let before: string;
  while (limit === -1 || result.length < limit) {
    const batch = await channel.messages.fetch({ limit: limit === -1 ? 100 : Math.min(100, limit - result.length),
      ...(before ? { before } : {}) });
    if (!batch.size || batch.last().id === before) break;
    before = batch.last().id;
    options.onProgress?.(`Historial de ${channel.name}: ${result.length + batch.size} mensajes leídos`);
    for (const message of batch.values()) {
      if (!message.author || (limit !== -1 && result.length >= limit)) continue;
      const stickerNames = message.stickers?.size ? Array.from(message.stickers.values()).map((s) => s.name) : [];
      result.push({ id: message.id, username: message.author.username, avatar: message.author.displayAvatarURL(),
        content: message.content || (stickerNames.length ? `[Sticker: ${stickerNames.join(', ')}]` : ''),
        embeds: message.embeds, files: Array.from(message.attachments.values()).map((a) => ({ name: a.name, attachment: a.url })),
        pinned: message.pinned });
    }
  }
  return result;
}

export async function fetchThreads(channel: TextChannel | NewsChannel | ForumChannel | MediaChannel, options: CreateOptions): Promise<ThreadChannelData[]> {
  const found = new Map<string, ThreadChannel>();
  for (const thread of channel.threads.cache.values()) found.set(thread.id, thread);
  if (typeof channel.threads.fetchActive === 'function') {
    for (const archived of [false, true]) {
      let offset = 0;
      while (true) {
        try {
          const page = await channel.threads.fetchActive(true, { archived, limit: 100, offset });
          let added = 0;
          for (const thread of page.threads.values()) {
            if (!found.has(thread.id)) added++;
            found.set(thread.id, thread);
          }
          if (!page.hasMore || !page.threads.size) break;
          offset += page.threads.size;
          // A repeated page should not turn into an endless backup.
          if (offset > 100 && added === 0) { options.onWarning?.(`Hilos de ${channel.name}: Discord repitió una página.`); break; }
        } catch (error) {
          options.onWarning?.(`Hilos ${archived ? 'archivados' : 'activos'} de ${channel.name}: ${errorReason(error)}`);
          break;
        }
      }
    }
  }
  const result: ThreadChannelData[] = [];
  for (const thread of found.values()) {
    try {
      result.push({ id: thread.id, type: thread.type, name: thread.name,
        archived: thread.archived, locked: thread.locked, invitable: thread.invitable,
        autoArchiveDuration: thread.autoArchiveDuration, rateLimitPerUser: thread.rateLimitPerUser,
        appliedTagNames: 'availableTags' in channel ? channel.availableTags.filter((tag) => thread.appliedTags.includes(tag.id)).map((tag) => tag.name) : [],
        messages: await fetchChannelMessages(thread, options) });
    } catch (error) {
      options.onWarning?.(`No se pudo respaldar el hilo ${thread.name}: ${errorReason(error)}`);
    }
  }
  return result;
}
export async function fetchTextChannelData(channel: TextChannel | NewsChannel, options: CreateOptions): Promise<TextChannelData> {
  return { id: channel.id, type: channel.type, name: channel.name, position: channel.position,
    nsfw: channel.nsfw, rateLimitPerUser: channel.rateLimitPerUser, parent: channel.parent?.name,
    topic: channel.topic, permissions: fetchChannelPermissions(channel),
    messages: await fetchChannelMessages(channel, options), isNews: channel.type === 'GUILD_NEWS',
    threads: options.includeThreads === false ? [] : await fetchThreads(channel, options) };
}
export function fetchForumChannelData(channel: ForumChannel | MediaChannel): ForumChannelData {
  return { id: channel.id, type: channel.type, name: channel.name, position: channel.position,
    parent: channel.parent?.name, topic: channel.topic ?? undefined, nsfw: channel.nsfw,
    permissions: fetchChannelPermissions(channel), rateLimitPerUser: channel.rateLimitPerUser ?? undefined,
    defaultThreadRateLimitPerUser: channel.defaultThreadRateLimitPerUser ?? undefined,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? undefined,
    defaultSortOrder: channel.defaultSortOrder ?? undefined,
    defaultForumLayout: channel.type === 'GUILD_FORUM' ? channel.defaultForumLayout : undefined,
    defaultReactionEmoji: channel.defaultReactionEmoji ?? undefined,
    availableTags: channel.availableTags.map((tag) => ({ name: tag.name, moderated: tag.moderated, emoji: tag.emoji })),
    threads: [] };
}
export async function loadCategory(data: CategoryData, guild: Guild, options: LoadOptions = { clearGuildBeforeRestore: true }) {
  const category = await guild.channels.create(data.name, { type: 'GUILD_CATEGORY', position: data.position });
  rememberChannel(guild, data.id, category.id);
  await category.permissionOverwrites.set(await permissionsFor(data.permissions, guild, options));
  emit(options, { kind: 'copied', feature: 'categorías', name: data.name });
  return category;
}
function portableEmoji(guild: Guild, emoji: DefaultReactionEmoji, options: LoadOptions, name: string): DefaultReactionEmoji | undefined {
  if (!emoji) return undefined;
  if (!emoji.id) return emoji;
  const id = resolveEmojiId(guild, emoji.id);
  if (id) return { id, name: emoji.name };
  emit(options, { kind: 'skipped', feature: 'emoji de foro', name, reason: 'No se pudo copiar el emoji personalizado.' });
  return undefined;
}
export async function loadChannel(data: ChannelData, guild: Guild, category?: CategoryChannel,
  options: LoadOptions = { clearGuildBeforeRestore: true }, existing?: TextChannel) {
  if (data.name.startsWith('ticket-') && configOptions2.ignoreTickets) {
    emit(options, { kind: 'skipped', feature: 'canales', name: data.name, reason: 'Ignorar tickets activado.' });
    return null;
  }
  const create: GuildChannelCreateOptions = { type: null, parent: category, position: data.position };
  if (data.type === 'GUILD_TEXT' || data.type === 'GUILD_NEWS') {
    const text = data as TextChannelData;
    Object.assign(create, { topic: text.topic, nsfw: text.nsfw, rateLimitPerUser: text.rateLimitPerUser,
      type: text.isNews && guild.features.includes('COMMUNITY') ? 'GUILD_NEWS' : 'GUILD_TEXT' });
    if (text.isNews && create.type === 'GUILD_TEXT') emit(options, { kind: 'skipped', feature: 'tipo anuncio', name: data.name,
      reason: 'El destino no tiene Comunidad; se crea un canal de texto.' });
  } else if (data.type === 'GUILD_FORUM' || data.type === 'GUILD_MEDIA') {
    const forum = data as ForumChannelData;
    Object.assign(create, { topic: forum.topic, nsfw: forum.nsfw, rateLimitPerUser: forum.rateLimitPerUser });
    if (guild.features.includes('COMMUNITY')) {
      create.type = forum.type;
      create.availableTags = forum.availableTags.map((tag) => ({ ...tag, id: undefined as string,
        emoji: options.deferForumEmojis ? null : portableEmoji(guild, tag.emoji, options, tag.name) ?? null }));
      create.defaultThreadRateLimitPerUser = forum.defaultThreadRateLimitPerUser;
      if (!options.deferForumEmojis) create.defaultReactionEmoji = portableEmoji(guild, forum.defaultReactionEmoji, options, forum.name);
      create.defaultSortOrder = forum.defaultSortOrder;
      if (forum.type === 'GUILD_FORUM') create.defaultForumLayout = forum.defaultForumLayout;
    } else {
      create.type = 'GUILD_TEXT';
      emit(options, { kind: 'skipped', feature: 'tipo foro/multimedia', name: forum.name, reason: 'Sin Comunidad; se crea canal de texto con hilos.' });
    }
  } else if (data.type === 'GUILD_VOICE' || data.type === 'GUILD_STAGE_VOICE') {
    const voice = data as VoiceChannelData;
    const tiers = { NONE: 64000, TIER_1: 128000, TIER_2: 256000, TIER_3: 384000 };
    create.type = data.type === 'GUILD_STAGE_VOICE' && guild.features.includes('COMMUNITY') ? 'GUILD_STAGE_VOICE' : 'GUILD_VOICE';
    create.bitrate = Math.min(voice.bitrate, guild.maximumBitrate ?? tiers[guild.premiumTier] ?? 64000);
    create.userLimit = Math.min(voice.userLimit ?? 0, 99);
    create.rtcRegion = voice.rtcRegion;
    if (data.type === 'GUILD_VOICE') create.videoQualityMode = voice.videoQualityMode;
    if (voice.bitrate > create.bitrate) emit(options, { kind: 'skipped', feature: 'bitrate', name: data.name, reason: 'Ajustado al límite de boosts del destino.' });
    if (data.type === 'GUILD_STAGE_VOICE' && create.type !== data.type) emit(options, { kind: 'skipped', feature: 'tipo escenario', name: data.name, reason: 'Sin Comunidad; se crea canal de voz.' });
  } else throw new Error(`Tipo de canal no soportado: ${data.type}`);
  let channel: GuildChannel;
  if (existing) channel = await existing.edit({ name: data.name, parent: category ?? null,
    topic: (data as TextChannelData).topic, nsfw: false, rateLimitPerUser: (data as TextChannelData).rateLimitPerUser });
  else {
    try { channel = await guild.channels.create(data.name, create) as GuildChannel; }
    catch (error) {
      // Media channels may need a server entitlement. Keep the posts in a forum.
      if (create.type !== 'GUILD_MEDIA' || ![50035, 50001, 50013, 50024].includes((error as { code?: number }).code)) throw error;
      create.type = 'GUILD_FORUM';
      emit(options, { kind: 'skipped', feature: 'tipo multimedia', name: data.name, reason: `Se crea como foro: ${errorReason(error)}` });
      channel = await guild.channels.create(data.name, create) as GuildChannel;
    }
  }
  rememberChannel(guild, data.id, channel.id);
  if (channel.type === 'GUILD_FORUM' || channel.type === 'GUILD_MEDIA') {
    const duration = (data as ForumChannelData).defaultAutoArchiveDuration;
    if (duration) await (channel as ForumChannel).setDefaultAutoArchiveDuration(duration);
  }
  await channel.permissionOverwrites.set(await permissionsFor(data.permissions, guild, options));
  emit(options, { kind: 'copied', feature: 'canales', name: data.name });
  return channel;
}
function remapContent(content: string, guild: Guild): string {
  return (content ?? '').replace(/<([#]|@&)(\d+)>/g, (original, type, id) => {
    const mapped = type === '#' ? resolveChannelId(guild, id) : resolveRoleId(guild, id);
    return mapped ? `<${type}${mapped}>` : original;
  }).replace(/<(a?):([A-Za-z0-9_]+):(\d+)>/g, (original, animated, name, id) => {
    const mapped = resolveEmojiId(guild, id);
    return mapped ? `<${animated}:${name}:${mapped}>` : original;
  });
}
function messagePayload(message: MessageData, guild: Guild, options: LoadOptions): WebhookMessageOptions {
  return { content: remapContent(message.content, guild) || undefined,
    username: message.username, avatarURL: message.avatar, embeds: message.embeds ?? [], files: message.files ?? [],
    allowedMentions: options.allowedMentions ?? { parse: [] } };
}
function history(messages: MessageData[], options: LoadOptions) {
  const limit = options.maxMessagesPerChannel ?? 100;
  return (limit === -1 ? messages : messages.slice(0, limit)).slice().reverse();
}
export async function loadMessages(channel: TextChannel | NewsChannel | ThreadChannel, messages: MessageData[], guild: Guild, options: LoadOptions) {
  const selected = history(messages ?? [], options);
  if (!selected.length) return;
  const parent = channel.isThread() ? channel.parent as TextChannel : channel;
  const webhook = await parent.createWebhook('Copia de comunidad');
  let count = 0;
  try {
    for (const message of selected) {
      if (!message.content && !message.embeds?.length && !message.files?.length) continue;
      try {
        const sent = await webhook.send({ ...messagePayload(message, guild, options), ...(channel.isThread() ? { threadId: channel.id } : {}) });
        count++;
        if (message.pinned) await (await channel.messages.fetch(sent.id)).pin();
      } catch (error) {
        emit(options, { kind: 'failed', feature: 'mensaje/adjunto', name: channel.name, reason: errorReason(error) });
      }
    }
  } finally {
    try { await webhook.delete(); }
    catch (error) { emit(options, { kind: 'failed', feature: 'limpieza de webhook', name: channel.name, reason: errorReason(error) }); }
  }
  emit(options, { kind: 'copied', feature: 'mensajes', name: channel.name, count });
}
export async function restoreForumEmojis(guild: Guild, data: ForumChannelData, options: LoadOptions) {
  const channel = guild.channels.cache.get(resolveChannelId(guild, data.id)) as ForumChannel | MediaChannel;
  if (!channel || !['GUILD_FORUM', 'GUILD_MEDIA'].includes(channel.type)) return;
  try {
    const availableTags = data.availableTags.map((tag, index) => ({ ...tag,
      id: channel.availableTags[index]?.id,
      emoji: portableEmoji(guild, tag.emoji, options, tag.name) ?? null }));
    await channel.edit({ availableTags,
      defaultReactionEmoji: portableEmoji(guild, data.defaultReactionEmoji, options, data.name) ?? null });
    emit(options, { kind: 'copied', feature: 'etiquetas de foros', name: data.name });
  } catch (error) { emit(options, { kind: 'failed', feature: 'etiquetas de foros', name: data.name, reason: errorReason(error) }); }
}
export async function restoreChannelHistory(channel: GuildChannel, data: ChannelData, guild: Guild, options: LoadOptions) {
  if (data.type === 'GUILD_VOICE' || data.type === 'GUILD_STAGE_VOICE') return;
  const text = data as TextChannelData;
  if (text.messages?.length) await loadMessages(channel as TextChannel, text.messages, guild, options);
  for (const source of text.threads ?? []) {
    try {
      let thread: ThreadChannel;
      const forum = channel.type === 'GUILD_FORUM' || channel.type === 'GUILD_MEDIA';
      const appliedTags = forum ? (channel as ForumChannel).availableTags.filter((tag) => source.appliedTagNames?.includes(tag.name)).map((tag) => tag.id) : [];
      const selected = history(source.messages ?? [], options);
      if (forum && selected.length) {
        const webhook = await (channel as ForumChannel).createWebhook('Copia de publicaciones');
        try {
          const first = selected.shift();
          const sent = await webhook.send({ ...messagePayload(first, guild, options),
            content: remapContent(first.content, guild) || (!first.embeds?.length && !first.files?.length ? `Publicación: ${source.name}` : undefined),
            threadName: source.name, appliedTags });
          const id = (sent as Message).channelId ?? (sent as unknown as { channel_id: string }).channel_id;
          thread = await guild.channels.fetch(id) as ThreadChannel;
          if (first.pinned) await (await thread.messages.fetch(sent.id)).pin();
          emit(options, { kind: 'copied', feature: 'mensajes', name: source.name, count: 1 });
        } finally { await webhook.delete(); }
        await loadMessages(thread, selected.slice().reverse(), guild, { ...options, maxMessagesPerChannel: -1 });
      } else if (forum) {
        thread = await (channel as ForumChannel).threads.create({ name: source.name,
          message: { content: `Publicación recreada: ${source.name}`, allowedMentions: { parse: [] } },
          appliedTags, autoArchiveDuration: source.autoArchiveDuration });
      } else {
        const base = { name: source.name, autoArchiveDuration: source.autoArchiveDuration };
        thread = channel.type === 'GUILD_NEWS'
          ? await (channel as NewsChannel).threads.create(base)
          : await (channel as TextChannel).threads.create({ ...base,
            type: source.type === 'GUILD_PRIVATE_THREAD' ? 'GUILD_PRIVATE_THREAD' : 'GUILD_PUBLIC_THREAD',
            ...(source.type === 'GUILD_PRIVATE_THREAD' ? { invitable: source.invitable } : {}) });
        await loadMessages(thread, source.messages, guild, options);
      }
      rememberChannel(guild, source.id, thread.id);
      if (source.rateLimitPerUser) await thread.setRateLimitPerUser(source.rateLimitPerUser);
      if (source.archived) await thread.setArchived(true);
      if (source.locked) await thread.setLocked(true);
      emit(options, { kind: 'copied', feature: 'hilos/publicaciones', name: source.name });
    } catch (error) { emit(options, { kind: 'failed', feature: 'hilos/publicaciones', name: source.name, reason: errorReason(error) }); }
  }
}
export async function clearGuild(guild: Guild, excluded: string[] = [], options: LoadOptions = { clearGuildBeforeRestore: true }) {
  if (!excluded.includes('channels')) {
    await guild.setAFKChannel(null);
    await guild.setSystemChannel(null);
    await guild.setWidgetSettings({ enabled: false, channel: null });
    const protectedIds = communityChannelIds(guild);
    retained.set(guild, protectedIds);
    for (const channel of Array.from(guild.channels.cache.values())) {
      if (protectedIds.has(channel.id)) continue;
      emit(options, { kind: 'progress', feature: 'limpieza', name: `Canal: ${channel.name ?? channel.id}`, current: 0 });
      try { await channel.delete(); }
      catch (error) {
        if ((error as { code?: number }).code !== 50074) throw error;
        protectedIds.add(channel.id);
      }
    }
  }
  for (const role of Array.from(guild.roles.cache.values())) {
    if (!excluded.includes('roles') && !role.managed && role.id !== guild.id) {
      if (!role.editable) throw new Error(`No se puede borrar el rol ${role.name}.`);
      emit(options, { kind: 'progress', feature: 'limpieza', name: `Rol: ${role.name}`, current: 0 });
      await role.delete();
    }
  }
  const reusable = new Set(Object.values(options.reuseEmojiIds ?? {}));
  if (!excluded.includes('emojis')) for (const emoji of Array.from(guild.emojis.cache.values())) {
    if (reusable.has(emoji.id)) continue;
    if (emoji.managed) {
      emit(options, { kind: 'skipped', feature: 'limpieza de emojis', name: emoji.name, reason: 'El emoji pertenece a una integración; Discord no permite eliminarlo directamente.' });
      continue;
    }
    emit(options, { kind: 'progress', feature: 'limpieza', name: `Emoji: ${emoji.name}`, current: 0 });
    await emoji.delete();
    guild.emojis.cache.delete(emoji.id);
  }
}
