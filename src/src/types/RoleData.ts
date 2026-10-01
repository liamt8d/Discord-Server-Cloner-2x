export interface RoleData {
    id?: string;
    iconURL?: string;
    unicodeEmoji?: string;
    name: string;
    color: `#${string}`;
    hoist: boolean;
    permissions: string;
    mentionable: boolean;
    position: number;
    isEveryone: boolean;
}
