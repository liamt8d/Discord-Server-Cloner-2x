import nodeFetch from 'node-fetch';
import type { Guild, GuildScheduledEventCreateOptions } from 'discord.js-selfbot-v13';
import type { BackupData, CreateOptions, LoadOptions, AutoModData, OnboardingData, ScreeningData } from './types';
import { emit, errorReason, resolveChannelId, resolveRoleId, resolveEmojiId, resetCommunityRetention } from './util';
import { assetError, imageBytes, mapLimited, stickerCapacity } from '../assets';

// Use the client's authenticated, rate-limited REST router. The raw AutoMod shape
// preserves trigger types/metadata newer than this library's enum definitions.
function route(guild: Guild): any { return (guild.client.api as any).guilds(guild.id); }
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function remapAutoMod(rule: AutoModData, guild: Guild) {
  const channel = (id: string) => {
    const mapped = resolveChannelId(guild, id);
    if (!mapped) throw new Error(`No se encuentra el canal ${id}; no se amplían las excepciones de la regla.`);
    return mapped;
  };
  const role = (id: string) => {
    const mapped = resolveRoleId(guild, id);
    if (!mapped) throw new Error(`No se encuentra el rol exento ${id}; la regla se omite para no afectar a más personas.`);
    return mapped;
  };
  return {
    name: rule.name, event_type: rule.event_type, trigger_type: rule.trigger_type,
    trigger_metadata: plain(rule.trigger_metadata ?? {}), enabled: rule.enabled,
    exempt_roles: (rule.exempt_roles ?? []).map(role),
    exempt_channels: (rule.exempt_channels ?? []).map(channel),
    actions: rule.actions.map((action) => ({ ...plain(action), metadata: {
      ...(action.metadata ?? {}), ...(action.metadata?.channel_id ? { channel_id: channel(action.metadata.channel_id) } : {})
    } }))
  };
}
export function remapOnboarding(source: OnboardingData, guild: Guild): OnboardingData {
  const map = (id: string, type: 'channel' | 'role') => {
    const mapped = type === 'channel' ? resolveChannelId(guild, id) : resolveRoleId(guild, id);
    if (!mapped) throw new Error(`Onboarding: ${type === 'channel' ? 'canal' : 'rol'} ${id} no disponible en el destino.`);
    return mapped;
  };
  return { enabled: source.enabled, mode: source.mode,
    default_channel_ids: source.default_channel_ids.map((id) => map(id, 'channel')),
    prompts: source.prompts.map((prompt) => ({
      id: '0', type: prompt.type, title: prompt.title, single_select: prompt.single_select,
      required: prompt.required, in_onboarding: prompt.in_onboarding,
      options: prompt.options.map((option) => {
        const emojiId = option.emoji?.id && resolveEmojiId(guild, option.emoji.id);
        if (option.emoji?.id && !emojiId) throw new Error(`Onboarding: emoji ${option.emoji.id} no copiado.`);
        return { id: '0', title: option.title, description: option.description,
          channel_ids: option.channel_ids.map((id) => map(id, 'channel')),
          role_ids: option.role_ids.map((id) => map(id, 'role')),
          ...(option.emoji ? { emoji: { ...option.emoji, ...(emojiId ? { id: emojiId } : {}) } } : {}) };
      })
    })) };
}
export async function captureCommunity(guild: Guild, backup: BackupData, options: CreateOptions) {
  const capture = async (name: string, action: () => Promise<void>) => {
    options.onProgress?.(name);
    try { await action(); }
    catch (error) {
      if (name === 'Lectura de reglas de acceso' && (error as { code?: number }).code === 10068) {
        backup.screening = { enabled: false, form_fields: [] }; return;
      }
      options.onWarning?.(`${name}: ${errorReason(error)}`);
    }
  };
  const excluded = options.doNotBackup ?? [];
  if (!excluded.includes('memberRoles')) await capture('Lectura de roles de miembros', async () => {
    const members = await guild.members.fetch();
    backup.memberRoles = Array.from(members.values()).map((member) => ({ userId: member.id,
      roleIds: Array.from(member.roles.cache.values()).filter((r) => !r.managed && r.id !== guild.id).map((r) => r.id) }));
  });
  if (!excluded.includes('autoMod')) await capture('Lectura de AutoMod', async () => {
    backup.autoMod = plain(await route(guild)['auto-moderation'].rules.get());
  });
  if (!excluded.includes('stickers')) await capture('Lectura de stickers', async () => {
    const stickers = await guild.stickers.fetch();
    backup.stickers = await mapLimited(Array.from(stickers.values()), 4, async (s) => {
      const data = { name: s.name, description: s.description ?? undefined, tags: s.tags?.join(',') || '🙂', url: s.url, format: s.format, base64: undefined as string };
      if (options.saveImages === 'base64' && s.format !== 'LOTTIE') {
        try {
          data.base64 = (await imageBytes(nodeFetch, s.url)).toString('base64');
        } catch (error) { options.onWarning?.(`Imagen del sticker ${s.name}: ${errorReason(error)}`); }
      }
      return data;
    });
  });
  if (!excluded.includes('bans')) await capture('Lectura de baneos', async () => {
    const bans: BackupData['bans'] = [];
    let after: string;
    while (true) {
      const batch = await guild.bans.fetch({ limit: 1000, ...(after ? { after } : {}) });
      for (const ban of batch.values()) bans.push({ id: ban.user.id, reason: ban.reason });
      if (batch.size < 1000 || batch.last().user.id === after) break;
      after = batch.last().user.id;
    }
    backup.bans = bans;
  });
  if (!excluded.includes('events')) await capture('Lectura de eventos', async () => {
    const events = await guild.scheduledEvents.fetch();
    backup.scheduledEvents = Array.from(events.values()).map((event) => {
      const recurrence = event.recurrenceRule;
      const recurrenceRule = recurrence ? {
        startAt: new Date(recurrence.startTimestamp).toISOString(), interval: recurrence.interval, frequency: recurrence.frequency,
        ...(recurrence.byWeekday ? { byWeekday: recurrence.byWeekday } : {}),
        ...(recurrence.byNWeekday ? { byNWeekday: recurrence.byNWeekday } : {}),
        ...(recurrence.byMonth ? { byMonth: recurrence.byMonth } : {}),
        ...(recurrence.byMonthDay ? { byMonthDay: recurrence.byMonthDay } : {})
      } as GuildScheduledEventCreateOptions['recurrenceRule'] : undefined;
      if (recurrence?.count || recurrence?.endTimestamp || recurrence?.byYearDay) {
        options.onWarning?.(`Evento ${event.name}: la biblioteca no admite todos los límites de recurrencia; no se copiará ese evento.`);
        return undefined;
      }
      return { id: event.id, name: event.name, start: event.scheduledStartTimestamp,
        end: event.scheduledEndTimestamp ?? undefined, channelId: event.channelId ?? undefined,
        description: event.description ?? undefined, entityType: event.entityType, privacyLevel: event.privacyLevel,
        entityMetadata: event.entityMetadata, image: event.coverImageURL() ?? undefined, recurrenceRule };
    }).filter(Boolean);
  });
  if (!guild.features.includes('COMMUNITY')) return;
  if (!excluded.includes('welcome')) await capture('Lectura de bienvenida', async () => {
    const welcome = await guild.fetchWelcomeScreen();
    backup.welcome = { enabled: welcome.enabled, description: welcome.description ?? undefined,
      channels: Array.from(welcome.welcomeChannels.values()).map((channel) => ({
        channelId: channel.channelId, description: channel.description,
        emojiId: channel.emoji.id ?? undefined, emojiName: channel.emoji.name ?? undefined
      })) };
  });
  if (!excluded.includes('onboarding')) await capture('Lectura de onboarding', async () => {
    backup.onboarding = plain(await route(guild).onboarding.get());
  });
  if (!excluded.includes('screening')) await capture('Lectura de reglas de acceso', async () => {
    const data = await route(guild)['member-verification'].get();
    backup.screening = { description: data.description, form_fields: plain(data.form_fields ?? []),
      enabled: guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED') };
  });
}

export async function prepareCommunity(guild: Guild, backup: BackupData, options: LoadOptions) {
  if (options.restoreSnapshot && backup.isCommunity === false && guild.features.includes('COMMUNITY')) {
    await guild.setCommunity(false);
    await guild.setSafetyAlertsChannel(null);
    resetCommunityRetention(guild);
    emit(options, { kind: 'copied', feature: 'Comunidad', name: 'Restaurada al estado desactivado del respaldo' });
    return;
  }
  if (!backup.isCommunity || !options.enableCommunity || guild.features.includes('COMMUNITY')) return;
  const created: { delete(): Promise<unknown> }[] = [];
  try {
    const rules = await guild.channels.create('reglas-copia', { type: 'GUILD_TEXT' });
    created.push(rules);
    const updates = await guild.channels.create('avisos-copia', { type: 'GUILD_TEXT' });
    created.push(updates);
    await guild.setCommunity(true, updates, rules, 'Preparación de copia de comunidad');
    emit(options, { kind: 'copied', feature: 'Comunidad', name: 'Activada automáticamente' });
  } catch (error) {
    // Community creation is atomic in the API. Only remove unused temporary channels.
    if (!guild.features.includes('COMMUNITY')) for (const channel of created) {
      try { await channel.delete(); } catch { /* Report the preparation failure below. */ }
    }
    emit(options, { kind: 'failed', feature: 'activar Comunidad', reason: errorReason(error) });
  }
}

export async function restoreCommunity(guild: Guild, backup: BackupData, options: LoadOptions) {
  const attempt = async (feature: string, name: string, action: () => Promise<unknown>) => {
    try { await action(); emit(options, { kind: 'copied', feature, name }); }
    catch (error) { emit(options, { kind: 'failed', feature, name, reason: errorReason(error) }); }
  };
  if (backup.autoMod) {
    let existing: AutoModData[];
    try { existing = await route(guild)['auto-moderation'].rules.get(); }
    catch (error) { emit(options, { kind: 'failed', feature: 'AutoMod', reason: errorReason(error) }); }
    if (existing) {
      const consumed = new Set<string>();
      let failed = false;
      for (const source of backup.autoMod) {
        try {
          const payload = remapAutoMod(source, guild);
          const match = existing.find((r) => r.name === source.name && r.trigger_type === source.trigger_type && !consumed.has(r.id)) ??
            (options.clearGuildBeforeRestore !== false ? existing.find((r) => r.trigger_type === source.trigger_type && !consumed.has(r.id)) : undefined);
          if (match) {
            // trigger_type cannot be edited; it was checked when selecting the match.
            const { trigger_type, ...edit } = payload;
            await route(guild)['auto-moderation'].rules(match.id).patch({ data: edit });
            consumed.add(match.id);
          } else await route(guild)['auto-moderation'].rules.post({ data: payload });
          emit(options, { kind: 'copied', feature: 'AutoMod', name: source.name });
        } catch (error) {
          failed = true;
          emit(options, { kind: 'failed', feature: 'AutoMod', name: source.name, reason: errorReason(error) });
        }
      }
      // If any rule failed, keep unmatched destination rules as a fallback.
      if (options.clearGuildBeforeRestore !== false && !failed) for (const rule of existing) {
        if (!consumed.has(rule.id)) await attempt('reglas anteriores retiradas', rule.name,
          () => route(guild)['auto-moderation'].rules(rule.id).delete());
      }
    }
  }
  if (backup.stickers && options.clearGuildBeforeRestore !== false) {
    try {
      const previous = await guild.stickers.fetch();
      for (const sticker of Array.from(previous.values())) await attempt('stickers anteriores retirados', sticker.name, async () => {
        emit(options, { kind: 'progress', feature: 'limpieza de stickers', name: sticker.name, current: 0 });
        await sticker.delete();
        guild.stickers.cache.delete(sticker.id);
      });
    } catch (error) { emit(options, { kind: 'failed', feature: 'limpieza de stickers', reason: errorReason(error) }); }
  }
  const stickerLimit = stickerCapacity(guild);
  let stickersUsed = guild.stickers?.cache.size ?? 0;
  let stickerStop: string;
  for (const [index, sticker] of (backup.stickers ?? []).entries()) {
    emit(options, { kind: 'progress', feature: 'stickers', name: sticker.name, current: index + 1, total: backup.stickers.length });
    if (sticker.format === 'LOTTIE') {
      emit(options, { kind: 'skipped', feature: 'stickers', name: sticker.name, reason: 'Discord no admite importar stickers Lottie en este destino.' });
      continue;
    }
    const match = guild.stickers.cache.find((s) => s.name === sticker.name);
    if (stickerStop || (!match && stickersUsed >= stickerLimit)) {
      emit(options, { kind: 'skipped', feature: 'stickers', name: sticker.name,
        reason: stickerStop ?? `Cupo de stickers lleno (${stickerLimit}); el destino necesita más espacios/boosts.` });
      continue;
    }
    try {
      if (match) await match.edit({ name: sticker.name, description: sticker.description, tags: sticker.tags });
      else { await guild.stickers.create(sticker.base64
        ? { attachment: Buffer.from(sticker.base64, 'base64'), name: `sticker.${sticker.format === 'GIF' ? 'gif' : 'png'}` }
        : { attachment: await imageBytes(nodeFetch, sticker.url), name: `sticker.${sticker.format === 'GIF' ? 'gif' : 'png'}` },
        sticker.name, sticker.tags, { description: sticker.description }); stickersUsed++; }
      emit(options, { kind: 'copied', feature: 'stickers', name: sticker.name });
    } catch (error) {
      const value = error as { code?: number; name?: string; httpStatus?: number };
      const reason = assetError(error);
      emit(options, { kind: 'failed', feature: 'stickers', name: sticker.name, reason });
      if ([30039, 50013, 50001].includes(value.code) || [401, 403].includes(value.httpStatus) || value.name === 'RateLimitError') stickerStop = reason;
    }
  }
  for (const ban of backup.bans ?? []) {
    if (ban.id === guild.client.user.id || ban.id === guild.ownerId) {
      emit(options, { kind: 'skipped', feature: 'baneos', name: ban.id, reason: 'No se banea al propietario ni a la cuenta que ejecuta la copia.' });
      continue;
    }
    await attempt('baneos', ban.id, () => guild.bans.create(ban.id, { reason: ban.reason, deleteMessageSeconds: 0 }));
  }
  for (const event of backup.scheduledEvents ?? []) {
    if (!event.start || event.start <= Date.now()) {
      emit(options, { kind: 'skipped', feature: 'eventos', name: event.name, reason: 'El evento ya comenzó o su fecha quedó en el pasado.' });
      continue;
    }
    await attempt('eventos', event.name, async () => {
      const channel = event.channelId && resolveChannelId(guild, event.channelId);
      if (event.channelId && !channel) throw new Error('No se encuentra el canal del evento.');
      return guild.scheduledEvents.create({ name: event.name, description: event.description,
        scheduledStartTime: event.start, scheduledEndTime: event.end, privacyLevel: event.privacyLevel,
        entityType: event.entityType, entityMetadata: event.entityMetadata, channel: channel || undefined,
        image: event.image, recurrenceRule: event.recurrenceRule });
    });
  }
  if (backup.memberRoles) {
    emit(options, { kind: 'progress', feature: 'roles de miembros existentes' });
    try {
      const members = await guild.members.fetch();
      let missing = 0;
      for (const [index, source] of backup.memberRoles.entries()) {
        const member = members.get(source.userId);
        if (!member) { missing++; continue; }
        emit(options, { kind: 'progress', feature: 'roles de miembros existentes', name: member.user.username,
          current: index + 1, total: backup.memberRoles.length });
        if (member.id === guild.client.user.id && member.id !== guild.ownerId) {
          emit(options, { kind: 'skipped', feature: 'roles de la cuenta ejecutora', reason: 'Se conserva su acceso administrativo durante la copia.' });
          continue;
        }
        await attempt('roles de miembros existentes', member.user.username, async () => {
          const mapped = source.roleIds.map((id) => resolveRoleId(guild, id));
          if (mapped.some((id) => !id)) throw new Error('Falta un rol equivalente; se conservan los roles actuales del miembro.');
          const managed = Array.from(member.roles.cache.values()).filter((r) => r.managed).map((r) => r.id);
          return member.roles.set(Array.from(new Set([...managed, ...mapped])), 'Copia de roles de comunidad');
        });
      }
      if (missing) emit(options, { kind: 'skipped', feature: 'miembros no transferibles', count: missing,
        reason: `${missing} miembros del origen no están en el destino. Discord no permite trasladarlos automáticamente.` });
    } catch (error) { emit(options, { kind: 'failed', feature: 'roles de miembros existentes', reason: errorReason(error) }); }
  }
  if (!guild.features.includes('COMMUNITY')) {
    if (backup.welcome || backup.onboarding || backup.screening) emit(options, { kind: 'skipped', feature: 'bienvenida/onboarding/reglas de acceso', reason: 'Comunidad no está activada en el destino.' });
    return;
  }
  emit(options, { kind: 'progress', feature: 'ajustes de Comunidad' });
  for (const key of ['rulesChannelId', 'publicUpdatesChannelId', 'safetyAlertsChannelId'] as const) {
    const id = backup.community?.[key];
    if (!id) continue;
    await attempt('canales de Comunidad', key, async () => {
      const mapped = resolveChannelId(guild, id);
      if (!mapped) throw new Error('No se pudo resolver el canal equivalente.');
      if (key === 'rulesChannelId') return guild.setRulesChannel(mapped);
      if (key === 'publicUpdatesChannelId') return guild.setPublicUpdatesChannel(mapped);
      return guild.setSafetyAlertsChannel(mapped);
    });
  }
  if (backup.welcome) await attempt('bienvenida', 'pantalla de bienvenida', async () => {
    const welcomeChannels = backup.welcome.channels.map((channel) => {
      const mapped = resolveChannelId(guild, channel.channelId);
      if (!mapped) throw new Error(`No se encuentra el canal de bienvenida ${channel.channelId}.`);
      const emoji = channel.emojiId ? resolveEmojiId(guild, channel.emojiId) : channel.emojiName;
      if (channel.emojiId && !emoji) throw new Error('No se pudo copiar un emoji de bienvenida.');
      return { channel: mapped, description: channel.description, emoji };
    });
    return guild.editWelcomeScreen({ enabled: backup.welcome.enabled, description: backup.welcome.description, welcomeChannels });
  });
  if (backup.onboarding) await attempt('onboarding', 'preguntas y canales predeterminados',
    () => route(guild).onboarding.put({ data: remapOnboarding(backup.onboarding, guild) }));
  if (backup.screening) await attempt('reglas de acceso', 'formulario de admisión', async () => {
    if (backup.screening.enabled !== false || backup.screening.form_fields.length) {
      await route(guild)['member-verification'].patch({ data: {
        description: backup.screening.description, form_fields: backup.screening.form_fields
      } });
    }
    const enabled = backup.screening.enabled;
    if (enabled !== undefined && enabled !== guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED')) await guild.edit({ features: enabled
      ? Array.from(new Set([...guild.features, 'MEMBER_VERIFICATION_GATE_ENABLED'])) as Guild['features']
      : guild.features.filter((f) => f !== 'MEMBER_VERIFICATION_GATE_ENABLED') });
  });
}
