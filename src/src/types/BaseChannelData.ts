import { TextBasedChannelTypes, VoiceBasedChannelTypes, ThreadChannelTypes } from 'discord.js-selfbot-v13';
import { ChannelPermissionsData } from './';

export interface BaseChannelData {
    position?: number;
    type: 'GUILD_MEDIA' | 'GUILD_FORUM' | TextBasedChannelTypes | VoiceBasedChannelTypes | ThreadChannelTypes;
    id?: string;
    name: string;
    parent?: string;
    permissions: ChannelPermissionsData[];
}
