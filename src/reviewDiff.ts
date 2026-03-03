/**
 * SCM差分を取得してGitHub Copilot Chatに渡すコードレビュー処理
 * GitおよびSVNの両方に対応する
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { GitExtension, Repository } from './api/git';
import { PROMPT_TEMPLATES, DEFAULT_LANG, resolveLanguage, ReviewListEntry } from './promptTemplates';

/*
 * Status は git.d.ts で const enum として定義されているため、
 * webpack (ts-loader) のモジュール単体トランスパイル時はインライン展開されず
 * インストール版では undefined になる。
 * そのため使用する値をローカル定数として定義する。
 */
const FileStatus = {
    INDEX_DELETED: 2,
    DELETED: 6,
    UNTRACKED: 7,
    INTENT_TO_ADD: 9,
} as const;

/*
 * 差分テキストの上限サイズ(文字数)
 * コンテキストウィンドウ(128Kトークン)に対して安全マージンを確保するため
 * コード換算で50KBを上限とする
 */
const DIFF_SIZE_LIMIT = 50_000;

/**
 * vscode.git拡張機能のAPIインスタンスを取得する
 * SVN環境では利用不可なためエラーなしでundefinedを返す
 * @returns git APIインスタンス。取得できない場合はundefined
 */
function getGitAPI(): ReturnType<GitExtension['getAPI']> | undefined {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension || !gitExtension.isActive) {
        return undefined;
    }
    return gitExtension.exports.getAPI(1);
}

/**
 * リソースURIに対応するGitリポジトリを取得する
 * 見つからない場合はエラーなしのundefinedを返す
 */
function getRepositoryForUri(
    gitAPI: ReturnType<GitExtension['getAPI']>,
    resourceUri: vscode.Uri
): Repository | undefined {
    return gitAPI.getRepository(resourceUri) ?? undefined;
}

/**
 * バイナリデータが含まれているかを判定する
 * nullバイト(0x00)が含まれている場合はバイナリとみなす
 *
 * @param content - 検査する文字列
 */
function isBinary(content: string): boolean {
    return content.includes('\0');
}

/**
 * ファイル内容から擬似diff文字列を生成する
 * 新規ファイルは全行に '+' を、削除ファイルは全行に '-' を付与する
 * @param relativePath - ヘッダ表示用の相対パス
 * @param content - ファイル内容
 * @param prefix - 行先頭に付与する文字('+' または '-')
 * @param fromHeader - diff --- 行のヘッダ
 * @param toHeader - diff +++ 行のヘッダ
 */
function buildPseudoDiff(
    relativePath: string,
    content: string,
    prefix: '+' | '-',
    fromHeader: string,
    toHeader: string
): string {
    const lines = content.split('\n');
    // 末尾の空行を除外する
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    const hunkHeader =
        prefix === '+'
            ? `@@ -0,0 +1,${lines.length} @@`
            : `@@ -1,${lines.length} +0,0 @@`;
    const diffLines = lines.map(line => `${prefix}${line}`);
    return [
        `--- ${fromHeader}`,
        `+++ ${toHeader}`,
        hunkHeader,
        ...diffLines,
    ].join('\n');
}

/**
 * 单一ファイルのgit差分テキストを取得する
 * ファイルのgitステータスに応じて以下の処理を行う:
 * - 通常の変更: diffWithHEAD / diffIndexWithHEAD
 * - 新規ファイル (UNTRACKED / INTENT_TO_ADD): ファイル内容を読み込み全行 '+' のdiffを生成
 * - 削除ファイル (DELETED / INDEX_DELETED): HEADの内容を取得し全行 '-' のdiffを生成
 */
async function getDiffTextGit(
    repo: Repository,
    resourceUri: vscode.Uri
): Promise<string | undefined> {
    const filePath = resourceUri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(resourceUri);

    const allChanges = [
        ...repo.state.workingTreeChanges,
        ...repo.state.indexChanges,
    ];
    const change = allChanges.find(c => c.uri.fsPath === filePath);
    const status = change?.status;

    if (status === FileStatus.UNTRACKED || status === FileStatus.INTENT_TO_ADD) {
        const rawContent = await vscode.workspace.fs.readFile(resourceUri);
        const content = Buffer.from(rawContent).toString('utf8');
        if (isBinary(content)) { return undefined; }
        return buildPseudoDiff(relativePath, content, '+', '/dev/null', `b/${relativePath}`);
    }

    if (status === FileStatus.DELETED || status === FileStatus.INDEX_DELETED) {
        const content = await repo.show('HEAD', filePath);
        if (isBinary(content)) {
            return undefined;
        }
        return buildPseudoDiff(relativePath, content, '-', `a/${relativePath}`, '/dev/null');
    }

    let diffText = await repo.diffWithHEAD(filePath);
    if (!diffText || diffText.trim() === '') {
        diffText = await repo.diffIndexWithHEAD(filePath);
    }
    return diffText || undefined;
}

/**
 * ディレクトリを遅って .git または .svn フォルダを検索する
 * @returns 検出したルートディレクトリとSCM種別。見つからない場合はundefined
 */
function findScmRoot(filePath: string): { root: string; type: 'git' | 'svn'; } | undefined {
    let currentDir = path.dirname(filePath);
    while (true) {
        if (fs.existsSync(path.join(currentDir, '.git'))) {
            return { root: currentDir, type: 'git' };
        }
        if (fs.existsSync(path.join(currentDir, '.svn'))) {
            return { root: currentDir, type: 'svn' };
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    return undefined;
}

/**
 * `svn status` でファイルのステータスを取得する
 * @returns 'A'(新規) | 'D'(削除) | 'M'(変更) | '?'(未追跡) | '!'(ディスク上から削除) | undefined
 */
function getSvnStatus(
    filePath: string,
    scmRoot: string
): Promise<'A' | 'D' | 'M' | '?' | '!' | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn status "${filePath}"`, { cwd: scmRoot }, (_err, stdout) => {
            const char = stdout.trim().charAt(0) as 'A' | 'D' | 'M' | '?' | '!';
            resolve(['A', 'D', 'M', '?', '!'].includes(char) ? char : undefined);
        });
    });
}

/**
 * `svn cat -r BASE` で削除ファイルのBaseリビジョン内容を取得する
 */
function getSvnBaseContent(
    filePath: string,
    scmRoot: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn cat -r BASE "${filePath}"`, { cwd: scmRoot }, (err, stdout) => {
            resolve(err ? undefined : (stdout || undefined));
        });
    });
}

/**
 * `svn diff` で変更ファイルのdiffテキストを取得する
 */
function getSvnDiffOutput(
    filePath: string,
    scmRoot: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn diff "${filePath}"`, { cwd: scmRoot }, (err, stdout) => {
            resolve(err ? undefined : (stdout.trim() || undefined));
        });
    });
}

/**
 * SVNリポジトリのファイル差分テキストを取得する
 * - 'M'(変更): svn diff を実行
 * - 'A'/'?'(新規/未追跡): ファイル内容を読み全行'+'のdiffを生成
 * - 'D'(削除): svn diff を優先し、失敗時は svn cat -r BASE で旧内容を取得し全行'-'のdiffを生成
 * - '!'(ディスク上から削除): 'D'と同様
 */
async function getDiffTextSvn(
    resourceUri: vscode.Uri,
    scmRoot: string
): Promise<string | undefined> {
    const filePath = resourceUri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(resourceUri);
    const status = await getSvnStatus(filePath, scmRoot);

    // 新規ファイル(追加済み / 未追跡)
    if (status === 'A' || status === '?') {
        const rawContent = await vscode.workspace.fs.readFile(resourceUri);
        const content = Buffer.from(rawContent).toString('utf8');
        if (isBinary(content)) { return undefined; }
        return buildPseudoDiff(relativePath, content, '+', '/dev/null', `b/${relativePath}`);
    }

    /*
     * 削除ファイル (D: svn delete済み, !: ディスクから削除済み)
     * svn diff は削除ファイルの全行を "-" 付きunified diffとして出力するためそちらを優先する
     * svn diff が空の場合は svn cat -r BASE でフォールバックする
     */
    if (status === 'D' || status === '!') {
        const diffOutput = await getSvnDiffOutput(filePath, scmRoot);
        if (diffOutput) {
            return diffOutput;
        }

        const content = await getSvnBaseContent(filePath, scmRoot);
        if (!content || isBinary(content)) {
            return undefined;
        }
        return buildPseudoDiff(relativePath, content, '-', `a/${relativePath}`, '/dev/null');
    }

    // 通常の変更ファイル
    return getSvnDiffOutput(filePath, scmRoot);
}

/**
 * Git/SVNを自動判別して差分テキストを取得するディスパッチャー
 * 1. vscode.git APIでGitリポジトリとして認識される場合 → getDiffTextGit
 * 2. 認識されない場合は .svn を検索 → getDiffTextSvn
 * 3. どちらも認識できない場合はundefined
 */
async function getFileDiffText(
    resourceUri: vscode.Uri,
    gitAPI: ReturnType<GitExtension['getAPI']> | undefined
): Promise<string | undefined> {
    // Git を試みる
    if (gitAPI) {
        const gitRepo = getRepositoryForUri(gitAPI, resourceUri);
        if (gitRepo) {
            return getDiffTextGit(gitRepo, resourceUri);
        }
    }

    // SVN を試みる
    const scmInfo = findScmRoot(resourceUri.fsPath);
    if (scmInfo && scmInfo.type === 'svn') {
        return getDiffTextSvn(resourceUri, scmInfo.root);
    }

    return undefined;
}

/**
 * 複数ファイルの差分を結合してCopilot Chat用のプロンプトを構築する
 * @param diffs - ファイル名と差分テキストのペアの配列
 * @param skippedCount - 上限超過によりスキップしたファイル数
 * @returns Copilot Chatに送信するプロンプト文字列
 */
function buildPrompt(
    diffs: Array<{ fileName: string; diffText: string; }>,
    skippedCount: number
): string {
    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang];

    const diffBlocks = diffs.map(({ fileName, diffText }) => {
        return [
            `### ${template.fileLabel}: ${fileName}`,
            '```diff',
            diffText,
            '```',
        ].join('\n');
    });

    const body = diffBlocks.join('\n\n');

    const footer =
        skippedCount > 0
            ? `\n\n${template.skipNotice(skippedCount)}`
            : '';

    /*
     * 言語別カスタムプロンプトが設定されている場合はそちらを優先する
     * {{diff}} プレースホルダーがあればそこに差分ブロックを挿入し、
     * なければカスタムテキストの末尾に差分ブロックを追記する
     */
    const customPrompt = vscode.workspace
        .getConfiguration('copilot-scm-code-reviewer')
        .get<string>(`reviewPrompt.${lang}`, '');

    if (customPrompt.trim()) {
        const result = customPrompt.includes('{{diff}}')
            ? customPrompt.replace('{{diff}}', body)
            : `${customPrompt}\n\n${body}`;
        return `${result}${footer}`;
    }

    return `${template.header}\n\n${body}${footer}`;
}

/**
 * SCM リソースグループ情報を扱うための最小型定義
 *
 * VS Code の SCM メニュー引数は公開API型が限定的なため、
 * 必要なプロパティのみをダックタイピングで参照する。
 */
type GitScmGroup = {
    /** グループID（例: workingTree / index） */
    id?: string;
    /** 表示ラベル（例: Changes / Staged Changes） */
    label?: string;
    /** グループ配下のリソース一覧 */
    resourceStates?: vscode.SourceControlResourceState[];
};

/**
 * SCM リソースグループを「ステージ済み」または「未ステージ」に判定する
 *
 * @param group - SCM リソースグループ
 * @returns 判定結果（'staged' | 'unstaged'）。判定不能時は undefined
 */
function resolveGitGroupKind(group: GitScmGroup): 'staged' | 'unstaged' | undefined {
    const id = (group.id ?? '').toLowerCase();
    const label = (group.label ?? '').toLowerCase();

    if (id.includes('index') || id.includes('staged') || label.includes('staged') || label.includes('ステージ')) {
        return 'staged';
    }

    if (
        id.includes('workingtree') ||
        id.includes('working_tree') ||
        id.includes('working') ||
        id.includes('changes') ||
        label.includes('changes') ||
        label.includes('変更')
    ) {
        return 'unstaged';
    }

    return undefined;
}

/**
 * SCM リソースグループから Git リポジトリルートを取得する
 *
 * @param group - SCM リソースグループ
 * @param gitAPI - vscode.git API
 * @returns リポジトリルートのローカルパス。特定できない場合は undefined
 */
function getGitRepoRootFromGroup(
    group: GitScmGroup,
    gitAPI: ReturnType<GitExtension['getAPI']>
): string | undefined {
    const uri = group.resourceStates?.[0]?.resourceUri;
    if (!uri) {
        return undefined;
    }

    const repo = getRepositoryForUri(gitAPI, uri);
    return repo?.rootUri.fsPath;
}

/**
 * Git セクション一括レビュー用のコマンド実行プロンプトを構築する
 *
 * @param commands - Copilot に実行させる git コマンド一覧
 * @returns Chat 送信用プロンプト文字列
 */
function buildGitGroupCommandPrompt(commands: string[]): string {
    const lang = resolveLanguage();

    const textByLang: Record<string, { intro: string; run: string; done: string; }> = {
        ja: {
            intro: 'Source Control の選択セクション（変更/ステージ）の差分をまとめてコードレビューしてください。',
            run: '以下のコマンドをターミナルですべて実行して差分を収集してください。',
            done: '全差分を収集したら、それらを一括でレビューし、各ファイルについて問題点・改善案・良い点を具体的に指摘してください。',
        },
        en: {
            intro: 'Please review diffs from the selected Source Control sections (Changes/Staged Changes) together.',
            run: 'Run all commands below in the terminal to collect the diffs.',
            done: 'After collecting all diffs, review them in one batch and for each file point out issues, improvements, and good points specifically.',
        },
    };

    const text = textByLang[lang] ?? textByLang.en;
    return [
        text.intro,
        '',
        text.run,
        '```',
        ...commands,
        '```',
        '',
        text.done,
    ].join('\n');
}

/**
 * SCM のリソースグループ（変更/ステージ）から呼び出される Git 一括レビューコマンド。
 * 選択されたグループに応じた git diff コマンド群を Copilot Chat に渡し、
 * Copilot 側で差分を取得して一括レビューさせる。
 */
export async function reviewGitGroups(
    group: unknown,
    ...selectedGroups: unknown[]
): Promise<void> {
    const gitAPI = getGitAPI();
    if (!gitAPI) {
        vscode.window.showErrorMessage('Git API is not available.');
        return;
    }

    const targets = [group, ...selectedGroups]
        .filter((item): item is GitScmGroup => !!item)
        .filter((item, index, list) =>
            list.findIndex(g => (g.id ?? '') === (item.id ?? '') && (g.label ?? '') === (item.label ?? '')) === index
        );

    if (targets.length === 0) {
        vscode.window.showWarningMessage('No SCM sections were selected.');
        return;
    }

    const commands = new Set<string>();

    for (const target of targets) {
        const kind = resolveGitGroupKind(target);
        if (!kind) {
            continue;
        }

        const repoRoot = getGitRepoRootFromGroup(target, gitAPI);
        if (!repoRoot) {
            continue;
        }

        if (kind === 'staged') {
            commands.add(`git -C "${repoRoot}" diff --cached`);
        } else {
            commands.add(`git -C "${repoRoot}" diff`);
        }
    }

    if (commands.size === 0) {
        vscode.window.showWarningMessage(
            'Could not resolve selected sections to Git diff commands. Try right-clicking on "Changes" or "Staged Changes".'
        );
        return;
    }

    const prompt = buildGitGroupCommandPrompt([...commands]);

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}

/**
 * SCMコンテキストメニューから呼び出されるコマンドハンドラー
 * 選択されたリソースの差分を取得してCopilot Chatに送信する
 *
 * @param resourceState - 右クリックされたリソース(単体)
 * @param resourceStates - 追加で渡される選択リソース(可変引数)
 */
export async function reviewDiff(
    resourceState: vscode.SourceControlResourceState,
    ...resourceStates: vscode.SourceControlResourceState[]
): Promise<void> {
    const targets = [resourceState, ...resourceStates]
        .filter((state): state is vscode.SourceControlResourceState => !!state)
        .filter((state, index, list) =>
            list.findIndex(s => s.resourceUri.toString() === state.resourceUri.toString()) === index
        );

    /*
     * vscode.git APIはオプショナルとして取得する
     * SVN環境では利用不可なため undefined になり得る
     */
    const gitAPI = getGitAPI();

    const diffs: Array<{ fileName: string; diffText: string; }> = [];
    let totalSize = 0;
    let skippedCount = 0;

    for (const target of targets) {
        const fileName = vscode.workspace.asRelativePath(target.resourceUri);

        let diffText: string | undefined;
        try {
            diffText = await getFileDiffText(target.resourceUri, gitAPI);
        } catch (error) {
            vscode.window.showInformationMessage(
                `Could not retrieve diff (file may be binary): ${fileName}`
            );
            skippedCount++;
            continue;
        }

        if (!diffText) {
            vscode.window.showInformationMessage(
                `No diff found: ${fileName}`
            );
            continue;
        }

        if (totalSize + diffText.length > DIFF_SIZE_LIMIT) {
            if (diffs.length === 0) {
                const answer = await vscode.window.showWarningMessage(
                    `Diff size exceeds the limit (50KB). Send only the first 50KB?\nFile: ${fileName}`,
                    'Send first 50KB',
                    'Cancel'
                );
                if (answer !== 'Send first 50KB') {
                    return;
                }
                diffs.push({ fileName, diffText: diffText.slice(0, DIFF_SIZE_LIMIT) });
                skippedCount += targets.length - 1;
                break;
            } else {
                skippedCount += targets.length - diffs.length;
                break;
            }
        }

        totalSize += diffText.length;
        diffs.push({ fileName, diffText });
    }

    if (diffs.length === 0) {
        return;
    }

    const prompt = buildPrompt(diffs, skippedCount);

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}

/**
 * svn diff で特定リビジョンの差分テキストを取得する（ローカルパス用）
 * `svn diff -c REVISION "FILEPATH"` を実行する
 */
function getSvnRevisionDiff(
    filePath: string,
    revision: string,
    scmRoot: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn diff -c ${revision} "${filePath}"`, { cwd: scmRoot }, (err, stdout) => {
            resolve(err ? undefined : (stdout.trim() || undefined));
        });
    });
}

/**
 * svn diff で特定リビジョンの差分テキストを取得する（SVN URL用）
 * repolog の CommitDetail から直接 SVN URL を指定して実行する
 */
function getSvnRevisionDiffByUrl(
    svnUrl: string,
    revision: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn diff -c ${revision} "${svnUrl}"`, (err, stdout) => {
            resolve(err ? undefined : (stdout.trim() || undefined));
        });
    });
}

/**
 * `svn info --xml TARGET` からリポジトリルート URL を取得する
 * @param target - ローカル WC パスまたは SVN URL
 */
function getSvnRepoRoot(target: string): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn info --xml "${target}"`, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            const match = stdout.match(/<root>(.*?)<\/root>/);
            resolve(match ? match[1] : undefined);
        });
    });
}

/**
 * SVN FILE HISTORY ビュー (svn-scm拡張機能) の右クリックから呼び出されるコマンドハンドラー
 * 選択されたコミットのリビジョン差分を取得してCopilot Chatに送信する
 *
 * svn-scm は外部APIを公開しないため、TreeItemのdataプロパティを
 * ダックタイピングで参照してリビジョン番号を抽出する。
 *
 * ビュー別の TreeItem 構造:
 * - itemlog (FILE HISTORY): Commit ノード - data.revision がリビジョン番号
 *   → 対象ファイルはアクティブエディタのURIから取得
 * - repolog (REPOSITORIES): CommitDetail ノード - data._ がSVNパス、parent.data.revision がリビジョン番号
 *   → parent.parent.data.svnTarget からSVN URLを構築して diff を実行
 *
 * @param treeItem - svn-scm の ILogTreeItem (contextValue == "diffable")
 */
export async function reviewRevision(treeItem: unknown): Promise<void> {
    const item = treeItem as Record<string, any>;

    /*
     * repolog の CommitDetail ノードは ISvnLogEntryPath を data に持ち、
     * data._ で SVN 上のファイルパス (/trunk/dev/test1.txt 等) を参照できる。
     * この場合はアクティブエディタに依存せず SVN URL を直接構築する。
     */
    const svnFilePath: string | undefined = item?.data?._;

    if (svnFilePath) {
        await reviewRevisionBySvnPath(item, svnFilePath);
    } else {
        await reviewRevisionByActiveEditor(item);
    }
}

/**
 * ワークスペースフォルダ内の SVN WC を検索し、svnFilePath を含む
 * リポジトリルート URL を返す
 * 複数のワークスペースフォルダを順に試みる
 *
 * @param svnFilePath - SVN 上のファイルパス (例: /trunk/dev/test1.txt)
 */
async function findRepoRootForSvnPath(svnFilePath: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
        /*
         * findScmRoot は内部で path.dirname(filePath) を起点に探索するため、
         * ディレクトリパスをそのまま渡すと1階層上から検索してしまう。
         * ダミーのファイル名を結合することで folder 自身を起点にする。
         */
        const scmInfo = findScmRoot(path.join(folder.uri.fsPath, '_'));
        if (!scmInfo || scmInfo.type !== 'svn') {
            continue;
        }
        const repoRoot = await getSvnRepoRoot(scmInfo.root);
        if (repoRoot) {
            return repoRoot;
        }
    }
    return undefined;
}

/**
 * repolog (REPOSITORIES ビュー) 用の差分取得処理
 * CommitDetail ノードの data._ (SVN パス) と親ノードの revision から
 * SVN URL を構築して svn diff -c を実行する
 */
async function reviewRevisionBySvnPath(
    item: Record<string, any>,
    svnFilePath: string
): Promise<void> {
    // CommitDetail の親 (Commit) からリビジョンを取得する
    const revision: string | undefined = item?.parent?.data?.revision;
    if (!revision) {
        vscode.window.showErrorMessage('Could not determine the SVN revision from the selected item.');
        return;
    }

    // ワークスペースの SVN WC からリポジトリルート URL を取得する
    const repoRoot = await findRepoRootForSvnPath(svnFilePath);
    if (!repoRoot) {
        vscode.window.showErrorMessage(
            'Could not determine the SVN repository root. ' +
            'Make sure an SVN working copy is open in the workspace and SVN is installed.'
        );
        return;
    }

    // SVN ファイルの完全 URL を構築する
    // repoRoot (例: file:///c:/svn) + svnFilePath (例: /trunk/dev/test1.txt)
    const fullSvnUrl = repoRoot + svnFilePath;
    const displayName = `${svnFilePath} (r${revision})`;

    let diffText: string | undefined;
    try {
        diffText = await getSvnRevisionDiffByUrl(fullSvnUrl, revision);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to retrieve diff for revision ${revision}: ${svnFilePath}`);
        return;
    }

    await sendDiffToChat(diffText, displayName, revision);
}

/**
 * itemlog (FILE HISTORY ビュー) 用の差分取得処理
 * アクティブエディタのファイルパスと Commit ノードのリビジョンで diff を実行する
 */
async function reviewRevisionByActiveEditor(
    item: Record<string, any>
): Promise<void> {
    // Commit ノードの data.revision またはフォールバック
    const revision: string | undefined =
        item?.data?.revision ??
        item?.data?.commit?.revision ??
        item?.parent?.data?.revision;

    if (!revision) {
        vscode.window.showErrorMessage('Could not determine the SVN revision from the selected item.');
        return;
    }

    // アクティブエディタのファイル URI を取得する
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri) {
        vscode.window.showErrorMessage('No active file. Please open the file whose history you want to review.');
        return;
    }

    const scmInfo = findScmRoot(activeUri.fsPath);
    if (!scmInfo || scmInfo.type !== 'svn') {
        vscode.window.showErrorMessage('The active file does not belong to an SVN repository.');
        return;
    }

    const filePath = activeUri.fsPath;
    const displayName = `${vscode.workspace.asRelativePath(activeUri)} (r${revision})`;

    let diffText: string | undefined;
    try {
        diffText = await getSvnRevisionDiff(filePath, revision, scmInfo.root);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to retrieve diff for revision ${revision}: ${filePath}`);
        return;
    }

    await sendDiffToChat(diffText, displayName, revision);
}

/**
 * 差分テキストをバリデートして Copilot Chat に送信する共通処理
 */
async function sendDiffToChat(
    diffText: string | undefined,
    displayName: string,
    revision: string
): Promise<void> {
    if (!diffText) {
        vscode.window.showInformationMessage(`No diff found for revision ${revision}: ${displayName}`);
        return;
    }

    if (isBinary(diffText)) {
        vscode.window.showInformationMessage(`Diff contains binary content and cannot be reviewed: ${displayName}`);
        return;
    }

    const diffs: Array<{ fileName: string; diffText: string; }> = [];

    if (diffText.length > DIFF_SIZE_LIMIT) {
        const answer = await vscode.window.showWarningMessage(
            `Diff size exceeds the limit (50KB). Send only the first 50KB?\nFile: ${displayName}`,
            'Send first 50KB',
            'Cancel'
        );
        if (answer !== 'Send first 50KB') {
            return;
        }
        diffs.push({ fileName: displayName, diffText: diffText.slice(0, DIFF_SIZE_LIMIT) });
    } else {
        diffs.push({ fileName: displayName, diffText });
    }

    const prompt = buildPrompt(diffs, 0);

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}

/**
 * ワークスペース内の最初の SVN ワーキングコピー(WC)ルートパスを返す
 *
 * @returns SVN WC ルートのローカルパス。見つからない場合は undefined
 */
function findSvnWcRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }

    for (const folder of folders) {
        const dummyPath = path.join(folder.uri.fsPath, '_');
        const scmInfo = findScmRoot(dummyPath);
        if (scmInfo?.type === 'svn') {
            return scmInfo.root;
        }
    }
    return undefined;
}

/**
 * SVN repolog のコミット行ノード（viewItem == "commit"）から呼び出される
 * コミット全体の差分は大量になりうるため、Copilot 自身に svn diff を
 * 実行させるプロンプトを構築してチャットに渡す
 *
 * @param treeItem - svn-scm の repolog コミット行 TreeItem（contextValue == "commit"）
 */
export async function reviewCommit(treeItem: unknown): Promise<void> {
    const item = treeItem as Record<string, any>;

    const revision: string | undefined = item?.data?.revision;
    if (!revision) {
        vscode.window.showErrorMessage('Could not determine the SVN revision from the selected commit.');
        return;
    }

    const author: string = item?.data?.author ?? '';
    const msg: string = (item?.data?.msg ?? '').trim().split('\n')[0]; // 1行目のみ使用

    const wcRoot = findSvnWcRoot();
    if (!wcRoot) {
        vscode.window.showErrorMessage('Could not find an SVN working copy in the workspace.');
        return;
    }

    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.commitHeader(revision, author, msg, wcRoot);

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}

/** レビュー対象コミットリスト（モジュールスコープで管理） */
const reviewList: ReviewListEntry[] = [];

/**
 * SVN repolog のコミット行ノードをレビューリストに追加する
 * 複数選択時は selectedItems（第2引数）の全アイテムを追加する。
 * 重複チェックあり。追加後に hasReviewList コンテキストキーを true に設定する。
 *
 * @param treeItem      - 右クリックされた TreeItem（contextValue == "commit"）
 * @param selectedItems - 複数選択時の全選択アイテム配列（VS Code が自動的に渡す）
 */
export async function addToReviewList(treeItem: unknown, selectedItems?: unknown[]): Promise<void> {
    // 複数選択がある場合はそちらを使い、単一クリックの場合は treeItem を配列化する
    const targets: unknown[] = (selectedItems && selectedItems.length > 0) ? selectedItems : [treeItem];
    let addedCount = 0;
    for (const target of targets) {
        const item = target as Record<string, any>;
        const revision: string | undefined = item?.data?.revision;
        if (!revision) {
            continue;
        }
        if (reviewList.some(e => e.revision === revision)) {
            continue;
        }
        const author: string = item?.data?.author ?? '';
        const msg: string = (item?.data?.msg ?? '').trim().split('\n')[0];
        reviewList.push({ revision, author, msg });
        addedCount++;
    }
    if (addedCount === 0) {
        vscode.window.showInformationMessage('No new revisions were added (already in list or invalid).');
        return;
    }
    await vscode.commands.executeCommand('setContext', 'copilot-scm-code-reviewer.hasReviewList', true);
    vscode.window.showInformationMessage(`Added ${addedCount} commit(s) to review list. (total: ${reviewList.length})`);
}

/**
 * レビューリストに登録されたコミットをまとめて Copilot Chat でレビューする
 * selectedItems（複数選択）がある場合はそれを優先して reviewList に統合する。
 * 何も選択されていない場合は reviewList の蓄積分を使用する。
 * selectedItems も reviewList も空の場合は treeItem を単体でレビューする。
 * Copilot 自身に全リビジョンの svn diff を実行させるプロンプトを送信する。
 * プロンプト送信後にリストをクリアする。
 *
 * @param treeItem      - 右クリックされた TreeItem
 * @param selectedItems - 複数選択時の全選択アイテム配列（VS Code が自動的に渡す）
 */
export async function reviewMultiCommit(treeItem: unknown, selectedItems?: unknown[]): Promise<void> {
    // 複数選択がある場合は reviewList に統合する（重複除去）
    const sources: unknown[] = (selectedItems && selectedItems.length > 0) ? selectedItems : [treeItem];
    for (const source of sources) {
        const item = source as Record<string, any>;
        const revision: string | undefined = item?.data?.revision;
        if (!revision || reviewList.some(e => e.revision === revision)) {
            continue;
        }
        const author: string = item?.data?.author ?? '';
        const msg: string = (item?.data?.msg ?? '').trim().split('\n')[0];
        reviewList.push({ revision, author, msg });
    }
    if (reviewList.length === 0) {
        vscode.window.showWarningMessage('No commits to review. Add commits to the review list first.');
        return;
    }
    const wcRoot = findSvnWcRoot();
    if (!wcRoot) {
        vscode.window.showErrorMessage('Could not find an SVN working copy in the workspace.');
        return;
    }
    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.multiCommitHeader([...reviewList], wcRoot);
    reviewList.length = 0;
    await vscode.commands.executeCommand('setContext', 'copilot-scm-code-reviewer.hasReviewList', false);
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
}
