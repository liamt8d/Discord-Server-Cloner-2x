export interface CloneEvent {
    kind: 'progress' | 'copied' | 'skipped' | 'failed';
    feature: string;
    name?: string;
    reason?: string;
    count?: number;
    current?: number;
    total?: number;
}
