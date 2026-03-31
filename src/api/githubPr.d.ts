/**
 * github.vscode-pull-request-github 拡張機能の公開 API の型定義
 * https://github.com/microsoft/vscode-pull-request-github
 */
import type * as vscode from 'vscode';

/** ReviewerCommentsProvider に渡される各ファイルのパッチ情報 */
export interface ReviewerCommentsPatch {
    /** unified diff 形式のパッチテキスト */
    patch: string;
    /** 変更後ファイルの URI 文字列 */
    fileUri: string;
    /** 変更前ファイルの URI 文字列（リネーム時のみ設定される） */
    previousFileUri?: string;
}

/** provideReviewerComments に渡される PR コンテキスト */
export interface ReviewerCommentsContext {
    /** リポジトリのルートディレクトリの絶対パス */
    repositoryRoot: string;
    /** PR に含まれるコミットメッセージの一覧 */
    commitMessages: string[];
    /** 変更ファイルのパッチ情報の一覧 */
    patches: ReviewerCommentsPatch[];
}

/** provideReviewerComments の戻り値 */
export interface ReviewerComments {
    /** レビュー対象として選択されたファイルの URI 一覧 */
    files: vscode.Uri[];
    /** レビューが正常に完了した場合は true */
    succeeded: boolean;
    /** 登録解除用の Disposable（省略可） */
    disposable?: vscode.Disposable;
}

/** PR 作成フローに組み込むレビュアープロバイダーのインターフェース */
export interface ReviewerCommentsProvider {
    provideReviewerComments(
        context: ReviewerCommentsContext,
        token: vscode.CancellationToken
    ): Promise<ReviewerComments | undefined>;
}

/** getRepositoryDescription の戻り値 */
export interface RepositoryDescription {
    owner: string;
    repositoryName: string;
    defaultBranch: string;
    pullRequest?: {
        title: string;
        url: string;
        number: number;
        id: string;
    };
}

/** github.vscode-pull-request-github の公開 API (version 1) */
export interface GitHubPRAPI {
    /**
     * PR 作成フローにレビュアーコメントプロバイダーを登録する
     * @param title    PR 作成画面に表示するレビューボタンのラベル
     * @param provider プロバイダーの実装
     * @returns 登録を解除するための Disposable
     */
    registerReviewerCommentsProvider(
        title: string,
        provider: ReviewerCommentsProvider
    ): vscode.Disposable;

    /**
     * 指定 URI のリポジトリ情報（オープン中の PR を含む）を取得する
     * @param uri ワークスペース内の任意のファイルまたはフォルダの URI
     */
    getRepositoryDescription(uri: vscode.Uri): Promise<RepositoryDescription | undefined>;
}

/**
 * vscode.extensions.getExtension<GitHubPRAPI>('github.vscode-pull-request-github')
 * で取得する拡張機能のエクスポート型
 * activate() は GitHubPRAPI インスタンスを直接返すため getAPI() ラッパーは存在しない
 */
export type GitHubPRExtension = GitHubPRAPI;
