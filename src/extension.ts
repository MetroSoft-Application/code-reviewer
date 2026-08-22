/**
 * extension.ts
 * VS Code拡張機能のエントリポイント
 * activate / deactivateライフサイクルを管理する
 */
import * as vscode from 'vscode';
import { reviewDiff, reviewRevision, reviewCommit, addToReviewList, reviewMultiCommit, reviewGitGroups, reviewSvnGroups, reviewPrFiles, reviewGitCommit, reviewGitCommitFromClipboard, addGitCommitToReviewList, reviewMultiGitCommit, reviewGitCommitFile } from './reviewDiff';

/**
 * 拡張機能の起動時に呼び出される
 * コマンドを登録してsubscriptionsに追加する
 *
 * @param context - 拡張機能のコンテキスト
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

    /*
     * SVN repolog のコミット行ノードをレビューリストに追加するコマンドを登録する
     * 引数はsvn-scmのILogTreeItem (contextValue == "commit")
     */
    const addToReviewListCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.addToReviewList',
        addToReviewList
    );

    /*
     * レビューリストに登録されたコミットをまとめてレビューするコマンドを登録する
     */
    const reviewMultiCommitCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewMultiCommit',
        reviewMultiCommit
    );

    /*
     * SCM の変更セクション（変更/ステージ）から一括レビューするコマンドを登録する
     */
    const reviewGitGroupsCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewGitGroups',
        reviewGitGroups
    );

    /*
     * SVN SCM の変更セクションから一括レビューするコマンドを登録する
     */
    const reviewSvnGroupsCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewSvnGroups',
        reviewSvnGroups
    );

    /*
     * PR の変更ファイルから選択してプレビューレビューするコマンドを登録する
     * SCM タイトルバーのボタンまたはコマンドパレットから呼び出す
     */
    const reviewPrFilesCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewPrFiles',
        reviewPrFiles
    );

    /*
     * VS Code Timeline ビューの Git コミットから単体レビューするコマンドを登録する
     * 引数は Timeline の対象ファイル URI と GitTimelineItem
     */
    const reviewGitCommitCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewGitCommit',
        reviewGitCommit
    );

    /*
     * 提案 API を有効化できない通常の VS Code で使用するフォールバック。
     * SCM Graph でコミットハッシュをコピーした後、コマンドパレットから呼び出す。
     */
    const reviewGitCommitFromClipboardCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewGitCommitFromClipboard',
        reviewGitCommitFromClipboard
    );

    /*
     * VS Code Timeline ビューの Git コミットをレビューリストに追加するコマンドを登録する
     */
    const addGitCommitToReviewListCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.addGitCommitToReviewList',
        addGitCommitToReviewList
    );

    /*
     * Git コミットレビューリストに登録されたコミットをまとめてレビューするコマンドを登録する
     */
    const reviewMultiGitCommitCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewMultiGitCommit',
        reviewMultiGitCommit
    );

    /*
     * Git コミット内の特定ファイルを選択してレビューするコマンドを登録する
     * QuickPick でファイルを選択し、選択ファイルの diff を Copilot Chat に送信する
     */
    const reviewGitCommitFileCommand = vscode.commands.registerCommand(
        'copilot-scm-code-reviewer.reviewGitCommitFile',
        reviewGitCommitFile
    );

    context.subscriptions.push(
        reviewDiffCommand,
        reviewRevisionCommand,
        reviewCommitCommand,
        addToReviewListCommand,
        reviewMultiCommitCommand,
        reviewGitGroupsCommand,
        reviewSvnGroupsCommand,
        reviewPrFilesCommand,
        reviewGitCommitCommand,
        reviewGitCommitFromClipboardCommand,
        addGitCommitToReviewListCommand,
        reviewMultiGitCommitCommand,
        reviewGitCommitFileCommand
    );
}

/**
 * 拡張機能の終了時に呼び出される
 * subscriptionsで管理していないリソースの解放処理をここに記述する
 */
export function deactivate(): void {
    // 現時点では解放処理なし
}
