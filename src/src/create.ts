import type {
    BanData,
    CategoryData,
    ChannelsData,
    CreateOptions,
    EmojiData,
    RoleData,
    TextChannelData,
    VoiceChannelData,
    ForumChannelData
} from './types';
import type { CategoryChannel, Collection, Guild, GuildChannel, ForumChannel, MediaChannel, StageChannel, Snowflake, TextChannel, ThreadChannel, VoiceChannel } from 'discord.js-selfbot-v13';
import nodeFetch from 'node-fetch';
import { imageBytes, mapLimited } from '../assets';
import { fetchChannelPermissions, fetchTextChannelData, fetchVoiceChannelData, fetchForumChannelData, fetchThreads } from './util';

/**
 * Returns an array with the banned members of the guild
 * @param {Guild} guild The Discord guild
 * @returns {Promise<BanData[]>} The banned members
 */
export async function getBans(guild: Guild) {
    const bans: BanData[] = [];
    const cases = await guild.bans.fetch(); // Gets the list of the banned members
    cases.forEach((ban) => {
        bans.push({
            id: ban.user.id, // Banned member ID
            reason: ban.reason // Ban reason
        });
    });
    return bans;
}

/**
 * Returns an array with the roles of the guild
 * @param {Guild} guild The discord guild
 * @returns {Promise<RoleData[]>} The roles of the guild
 */
export async function getRoles(guild: Guild) {
    const roles: RoleData[] = [];
    guild.roles.cache
        .filter((role) => !role.managed)
        .sort((a, b) => b.position - a.position)
        .forEach((role) => {
            const roleData = {
                id: role.id, iconURL: role.iconURL() ?? undefined, unicodeEmoji: role.unicodeEmoji ?? undefined,
                name: role.name,
                color: role.hexColor,
                hoist: role.hoist,
                permissions: role.permissions.bitfield.toString(),
                mentionable: role.mentionable,
                position: role.position,
                isEveryone: guild.id === role.id
            };
            roles.push(roleData);
        });
    return roles;
}

/**
 * Returns an array with the emojis of the guild
 * @param {Guild} guild The discord guild
 * @param {CreateOptions} options The backup options
 * @returns {Promise<EmojiData[]>} The emojis of the guild
 */
export async function getEmojis(guild: Guild, options: CreateOptions) {
    let completed = 0;
    const all = Array.from(guild.emojis.cache.values());
    return mapLimited(all, 4, async (emoji) => {
        const eData: EmojiData = {
            id: emoji.id, animated: emoji.animated ?? undefined, managed: Boolean(emoji.managed), roleIds: Array.from(emoji.roles.cache.keys()),
            name: emoji.name
        };
        if (options.saveImages && options.saveImages === 'base64') {
            try {
                eData.base64 = (await imageBytes(nodeFetch, emoji.url)).toString('base64');
            } catch (error) {
                eData.url = emoji.url;
                options.onWarning?.(`Emoji ${emoji.name}: ${(error as Error).message}; se intentará copiar desde la URL.`);
            }
        } else {
            eData.url = emoji.url;
        }
        options.onProgress?.(`Imágenes de emojis: ${++completed}/${all.length}`);
        return eData;
    });
}

/**
 * Returns an array with the channels of the guild
 * @param {Guild} guild The discord guild
 * @param {CreateOptions} options The backup options
 * @returns {ChannelData[]} The channels of the guild
 */
export async function getChannels(guild: Guild, options: CreateOptions): Promise<ChannelsData> {
    const supported = new Set(['GUILD_CATEGORY', 'GUILD_TEXT', 'GUILD_NEWS', 'GUILD_VOICE', 'GUILD_STAGE_VOICE',
        'GUILD_FORUM', 'GUILD_MEDIA', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD', 'GUILD_NEWS_THREAD']);
    for (const channel of guild.channels.cache.values()) {
        if (!supported.has(channel.type)) options.onWarning?.(`Canal ${channel.name}: tipo ${channel.type} no importable.`);
    }
    const convert = async (channel: GuildChannel) => {
        options.onProgress?.(`Leyendo ${channel.name}`);
        if (channel.type === 'GUILD_TEXT' || channel.type === 'GUILD_NEWS') {
            try { return await fetchTextChannelData(channel as TextChannel, options); }
            catch (error) {
                options.onWarning?.(`Historial de ${channel.name}: ${(error as Error).message}`);
                return await fetchTextChannelData(channel as TextChannel, { ...options, maxMessagesPerChannel: 0 });
            }
        }
        if (channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE') return fetchVoiceChannelData(channel as VoiceChannel | StageChannel);
        if (channel.type === 'GUILD_FORUM' || channel.type === 'GUILD_MEDIA') {
            const data = fetchForumChannelData(channel as ForumChannel | MediaChannel);
            if (options.includeThreads !== false) data.threads = await fetchThreads(channel as ForumChannel | MediaChannel, options);
            return data;
        }
        return undefined;
    };
    const channels: ChannelsData = { categories: [], others: [] };
    const all = (Array.from(guild.channels.cache.values()).filter((c) => !['GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD', 'GUILD_NEWS_THREAD'].includes(c.type)) as GuildChannel[]).sort((a, b) => a.position - b.position);
    for (const category of all.filter((c) => c.type === 'GUILD_CATEGORY') as CategoryChannel[]) {
        const data: CategoryData = { id: category.id, name: category.name, position: category.position,
            permissions: fetchChannelPermissions(category), children: [] };
        for (const child of Array.from(category.children.values()).sort((a, b) => a.position - b.position)) {
            const saved = await convert(child);
            if (saved) data.children.push(saved);
        }
        channels.categories.push(data);
    }
    for (const channel of all.filter((c) => !c.parent && c.type !== 'GUILD_CATEGORY')) {
        const saved = await convert(channel);
        if (saved) channels.others.push(saved);
    }
    return channels;
}
