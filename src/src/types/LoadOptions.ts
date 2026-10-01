import type { CloneEvent } from "./CloneEvent";
import { MessageMentionOptions } from "discord.js-selfbot-v13";

export interface LoadOptions {
    clearGuildBeforeRestore: boolean;
    maxMessagesPerChannel?: number;
    restoreSnapshot?: boolean;
    enableCommunity?: boolean;
    deferForumEmojis?: boolean;
    reuseEmojiIds?: Record<string, string>;
    onEvent?: (event: CloneEvent) => void;
    allowedMentions?: MessageMentionOptions;
}
