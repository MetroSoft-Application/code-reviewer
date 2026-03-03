/**
 * extension.ts
 * VS Code拡張機能のエントリポイント
 * activate / deactivateライフサイクルを管理する
 */
import * as vscode from 'vscode';
import { reviewDiff, reviewRevision, reviewCommit } from './reviewDiff';

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
        'copilot-scm-code-reviewer.reviewDiff',
        reviewDiff
    );

    /*
     * SVN FILE HISTORY (svn-scm) ビューからのコードレビューコマンドを登録する
     * 引数はsvn-scmのILogTreeItem (contextValue == "diffable")
     */
    const reviewRevisionCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewRevision',
        reviewRevision
    );

    /*
     * SVN repolog のコミット行ノードからのレビューコマンドを登録する
     * 引数はsvn-scmのILogTreeItem (contextValue == "commit")
     */
    const reviewCommitCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewCommit',
        reviewCommit
    );

    context.subscriptions.push(reviewDiffCommand, reviewRevisionCommand, reviewCommitCommand);
}

/**
 * 拡張機能の終了時に呼び出される
 * subscriptionsで管理していないリソースの解放処理をここに記述する
 */
export function deactivate(): void {
    // 現時点では解放処理なし
}
