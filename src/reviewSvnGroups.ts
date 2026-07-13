import * as vscode from 'vscode';
import { reviewDiff } from './reviewDiff';

type SvnScmGroup = {
    id?: string;
    label?: string;
    resourceStates?: unknown[];
};

function isSourceControlResourceState(value: unknown): value is vscode.SourceControlResourceState {
    if (typeof value !== 'object' || value === null || !('resourceUri' in value)) {
        return false;
    }

    const resourceUri = (value as { resourceUri?: unknown; }).resourceUri;
    return typeof resourceUri === 'object' && resourceUri !== null &&
        'scheme' in resourceUri &&
        'fsPath' in resourceUri &&
        'toString' in resourceUri;
}

function isRemoteGroup(group: SvnScmGroup): boolean {
    const value = `${group.id ?? ''} ${group.label ?? ''}`.toLowerCase();
    return value.includes('remote') ||
        value.includes('incoming') ||
        value.includes('リモート') ||
        value.includes('受信');
}

/**
 * SVN SCM のローカル変更セクションをまとめて Copilot Chat に送る。
 * 実際の差分取得・サイズ制限・プロンプト生成は既存の reviewDiff に委譲する。
 */
export async function reviewSvnGroups(
    group: unknown,
    ...selectedGroups: unknown[]
): Promise<void> {
    const groups = [group, ...selectedGroups]
        .filter((item): item is SvnScmGroup => typeof item === 'object' && item !== null)
        .filter(item => !isRemoteGroup(item));

    const resources = groups
        .flatMap(item => item.resourceStates ?? [])
        .filter(isSourceControlResourceState)
        .filter((item, index, list) =>
            list.findIndex(candidate => candidate.resourceUri.toString() === item.resourceUri.toString()) === index
        );

    if (resources.length === 0) {
        vscode.window.showWarningMessage(
            'No local SVN changes were found in the selected Source Control section.'
        );
        return;
    }

    await reviewDiff(resources[0], ...resources.slice(1));
}
