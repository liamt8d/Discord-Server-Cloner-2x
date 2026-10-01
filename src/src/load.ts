import type { Emoji, Guild, Role, VoiceChannel, TextChannel } from 'discord.js-selfbot-v13';
import nodeFetch from 'node-fetch';
import type { BackupData, CategoryData, LoadOptions, TextChannelData, VoiceChannelData } from './types';
import { loadCategory, loadChannel, startRoleRestore, rememberRole, communityChannelIds, emit, errorReason, rememberEmoji, resolveRoleId, resolveChannelId, restoreChannelHistory } from './util';
import { animatedEmoji, assetError, emojiCapacity, imageBytes, imageDataUri } from '../assets';
import { normaliseRoleName } from '../roles';
/**
 * Restores the guild configuration
 */
export const loadConfig = async (guild: Guild, data: BackupData, options: LoadOptions = { clearGuildBeforeRestore: true }) => {
    await guild.setName(data.name);
    const apply = async (name: string, action: () => Promise<unknown>) => {
        try { await action(); emit(options, { kind: 'copied', feature: 'ajustes', name }); }
        catch (error) { emit(options, { kind: 'failed', feature: 'ajustes', name, reason: errorReason(error) }); }
    };
    if (data.iconBase64 || data.iconURL) await apply('icono', () => guild.setIcon(data.iconBase64 ? Buffer.from(data.iconBase64, 'base64') : data.iconURL));
    if (data.splashBase64 || data.splashURL) {
        if (guild.features.includes('INVITE_SPLASH')) await apply('fondo de invitación', () => guild.setSplash(data.splashBase64 ? Buffer.from(data.splashBase64, 'base64') : data.splashURL));
        else emit(options, { kind: 'skipped', feature: 'fondo de invitación', reason: 'El destino no tiene el nivel de boosts/función requerido.' });
    }
    if (data.bannerBase64 || data.bannerURL) {
        if (guild.features.includes('BANNER')) await apply('banner', () => guild.setBanner(data.bannerBase64 ? Buffer.from(data.bannerBase64, 'base64') : data.bannerURL));
        else emit(options, { kind: 'skipped', feature: 'banner', reason: 'El destino no admite banners.' });
    }
    if (data.verificationLevel !== undefined) await apply('verificación', () => guild.setVerificationLevel(
        guild.features.includes('COMMUNITY') && data.verificationLevel === 'NONE' ? 'LOW' : data.verificationLevel));
    if (data.defaultMessageNotifications !== undefined) await apply('notificaciones', () => guild.setDefaultMessageNotifications(
        guild.features.includes('COMMUNITY') ? 'ONLY_MENTIONS' : data.defaultMessageNotifications));
    if (data.explicitContentFilter !== undefined) await apply('filtro de contenido', () => guild.setExplicitContentFilter(
        guild.features.includes('COMMUNITY') ? 'ALL_MEMBERS' : data.explicitContentFilter));
    if (data.description !== undefined || data.preferredLocale !== undefined) await apply('descripción/idioma', () => guild.edit({
        description: data.description, preferredLocale: data.preferredLocale }));
    if (data.premiumProgressBarEnabled !== undefined) await apply('barra de boosts', () => guild.setPremiumProgressBarEnabled(data.premiumProgressBarEnabled));
};

/**
 * Restore the guild roles
 */
export const loadRoles = async (guild: Guild, backupData: BackupData, restoreOptions: LoadOptions = { clearGuildBeforeRestore: true }): Promise<Role[]> => {
    startRoleRestore(guild);
    const roles: Role[] = [];
    for (const managed of backupData.managedRoles ?? []) {
        const equivalent = managed.botId ? guild.roles.botRoleFor(managed.botId) : managed.premium ? guild.roles.premiumSubscriberRole : undefined;
        if (equivalent) rememberRole(guild, managed.id, equivalent.id);
        else emit(restoreOptions, { kind: "skipped", feature: "rol administrado", name: managed.name, reason: "El bot o la función correspondiente no está presente en el destino; no se puede importar ese rol administrado." });
    }
    const positions: { role: Role; position: number }[] = [];
    const all = [...backupData.roles].sort((a, b) => a.position - b.position);
    for (const [index, data] of all.entries()) {
        const normalised = normaliseRoleName(data.name, `rol-${index + 1}`);
        emit(restoreOptions, { kind: 'progress', feature: 'roles', name: normalised.name, current: index + 1, total: all.length });
        if (normalised.changed && !data.isEveryone) emit(restoreOptions, { kind: 'skipped', feature: 'nombre de rol ajustado',
            name: normalised.name, reason: normalised.reason });
        const options = {
            name: normalised.name, colors: { primaryColor: data.color ?? '#000000' }, hoist: data.hoist,
            permissions: BigInt(data.permissions), mentionable: data.mentionable,
            ...(guild.features.includes("ROLE_ICONS") ? { icon: data.iconURL, unicodeEmoji: data.unicodeEmoji } : {})
        };
        let role: Role;
        try {
            if (data.isEveryone) role = await guild.roles.everyone.edit({ permissions: options.permissions });
            else {
                try { role = await guild.roles.create(options); }
                catch (error) {
                    if ((error as { code?: number }).code !== 50035 || !/\bname\s*:/i.test((error as Error).message)) throw error;
                    // A confirmed rejection did not create a role. Retry once with a plain name.
                    options.name = `rol-${index + 1}`;
                    emit(restoreOptions, { kind: 'skipped', feature: 'nombre de rol ajustado', name: options.name,
                        reason: `Discord rechazó el nombre original; se reintenta con un nombre simple. Rol de origen: ${data.id ?? index + 1}.` });
                    role = await guild.roles.create(options);
                }
            }
        } catch (error) {
            const reason = `Rol ${JSON.stringify(data.name)} (${data.id ?? index + 1}): ${errorReason(error)}`;
            if (!data.isEveryone && (error as { code?: number }).code === 50035) {
                emit(restoreOptions, { kind: 'failed', feature: 'roles', name: options.name, reason });
                continue;
            }
            throw new Error(reason);
        }
        rememberRole(guild, data.id, role.id);
        roles.push(role);
        emit(restoreOptions, { kind: "copied", feature: "roles", name: options.name });
        if (!guild.features.includes("ROLE_ICONS") && (data.iconURL || data.unicodeEmoji)) emit(restoreOptions, { kind: "skipped", feature: "icono de rol", name: data.name, reason: "El destino no admite iconos de roles." });
        if (!data.isEveryone) positions.push({ role, position: data.position });
    }
    if (positions.length) {
        try { await guild.roles.setPositions(positions); }
        catch (error) { emit(restoreOptions, { kind: 'failed', feature: 'orden de roles', reason: errorReason(error) }); }
    }
    return roles;
};

/**
 * Restore the guild channels
 */
export const loadChannels = async (guild: Guild, backupData: BackupData, options: LoadOptions): Promise<unknown[]> => {
    const results: unknown[] = [];
    const histories: { channel: import("discord.js-selfbot-v13").GuildChannel; data: import("./util").ChannelData }[] = [];
    const reusable = new Map<string, TextChannel>();
    const claimed = new Set<string>();
    let progress = 0;
    const total = backupData.channels.categories.reduce((n, c) => n + 1 + c.children.length, 0) + backupData.channels.others.length;
    const pending = (name: string) => emit(options, { kind: 'progress', feature: 'canales', name, current: ++progress, total });
    if (options.clearGuildBeforeRestore !== false && !backupData.excluded?.includes('channels')) {
        const allData = [...backupData.channels.categories.flatMap((c) => c.children), ...backupData.channels.others];
        const protectedIds = communityChannelIds(guild);
        for (const source of protectedIds.size ? allData : []) {
            if (source.type !== 'GUILD_TEXT' || (source as TextChannelData).nsfw) continue;
            let targetId: string;
            for (const key of ['rulesChannelId', 'publicUpdatesChannelId', 'safetyAlertsChannelId'] as const) {
                if (source.id && source.id === backupData.community?.[key]) targetId = guild[key];
            }
            const target = (targetId && guild.channels.cache.get(targetId)) ||
                guild.channels.cache.find((ch) => protectedIds.has(ch.id) && ch.name === source.name && !claimed.has(ch.id));
            if (target?.type === 'GUILD_TEXT' && !claimed.has(target.id)) {
                reusable.set(source.id ?? source.name, target as TextChannel);
                claimed.add(target.id);
            }
        }
    }
    for (const categoryData of backupData.channels.categories) {
        pending(categoryData.name);
        const category = await loadCategory(categoryData, guild, options);
        for (const channelData of categoryData.children) {
            pending(channelData.name);
            const channel = await loadChannel(channelData, guild, category, options, reusable.get(channelData.id ?? channelData.name));
            results.push(channel);
            if (channel) histories.push({ channel, data: channelData });
        }
    }
    for (const channelData of backupData.channels.others) {
        pending(channelData.name);
        const channel = await loadChannel(channelData, guild, null, options, reusable.get(channelData.id ?? channelData.name));
        results.push(channel);
        if (channel) histories.push({ channel, data: channelData });
    }
    for (const { channel, data } of histories) await restoreChannelHistory(channel, data, guild, options);
    if (backupData.systemChannelId) {
        const id = resolveChannelId(guild, backupData.systemChannelId);
        if (id) await guild.setSystemChannel(id);
    }
    if (backupData.systemChannelFlags !== undefined) await guild.setSystemChannelFlags(Number(backupData.systemChannelFlags));
    return results;
};

/**
 * Restore the afk configuration
 */
export const loadAFK = async (guild: Guild, data: BackupData): Promise<Guild[]> => {
    const result: Guild[] = [];
    if (data.afk) {
        const id = data.afk.channelId ? resolveChannelId(guild, data.afk.channelId)
            : guild.channels.cache.find((c) => c.type === 'GUILD_VOICE' && c.name === data.afk.name)?.id;
        if (!id) throw new Error('No se pudo copiar el canal AFK.');
        result.push(await guild.setAFKChannel(id));
    }
    const timeout = data.afk?.timeout ?? data.afkTimeout;
    if (timeout !== undefined) result.push(await guild.setAFKTimeout(timeout));
    return result;
};

/**
 * Restore guild emojis
 */
export const loadEmojis = async (guild: Guild, backup: BackupData, options: LoadOptions = { clearGuildBeforeRestore: true }): Promise<Emoji[]> => {
    const result: Emoji[] = [];
    const capacity = emojiCapacity(guild);
    const used = { static: 0, animated: 0 };
    for (const emoji of guild.emojis.cache.values()) {
        if (!emoji.managed) used[emoji.animated ? 'animated' : 'static']++;
    }
    let stopped: string;
    const full = new Set<string>();
    for (const [index, source] of backup.emojis.entries()) {
        const type = animatedEmoji(source) ? 'animated' : 'static';
        const existing = options.reuseEmojiIds?.[source.id] && guild.emojis.cache.get(options.reuseEmojiIds[source.id]);
        emit(options, { kind: 'progress', feature: 'emojis', name: source.name, current: index + 1, total: backup.emojis.length });
        if (!existing && (stopped || used[type] >= capacity || full.has(type))) {
            emit(options, { kind: 'skipped', feature: 'emojis', name: source.name,
                reason: stopped ?? `Cupo de emojis ${type === 'static' ? 'estáticos' : 'animados'} lleno (${capacity}); el destino necesita más espacios/boosts.` });
            continue;
        }
        try {
            const roleIds = (source.roleIds ?? []).map((id) => resolveRoleId(guild, id));
            if (roleIds.some((id) => !id)) throw new Error('No se pudo resolver un rol que limita el uso del emoji.');
            const currentRoles = existing ? Array.from(existing.roles?.cache.keys() ?? []) : [];
            const restrictionsMatch = existing && currentRoles.length === roleIds.length && currentRoles.every((id) => roleIds.includes(id));
            if (stopped && !restrictionsMatch) {
                emit(options, { kind: 'skipped', feature: 'emojis', name: source.name, reason: stopped });
                continue;
            }
            const emoji = existing
                ? restrictionsMatch ? existing : await guild.emojis.edit(existing.id, { roles: roleIds })
                : await guild.emojis.create(imageDataUri(source.base64 ?? (await imageBytes(nodeFetch, source.url)).toString('base64')), source.name, { roles: roleIds });
            if (!existing) used[type]++;
            rememberEmoji(guild, source.id, emoji.id);
            result.push(emoji);
            emit(options, { kind: 'copied', feature: 'emojis', name: source.name, reason: existing ? 'Imagen idéntica reutilizada' : undefined });
        } catch (error) {
            const value = error as { code?: number; name?: string; httpStatus?: number };
            const reason = assetError(error);
            emit(options, { kind: 'failed', feature: 'emojis', name: source.name, reason });
            if (value.code === 30008) full.add(type);
            if (value.name === 'RateLimitError' || [50013, 50001].includes(value.code) || [401, 403].includes(value.httpStatus)) stopped = reason;
        }
    }
    return result;
};

/**
 * Restore guild bans
 */
export const loadBans = (guild: Guild, backupData: BackupData): Promise<string[]> => {
    const banPromises: Promise<string>[] = [];
    backupData.bans.forEach((ban) => {
        banPromises.push(
            guild.members.ban(ban.id, {
                reason: ban.reason
            }) as Promise<string>
        );
    });
    return Promise.all(banPromises);
};

/**
 * Restore embedChannel configuration
 */
export const loadEmbedChannel = async (guild: Guild, data: BackupData): Promise<Guild[]> => {
    if (data.widget.known === false) return [];
    const id = data.widget.channelId ? resolveChannelId(guild, data.widget.channelId)
        : guild.channels.cache.find((c) => c.name === data.widget.channel)?.id;
    if ((data.widget.channelId || data.widget.channel) && !id) throw new Error('No se pudo copiar el canal del widget.');
    return [await guild.setWidgetSettings({ enabled: Boolean(data.widget.enabled), channel: id ?? null })];
};
