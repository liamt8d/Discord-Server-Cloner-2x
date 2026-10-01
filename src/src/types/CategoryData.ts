import { ChannelPermissionsData, TextChannelData, VoiceChannelData, ForumChannelData } from './';

export interface CategoryData {
    id?: string;
    position?: number;
    name: string;
    permissions: ChannelPermissionsData[];
    children: Array<TextChannelData | VoiceChannelData | ForumChannelData>;
}
