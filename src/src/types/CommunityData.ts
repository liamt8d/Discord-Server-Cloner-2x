import type { AutoModerationRuleCreateOptions, AutoModerationAction, GuildScheduledEventCreateOptions } from 'discord.js-selfbot-v13';

export interface AutoModData {
    id?: string; name: string; event_type: number; trigger_type: number;
    trigger_metadata: Record<string, unknown>;
    actions: { type: number; metadata?: { channel_id?: string; duration_seconds?: number; custom_message?: string; [key: string]: unknown } }[];
    enabled: boolean; exempt_roles: string[]; exempt_channels: string[];
}
export interface StickerData { name: string; description?: string; tags: string; url: string; format: string; base64?: string; }
export interface WelcomeData {
    enabled: boolean; description?: string;
    channels: { channelId: string; description: string; emojiId?: string; emojiName?: string }[];
}
export interface ScheduledEventData {
    id?: string; name: string; start: number; end?: number; channelId?: string;
    description?: string; entityType: GuildScheduledEventCreateOptions['entityType'];
    privacyLevel: GuildScheduledEventCreateOptions['privacyLevel'];
    entityMetadata?: GuildScheduledEventCreateOptions['entityMetadata'];
    image?: string;
    recurrenceRule?: GuildScheduledEventCreateOptions['recurrenceRule'];
}
// Discord's onboarding endpoint uses snake_case fields. Preserve its JSON shape.
export interface OnboardingData {
    enabled: boolean; mode?: number; default_channel_ids: string[];
    prompts: { id: string; type: number; title: string; single_select: boolean; required: boolean;
      in_onboarding: boolean; options: { id: string; title: string; description?: string;
      channel_ids: string[]; role_ids: string[]; emoji?: { id?: string; name?: string; animated?: boolean } }[] }[];
}
export interface ScreeningData { description?: string; form_fields: Record<string, unknown>[]; enabled?: boolean; }
