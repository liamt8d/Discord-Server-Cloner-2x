import { MessageEmbed, FileOptions } from 'discord.js-selfbot-v13';

export interface MessageData {
    id?: string;
    username: string;
    avatar?: string;
    content?: string;
    embeds?: MessageEmbed[];
    files?: FileOptions[];
    pinned?: boolean;
}
