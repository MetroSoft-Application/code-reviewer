/**
 * extension.ts
 * VS Code拡張機能のエントリポイント
 * activate / deactivateライフサイクルを管理する
 */
import * as vscode from 'vscode';
import { reviewDiff } from './reviewDiff';

/**
 * 拡張機能の起動時に呼び出される
 * コマンドを登録してsubscriptionsに追加する
 *
 * @param context - 拡張機能のコンテキスト
 */
export function activate(context: vscode.ExtensionContext): void {
    /*
     * SCMコンテキストメニューからのコードレビューコマンドを登録する
     * 引数はSCMビューから渡されるSourceControlResourceState
     */
    const reviewDiffCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewDiff',
        reviewDiff
    );

    context.subscriptions.push(reviewDiffCommand);
}

/**
 * 拡張機能の終了時に呼び出される
 * subscriptionsで管理していないリソースの解放処理をここに記述する
 */
export function deactivate(): void {
    // 現時点では解放処理なし
}
