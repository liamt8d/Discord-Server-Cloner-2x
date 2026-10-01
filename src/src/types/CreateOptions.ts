export interface CreateOptions {
    backupID?: string;
    purpose?: 'source' | 'destination';
    maxMessagesPerChannel?: number;
    jsonSave?: boolean;
    jsonBeautify?: boolean;
    doNotBackup?: string[];
    includeCommunity?: boolean;
    includeThreads?: boolean;
    onProgress?: (message: string) => void;
    onWarning?: (message: string) => void;
    saveImages?: string;
}
