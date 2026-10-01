import { Snowflake, ThreadAutoArchiveDuration, ThreadChannelTypes } from "discord.js-selfbot-v13";
import { MessageData } from "./MessageData";

export interface ThreadChannelData {
    id?: string;
    appliedTagNames?: string[];
    invitable?: boolean;
    type: ThreadChannelTypes;
    name: string;
    archived: boolean;
    autoArchiveDuration: ThreadAutoArchiveDuration;
    locked: boolean;
    rateLimitPerUser: number;
    messages: MessageData[];
}
