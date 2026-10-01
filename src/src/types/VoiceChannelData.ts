import { BaseChannelData } from './';

export interface VoiceChannelData extends BaseChannelData {
    rtcRegion?: string;
    videoQualityMode?: "AUTO" | "FULL";
    bitrate: number;
    userLimit: number;
}
