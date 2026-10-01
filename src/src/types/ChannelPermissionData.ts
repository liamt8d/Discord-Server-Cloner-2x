export interface ChannelPermissionsData {
    type?: 'role' | 'member';
    memberId?: string;
    roleId?: string;
    roleName: string;
    allow: string;
    deny: string;
}
