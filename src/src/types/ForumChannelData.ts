import type { GuildForumTagData, ForumChannel, ThreadAutoArchiveDuration, DefaultReactionEmoji } from 'discord.js-selfbot-v13';
import type { ThreadChannelData } from './ThreadChannelData';
import type { BaseChannelData } from './BaseChannelData';

export interface ForumChannelData extends BaseChannelData {
    type: 'GUILD_FORUM' | 'GUILD_MEDIA';
    threads?: ThreadChannelData[];
    topic?: string;
    nsfw: boolean;
    rateLimitPerUser?: number;
    defaultThreadRateLimitPerUser?: number;
    defaultAutoArchiveDuration?: ThreadAutoArchiveDuration;
    availableTags: GuildForumTagData[];
    defaultReactionEmoji?: DefaultReactionEmoji;
    defaultSortOrder?: ForumChannel['defaultSortOrder'];
    defaultForumLayout?: ForumChannel['defaultForumLayout'];
}
