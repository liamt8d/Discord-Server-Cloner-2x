import { CategoryData, TextChannelData, VoiceChannelData, ForumChannelData } from './';

export interface ChannelsData {
    categories: CategoryData[];
    others: Array<TextChannelData | VoiceChannelData | ForumChannelData>;
}