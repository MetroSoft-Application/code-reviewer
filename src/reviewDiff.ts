/**
 * SCM差分を取得してGitHub Copilot Chatに渡すコードレビュー処理
 * GitおよびSVNの両方に対応する
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { GitExtension, Repository, Change } from './api/git';
import type { GitHubPRAPI, ReviewerComments, ReviewerCommentsContext } from './api/githubPr';
import { PROMPT_TEMPLATES, DEFAULT_LANG, resolveLanguage, ReviewListEntry, GitReviewListEntry, SvnGroupRoots } from './promptTemplates';

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
 * 指定したコミットハッシュを持つリポジトリを返す
 * 単一リポジトリの場合はそのままそのリポジトリを返す
 * 複数リポジトリの場合は各リポジトリで getCommit を試みて一致したものを返す
 * いずれにも見つからない場合は先頭リポジトリをフォールバックとして返す
 *
 * @param gitAPI - vscode.git API インスタンス
 * @param hash   - 検索するコミットハッシュ
 * @returns 対象リポジトリ。リポジトリが存在しない場合は undefined
 */
async function findRepoForCommit(
    gitAPI: ReturnType<GitExtension['getAPI']>,
    hash: string
): Promise<Repository | undefined> {
    if (gitAPI.repositories.length === 0) {
        return undefined;
    }
    if (gitAPI.repositories.length === 1) {
        return gitAPI.repositories[0];
    }
    for (const repo of gitAPI.repositories) {
        try {
            await repo.getCommit(hash);
            return repo;
        } catch {
            // このリポジトリにはないので次へ
        }
    }
    return gitAPI.repositories[0];
}

type InternalPrFileChange = {
    fileName: string;
    previousFileName?: string;
    patch?: string;
};

type ActivePullRequestContext = {
    baseRef?: string;
    baseSha?: string;
    headSha?: string;
    mergeBase?: string;
    fileChanges: InternalPrFileChange[];
};

/**
 * GitHub Pull Request 拡張の内部モデルから、現在レビュー中の PR 情報を取得する。
 * 公開 API に changed files 一覧がないため、利用可能なときのみ内部 model を参照する。
 */
async function getActivePullRequestContext(repo: Repository): Promise<ActivePullRequestContext | undefined> {
    const ghPrExt = vscode.extensions.getExtension<GitHubPRAPI>('github.vscode-pull-request-github');
    if (!ghPrExt?.isActive) {
        return undefined;
    }

    const api = ghPrExt.exports as GitHubPRAPI & {
        repositoriesManager?: {
            getManagerForFile?: (uri: vscode.Uri) => {
                activePullRequest?: {
                    base?: { ref?: string; sha?: string; };
                    head?: { sha?: string; };
                    mergeBase?: string;
                    fileChanges?: Map<string, InternalPrFileChange>;
                    getFileChangesInfo?: () => Promise<InternalPrFileChange[]>;
                };
            };
        };
    };

    const manager = api.repositoriesManager?.getManagerForFile?.(repo.rootUri);
    const activePullRequest = manager?.activePullRequest;
    if (!activePullRequest) {
        return undefined;
    }

    let fileChangesMap = activePullRequest.fileChanges;
    if ((!fileChangesMap || fileChangesMap.size === 0) && activePullRequest.getFileChangesInfo) {
        try {
            await activePullRequest.getFileChangesInfo();
            fileChangesMap = activePullRequest.fileChanges;
        } catch {
            fileChangesMap = activePullRequest.fileChanges;
        }
    }

    return {
        baseRef: activePullRequest.base?.ref,
        baseSha: activePullRequest.base?.sha,
        headSha: activePullRequest.head?.sha,
        mergeBase: activePullRequest.mergeBase,
        fileChanges: fileChangesMap ? [...fileChangesMap.values()] : [],
    };
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
 * テキストを LF 区切りの行配列に正規化する
 */
function splitNormalizedLines(content: string): string[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * 旧内容と新内容から単純な unified diff 形式の文字列を生成する
 * 最小差分ではなく、ファイル全体を 1 つのハンクとして扱うフォールバック用途
 */
function buildReplacementDiff(
    relativePath: string,
    beforeContent: string,
    afterContent: string
): string {
    const beforeLines = splitNormalizedLines(beforeContent);
    const afterLines = splitNormalizedLines(afterContent);

    return [
        `--- a/${relativePath}`,
        `+++ b/${relativePath}`,
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
        ...beforeLines.map(line => `-${line}`),
        ...afterLines.map(line => `+${line}`),
    ].join('\n');
}

/**
 * 任意の URI から UTF-8 テキストを読み込む
 * 読み込めない場合やバイナリの場合は undefined を返す
 */
async function readTextFromUri(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const rawContent = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(rawContent).toString('utf8');
        return isBinary(content) ? undefined : content;
    } catch {
        return undefined;
    }
}

/**
 * 未知の値が vscode.Uri 相当かを判定する
 */
function isUriLike(value: unknown): value is vscode.Uri {
    return typeof value === 'object' && value !== null &&
        'scheme' in value &&
        'authority' in value &&
        'path' in value &&
        'query' in value;
}

/**
 * オブジェクト/配列を再帰的にたどって含まれる URI を収集する
 */
function collectUris(
    value: unknown,
    results: vscode.Uri[],
    visited: Set<unknown> = new Set(),
    depth = 0
): void {
    if (depth > 4 || value === null || value === undefined) {
        return;
    }

    if (isUriLike(value)) {
        results.push(value);
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    if (visited.has(value)) {
        return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectUris(item, results, visited, depth + 1);
        }
        return;
    }

    for (const nestedValue of Object.values(value)) {
        collectUris(nestedValue, results, visited, depth + 1);
    }
}

/**
 * URI 文字列から差分の旧側/新側らしさを推定するための簡易スコア
 */
function getUriDiffSideScore(uri: vscode.Uri, resourceUri: vscode.Uri): number {
    const text = uri.toString().toLowerCase();

    if (text.includes('base') || text.includes('original') || text.includes('old')) {
        return 0;
    }

    if (
        text.includes('head') ||
        text.includes('working') ||
        text.includes('modified') ||
        text.includes('new') ||
        uri.toString() === resourceUri.toString()
    ) {
        return 1;
    }

    return 0.5;
}

/**
 * SCM リソースに紐づくコマンド引数から比較対象 URI を推定し、差分文字列を生成する
 * Remote Changes など、通常の git/svn diff で取得できないケース向けのフォールバック
 */
async function getDiffTextFromResourceState(
    resourceState: vscode.SourceControlResourceState
): Promise<string | undefined> {
    const relativePath = vscode.workspace.asRelativePath(resourceState.resourceUri);
    const commandUris: vscode.Uri[] = [];

    collectUris(resourceState.command?.arguments, commandUris);

    const distinctCommandUris = commandUris.filter((uri, index, list) =>
        list.findIndex(candidate => candidate.toString() === uri.toString()) === index
    );

    let beforeUri: vscode.Uri | undefined;
    let afterUri: vscode.Uri | undefined;

    if (distinctCommandUris.length >= 2) {
        const [firstUri, secondUri] = distinctCommandUris;
        const firstScore = getUriDiffSideScore(firstUri, resourceState.resourceUri);
        const secondScore = getUriDiffSideScore(secondUri, resourceState.resourceUri);

        if (firstScore <= secondScore) {
            beforeUri = firstUri;
            afterUri = secondUri;
        } else {
            beforeUri = secondUri;
            afterUri = firstUri;
        }
    } else if (distinctCommandUris.length === 1) {
        const [candidateUri] = distinctCommandUris;
        if (candidateUri.toString() !== resourceState.resourceUri.toString()) {
            beforeUri = candidateUri;
            afterUri = resourceState.resourceUri;
        }
    }

    if (!beforeUri && !afterUri) {
        return undefined;
    }

    const [beforeContent, afterContent] = await Promise.all([
        beforeUri ? readTextFromUri(beforeUri) : Promise.resolve(undefined),
        afterUri ? readTextFromUri(afterUri) : Promise.resolve(undefined),
    ]);

    if (beforeContent === undefined && afterContent === undefined) {
        return undefined;
    }

    if (beforeContent === undefined && afterContent !== undefined) {
        return buildPseudoDiff(relativePath, afterContent, '+', '/dev/null', `b/${relativePath}`);
    }

    if (beforeContent !== undefined && afterContent === undefined) {
        return buildPseudoDiff(relativePath, beforeContent, '-', `a/${relativePath}`, '/dev/null');
    }

    if (beforeContent === afterContent) {
        return undefined;
    }

    return buildReplacementDiff(relativePath, beforeContent ?? '', afterContent ?? '');
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
 * git コマンドを実行して標準出力を返す
 */
function runGitCommand(gitPath: string, repoRoot: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(gitPath, ['-C', repoRoot, ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error((stderr || err.message).trim()));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * 2つの ref 間で変更されたファイルの相対パス一覧を取得する
 */
async function getChangedFilesBetweenRefs(
    gitPath: string,
    repo: Repository,
    ref1: string,
    ref2: string
): Promise<string[]> {
    const repoRoot = repo.rootUri.fsPath;
    const range = `${ref1}...${ref2}`;

    try {
        const stdout = await runGitCommand(gitPath, repoRoot, [
            'diff',
            '--name-only',
            '--diff-filter=ACDMRTUXB',
            '-z',
            range,
        ]);

        return stdout
            .split('\0')
            .map(entry => entry.trim())
            .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);
    } catch {
        const changes = await repo.diffBetween(ref1, ref2);
        return changes
            .map(change => path.relative(repoRoot, change.uri.fsPath).replace(/\\/g, '/'))
            .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);
    }
}

/**
 * 2つの ref 間における単一ファイルの diff を取得する
 */
async function getGitDiffBetweenRefs(
    gitPath: string,
    repo: Repository,
    ref1: string,
    ref2: string,
    relativePath: string
): Promise<string | undefined> {
    const repoRoot = repo.rootUri.fsPath;
    const range = `${ref1}...${ref2}`;

    try {
        const stdout = await runGitCommand(gitPath, repoRoot, [
            'diff',
            '--no-ext-diff',
            range,
            '--',
            relativePath,
        ]);
        return stdout.trim().length > 0 ? stdout : undefined;
    } catch {
        const absolutePath = path.join(repoRoot, relativePath);
        return repo.diffBetween(ref1, ref2, absolutePath).catch(() => undefined);
    }
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
 * `svn diff -r BASE:HEAD` で Remote Changes のdiffテキストを取得する
 */
function getSvnRemoteDiffOutput(
    filePath: string,
    scmRoot: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        cp.exec(`svn diff -r BASE:HEAD "${filePath}"`, { cwd: scmRoot }, (err, stdout) => {
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

        const remoteDiffOutput = await getSvnRemoteDiffOutput(filePath, scmRoot);
        if (remoteDiffOutput) {
            return remoteDiffOutput;
        }

        const content = await getSvnBaseContent(filePath, scmRoot);
        if (!content || isBinary(content)) {
            return undefined;
        }
        return buildPseudoDiff(relativePath, content, '-', `a/${relativePath}`, '/dev/null');
    }

    // 通常の変更ファイル / Remote Changes
    const diffOutput = await getSvnDiffOutput(filePath, scmRoot);
    if (diffOutput) {
        return diffOutput;
    }

    return getSvnRemoteDiffOutput(filePath, scmRoot);
}

/**
 * Git/SVNを自動判別して差分テキストを取得するディスパッチャー
 * 1. vscode.git APIでGitリポジトリとして認識される場合 → getDiffTextGit
 * 2. 認識されない場合は .svn を検索 → getDiffTextSvn
 * 3. どちらも認識できない場合はundefined
 */
async function getFileDiffText(
    resourceState: vscode.SourceControlResourceState,
    gitAPI: ReturnType<GitExtension['getAPI']> | undefined
): Promise<string | undefined> {
    const resourceUri = resourceState.resourceUri;

    // Git を試みる
    if (gitAPI) {
        const gitRepo = getRepositoryForUri(gitAPI, resourceUri);
        if (gitRepo) {
            const diffText = await getDiffTextGit(gitRepo, resourceUri);
            if (diffText) {
                return diffText;
            }
        }
    }

    // SVN を試みる
    const scmInfo = findScmRoot(resourceUri.fsPath);
    if (scmInfo && scmInfo.type === 'svn') {
        const diffText = await getDiffTextSvn(resourceUri, scmInfo.root);
        if (diffText) {
            return diffText;
        }
    }

    return getDiffTextFromResourceState(resourceState);
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
type ScmResourceGroup = {
    /** グループID（例: workingTree / index / changes / unversioned / remotechanges） */
    id?: string;
    /** 表示ラベル（例: Changes / Staged Changes / Unversioned / Remote Changes） */
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
function resolveGitGroupKind(group: ScmResourceGroup): 'staged' | 'unstaged' | undefined {
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
    group: ScmResourceGroup,
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
        .filter((item): item is ScmResourceGroup => !!item)
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

    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.gitGroupHeader([...commands]);

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}

type SvnGroupKind = 'local' | 'unversioned' | 'remote';

/** SVN SCM のグループ ID から差分の取得方法を判定する */
function resolveSvnGroupKind(group: ScmResourceGroup): SvnGroupKind | undefined {
    const id = (group.id ?? '').toLowerCase();
    const label = (group.label ?? '').toLowerCase();

    if (id === 'remotechanges' || label.includes('remote changes') || label.includes('リモート')) {
        return 'remote';
    }

    if (id === 'unversioned' || label.includes('unversioned') || label.includes('未管理')) {
        return 'unversioned';
    }

    if (id === 'changes' || label === 'changes' || label === '変更') {
        return 'local';
    }

    return undefined;
}

/**
 * SVN SCM の Changes / Unversioned / Remote Changes 等のセクションを一括レビューする。
 * ワーキングコピー単位のコマンドで、Copilot がセクション全体の差分または内容を収集する。
 */
export async function reviewSvnGroups(
    group: unknown,
    ...selectedGroups: unknown[]
): Promise<void> {
    const targets = [group, ...selectedGroups]
        .filter((item): item is ScmResourceGroup => !!item)
        .filter((item, index, list) => {
            const firstUri = item.resourceStates?.[0]?.resourceUri.toString() ?? '';
            return list.findIndex(candidate =>
                candidate.id === item.id &&
                candidate.label === item.label &&
                (candidate.resourceStates?.[0]?.resourceUri.toString() ?? '') === firstUri
            ) === index;
        });

    const resolvedGroups = targets.flatMap(target => {
        const kind = resolveSvnGroupKind(target);
        if (!kind) {
            return [];
        }

        const roots = (target.resourceStates ?? [])
            .map(resource => findScmRoot(resource.resourceUri.fsPath))
            .filter((scmInfo): scmInfo is { root: string; type: 'svn'; } => scmInfo?.type === 'svn')
            .map(scmInfo => scmInfo.root)
            .filter((root, index, list) => list.indexOf(root) === index);

        return roots.length > 0 ? [{ kind, roots }] : [];
    });

    if (resolvedGroups.length === 0) {
        vscode.window.showWarningMessage(
            'Could not find files in the selected SVN section. Try right-clicking Changes, Unversioned, or Remote Changes.'
        );
        return;
    }

    const roots: SvnGroupRoots = {
        local: [...new Set(resolvedGroups.filter(group => group.kind === 'local').flatMap(group => group.roots))],
        remote: [...new Set(resolvedGroups.filter(group => group.kind === 'remote').flatMap(group => group.roots))],
        unversioned: [...new Set(resolvedGroups.filter(group => group.kind === 'unversioned').flatMap(group => group.roots))],
    };
    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: template.svnGroupHeader(roots),
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
            diffText = await getFileDiffText(target, gitAPI);
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

/**
 * GitHub PR 拡張機能の ReviewerCommentsProvider 実装
 * PR の変更ファイル一覧を QuickPick で絞り込み、選択ファイルの差分を Copilot Chat に送信する
 *
 * @param context - GitHub PR 拡張機能から渡される PR コンテキスト（パッチ情報を含む）
 * @param token   - キャンセルトークン
 * @returns レビュー結果（選択ファイルの URI と成否）
 */
export async function openPrFileReviewViaProvider(
    context: ReviewerCommentsContext,
    token: vscode.CancellationToken
): Promise<ReviewerComments | undefined> {
    const { patches, repositoryRoot } = context;

    if (patches.length === 0 || token.isCancellationRequested) {
        return { files: [], succeeded: false };
    }

    const items = patches.map(p => ({
        label: p.fileUri.split('/').pop() ?? p.fileUri,
        description: p.fileUri,
        patch: p,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'レビューするファイルを選択 (複数選択可)',
        title: 'PR 変更ファイルのプレビューレビュー',
    });

    if (!selected || selected.length === 0 || token.isCancellationRequested) {
        return { files: [], succeeded: false };
    }

    const diffs: Array<{ fileName: string; diffText: string; }> = [];
    let totalSize = 0;
    let skippedCount = 0;

    for (const item of selected) {
        const patchText = item.patch.patch;
        const fileUri = item.patch.fileUri;

        if (!patchText || isBinary(patchText)) {
            skippedCount++;
            continue;
        }

        if (totalSize + patchText.length > DIFF_SIZE_LIMIT) {
            skippedCount += selected.length - diffs.length;
            break;
        }

        totalSize += patchText.length;
        diffs.push({ fileName: fileUri, diffText: patchText });
    }

    if (diffs.length === 0) {
        return { files: [], succeeded: false };
    }

    const prompt = buildPrompt(diffs, skippedCount);
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });

    const selectedUris = selected.map(item => {
        const rawUri = item.patch.fileUri;
        try {
            const parsed = vscode.Uri.parse(rawUri, true);
            // scheme が file 以外（https 等）はリポジトリルートからの相対パスとして扱う
            if (parsed.scheme !== 'file') {
                return vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), rawUri);
            }
            return parsed;
        } catch {
            return vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), rawUri);
        }
    });

    return { files: selectedUris, succeeded: true };
}

// ---------------------------------------------------------------------------
// Git Timeline (Timeline ビュー) のコミットレビュー機能
// ---------------------------------------------------------------------------

/** Git コミットレビューリスト（モジュールスコープで管理） */
const gitReviewList: GitReviewListEntry[] = [];

/**
 * VS Code の Timeline ビューで Git コミットを右クリックしたときのコマンドハンドラー
 * Copilot 自身に `git show <hash>` を実行させるプロンプトを構築してチャットに渡す
 *
 * scm/historyItem/context コマンドへの引数は SourceControlHistoryItem 1つ。
 * Git プロバイダーが生成するアイテムの `id` プロパティがコミットハッシュ。
 *
 * @param item - VS Code の SourceControlHistoryItem（id プロパティに commit hash を含む）
 */
function normalizeGitCommitHash(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const hash = value.trim();
    return /^[0-9a-f]{7,40}$/i.test(hash) ? hash : undefined;
}

async function reviewGitCommitByHash(
    hash: string,
    details?: Record<string, any>
): Promise<void> {
    const gitAPI = getGitAPI();
    if (!gitAPI) {
        vscode.window.showErrorMessage('Git 拡張機能が利用できません。');
        return;
    }

    const repo = await findRepoForCommit(gitAPI, hash);
    if (!repo) {
        vscode.window.showErrorMessage('Git リポジトリが見つかりません。');
        return;
    }

    let author = String(details?.author ?? '').trim();
    let msg = String(details?.subject ?? details?.message ?? '').trim().split('\n')[0];

    // コマンドパレットから起動した場合は SourceControlHistoryItem が渡されないため、
    // Git API からコミット情報を補完する。
    if (!author || !msg) {
        try {
            const commit = await repo.getCommit(hash);
            author ||= String(commit.authorName ?? '');
            msg ||= String(commit.message ?? '').trim().split('\n')[0];
        } catch {
            vscode.window.showErrorMessage('選択した Git コミットを読み込めませんでした。');
            return;
        }
    }

    const repoRoot = repo.rootUri.fsPath;
    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.gitCommitHeader(hash, author, msg, repoRoot);

    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
}

export async function reviewGitCommit(_scmProvider: unknown, historyItem: unknown): Promise<void> {
    const hi = historyItem as Record<string, any>;
    const hash = normalizeGitCommitHash(hi?.id);
    if (!hash) {
        vscode.window.showErrorMessage('選択したコミットのハッシュを取得できませんでした。');
        return;
    }

    await reviewGitCommitByHash(hash, hi);
}

/**
 * 通常の VS Code で提案 API を有効化できない場合の代替コマンド。
 * SCM Graph の「コミット ハッシュのコピー」後に実行する。
 */
export async function reviewGitCommitFromClipboard(): Promise<void> {
    let clipboardText = '';
    try {
        clipboardText = await vscode.env.clipboard.readText();
    } catch {
        // クリップボードを読めない場合は入力ダイアログにフォールバックする。
    }

    let hash = normalizeGitCommitHash(clipboardText);
    if (!hash) {
        const input = await vscode.window.showInputBox({
            title: 'Review Git Commit with Copilot',
            prompt: 'Enter the Git commit hash to review.',
            placeHolder: '40-character commit hash',
            validateInput: value => normalizeGitCommitHash(value)
                ? undefined
                : 'Enter a Git commit hash with 7 to 40 hexadecimal characters.',
        });
        hash = normalizeGitCommitHash(input);
    }

    if (!hash) {
        return;
    }

    await reviewGitCommitByHash(hash);
}

/**
 * ソース管理履歴ビューで Git コミットをレビューリストに追加するコマンドハンドラー
 * 重複チェックを行い、追加後に hasGitReviewList コンテキストキーを true に設定する
 *
 * @param item - VS Code の SourceControlHistoryItem
 */
export async function addGitCommitToReviewList(_scmProvider: unknown, historyItem: unknown): Promise<void> {
    const gitAPI = getGitAPI();
    if (!gitAPI) {
        vscode.window.showErrorMessage('Git 拡張機能が利用できません。');
        return;
    }

    const hi = historyItem as Record<string, any>;
    const hash: string | undefined = hi?.id;
    if (!hash || hash.length < 7) {
        vscode.window.showErrorMessage('選択したコミットのハッシュを取得できませんでした。');
        return;
    }

    if (gitReviewList.some(e => e.hash === hash)) {
        vscode.window.showInformationMessage(`Commit ${hash.slice(0, 7)} is already in the review list.`);
        return;
    }

    const repo = await findRepoForCommit(gitAPI, hash);
    if (!repo) {
        vscode.window.showErrorMessage('Git リポジトリが見つかりません。');
        return;
    }

    const author = String(hi.author ?? '');
    const msg = String(hi.subject ?? hi.message ?? '').trim().split('\n')[0];
    const repoRoot = repo.rootUri.fsPath;
    gitReviewList.push({ hash, author, msg, repoRoot });
    await vscode.commands.executeCommand('setContext', 'copilot-scm-code-reviewer.hasGitReviewList', true);
    vscode.window.showInformationMessage(`Added commit ${hash.slice(0, 7)} to review list. (total: ${gitReviewList.length})`);
}

/**
 * Git コミットレビューリストに蓄積されたコミットをまとめてレビューするコマンドハンドラー
 * Copilot に全コミットの `git show` を実行させるプロンプトを構築してチャットに渡す
 * プロンプト送信後にリストをクリアする
 *
 * @param _item - VS Code の SourceControlHistoryItem（未使用）
 */
export async function reviewMultiGitCommit(_item: unknown): Promise<void> {
    if (gitReviewList.length === 0) {
        vscode.window.showWarningMessage('No commits to review. Add commits to the review list first.');
        return;
    }

    const repoRoot = gitReviewList[0].repoRoot;
    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.multiGitCommitHeader([...gitReviewList], repoRoot);

    gitReviewList.length = 0;
    await vscode.commands.executeCommand('setContext', 'copilot-scm-code-reviewer.hasGitReviewList', false);
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
}

/**
 * SCM Graph の変更ファイル行から、選択されたファイルだけをレビューする。
 * コミット行のメニューとは別のコンテキストで呼び出され、
 * `historyItem` と `historyItemChange` の2つを受け取る。
 */
function parseHistoryChangeUri(value: unknown): vscode.Uri | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const candidate = value as {
        scheme?: unknown;
        path?: unknown;
        toString?: () => string;
    };

    if (typeof candidate.scheme !== 'string' || typeof candidate.path !== 'string') {
        return undefined;
    }

    try {
        const serialized = typeof candidate.toString === 'function'
            ? candidate.toString()
            : `${candidate.scheme}:${candidate.path}`;
        return vscode.Uri.parse(serialized, true);
    } catch {
        return undefined;
    }
}

function getHistoryChangeFilePath(repoRoot: string, historyItemChange: unknown): string | undefined {
    const change = historyItemChange as Record<string, unknown> | undefined;
    const resourceUri = parseHistoryChangeUri(change?.uri)
        ?? parseHistoryChangeUri(change?.modifiedUri)
        ?? parseHistoryChangeUri(change?.originalUri);

    if (!resourceUri) {
        return undefined;
    }

    const relativePath = path.relative(repoRoot, resourceUri.fsPath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return undefined;
    }

    return relativePath.split(path.sep).join('/');
}

export async function reviewGitCommitFile(
    _scmProvider: unknown,
    historyItem: unknown,
    historyItemChange?: unknown
): Promise<void> {
    const gitAPI = getGitAPI();
    if (!gitAPI) {
        vscode.window.showErrorMessage('Git 拡張機能が利用できません。');
        return;
    }

    const hi = historyItem as Record<string, any>;
    const hash = normalizeGitCommitHash(hi?.id);
    if (!hash) {
        vscode.window.showErrorMessage('選択したコミットのハッシュを取得できませんでした。');
        return;
    }

    const repo = await findRepoForCommit(gitAPI, hash);
    if (!repo) {
        vscode.window.showErrorMessage('Git リポジトリが見つかりません。');
        return;
    }

    const repoRoot = repo.rootUri.fsPath;

    if (historyItemChange) {
        const filePath = getHistoryChangeFilePath(repoRoot, historyItemChange);
        if (!filePath) {
            vscode.window.showErrorMessage('選択された変更ファイルのパスを取得できませんでした。ファイル行から実行してください。');
            return;
        }

        let author = String(hi.author ?? '').trim();
        let msg = String(hi.subject ?? hi.message ?? '').trim().split('\n')[0];
        if (!author || !msg) {
            try {
                const commit = await repo.getCommit(hash);
                author ||= String(commit.authorName ?? '');
                msg ||= String(commit.message ?? '').trim().split('\n')[0];
            } catch {
                vscode.window.showErrorMessage('選択された Git コミットを読み込めませんでした。');
                return;
            }
        }

        const lang = resolveLanguage();
        const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
        const prompt = template.gitCommitFileHeader(hash, author, msg, repoRoot, [filePath]);

        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        return;
    }

    // コミット内の変更ファイル一覧を取得する
    const filesOutput = await new Promise<string>((resolve) => {
        cp.exec(
            `git -C "${repoRoot}" show --name-status --format="" ${hash}`,
            { encoding: 'utf8' },
            (_err, stdout) => resolve(stdout ?? '')
        );
    });

    type FileEntry = { filePath: string; label: string; };
    const fileEntries: FileEntry[] = [];

    const statusIcons: Record<string, string> = { M: '~', A: '+', D: '-', R: '→', C: '©' };

    for (const line of filesOutput.trim().split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const parts = line.split('\t');
        if (parts.length < 2) {
            continue;
        }
        const statusChar = parts[0].charAt(0).toUpperCase();
        const icon = statusIcons[statusChar] ?? '?';

        if ((statusChar === 'R' || statusChar === 'C') && parts.length >= 3) {
            // リネーム / コピー: 新パスを使用する
            fileEntries.push({ filePath: parts[2], label: `${icon} ${parts[2]}` });
        } else {
            fileEntries.push({ filePath: parts[1], label: `${icon} ${parts[1]}` });
        }
    }

    if (fileEntries.length === 0) {
        vscode.window.showWarningMessage('このコミットに変更ファイルが見つかりませんでした。');
        return;
    }

    const picks = await vscode.window.showQuickPick(
        fileEntries.map(e => ({ label: e.label, filePath: e.filePath })),
        {
            title: `コミット ${hash.slice(0, 7)} — レビューするファイルを選択`,
            placeHolder: 'レビューするファイルを選択してください（複数選択可）',
            canPickMany: true,
        }
    );

    if (!picks || picks.length === 0) {
        return;
    }

    const selectedFiles = picks.map(p => p.filePath);
    const author = String(hi.author ?? '');
    const msg = String(hi.subject ?? hi.message ?? '').trim().split('\n')[0];

    const lang = resolveLanguage();
    const template = PROMPT_TEMPLATES[lang] ?? PROMPT_TEMPLATES[DEFAULT_LANG];
    const prompt = template.gitCommitFileHeader(hash, author, msg, repoRoot, selectedFiles);

    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
}

/**
 * SCM タイトルバーから呼び出されるスタンドアロンコマンド
 * 現在のブランチとベースブランチとの差分ファイルを QuickPick で選択してレビューする
 * ベースブランチは GitHub PR 拡張機能 → origin/HEAD → origin/main → origin/master の優先順で検出する
 */
export async function reviewPrFiles(): Promise<void> {
    const gitAPI = getGitAPI();
    if (!gitAPI) {
        vscode.window.showErrorMessage('Git 拡張機能が利用できません。');
        return;
    }

    const gitPath = gitAPI.git.path || 'git';

    // リポジトリを取得する（選択中リポジトリを優先し、次にアクティブエディタ/ワークスペースを試す）
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let repo = gitAPI.repositories.find(repository => repository.ui.selected);

    if (!repo) {
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        if (activeEditorUri) {
            repo = getRepositoryForUri(gitAPI, activeEditorUri);
        }
    }

    if (!repo && workspaceFolders && workspaceFolders.length > 0) {
        repo = getRepositoryForUri(gitAPI, workspaceFolders[0].uri);
    }

    if (!repo && gitAPI.repositories.length > 0) {
        repo = gitAPI.repositories[0];
    }

    if (!repo) {
        vscode.window.showErrorMessage('Git リポジトリが見つかりません。');
        return;
    }

    const activePullRequest = await getActivePullRequestContext(repo);
    const fileChangesByPath = new Map(
        (activePullRequest?.fileChanges ?? [])
            .filter(change => !!change.fileName)
            .map(change => [change.fileName, change])
    );

    let mergeBase: string | undefined;
    let baseRefForDiff: string | undefined;
    let headRefForDiff = 'HEAD';
    let changedFiles: string[] | undefined;

    if (fileChangesByPath.size > 0) {
        changedFiles = [...fileChangesByPath.keys()];
        baseRefForDiff = activePullRequest?.mergeBase ?? activePullRequest?.baseSha;
        headRefForDiff = activePullRequest?.headSha ?? 'HEAD';
    }

    // active PR から changed files を取れない場合のみ、ローカル Git から推定する
    if (!changedFiles) {
        try {
            const ghPrExt = vscode.extensions.getExtension<GitHubPRAPI>('github.vscode-pull-request-github');
            if (ghPrExt?.isActive) {
                const repoDesc = await ghPrExt.exports.getRepositoryDescription(repo.rootUri);
                const candidateBaseRef = activePullRequest?.baseRef ?? repoDesc?.defaultBranch;
                if (candidateBaseRef) {
                    mergeBase = await repo.getMergeBase('HEAD', `origin/${candidateBaseRef}`)
                        .catch(() => undefined);
                }
            }
        } catch {
            // GitHub PR 拡張機能が利用できない場合は無視する
        }

        // フォールバック：一般的なブランチ名を順に試みる
        if (!mergeBase) {
            for (const base of ['origin/HEAD', 'origin/main', 'origin/master', 'origin/develop']) {
                mergeBase = await repo.getMergeBase('HEAD', base).catch(() => undefined);
                if (mergeBase) { break; }
            }
        }

        if (!mergeBase) {
            vscode.window.showErrorMessage(
                'マージベースを検出できませんでした。' +
                'フィーチャーブランチ上で実行し、リモートブランチ (origin/main 等) が存在するか確認してください。'
            );
            return;
        }

        baseRefForDiff = mergeBase;

        try {
            changedFiles = await getChangedFilesBetweenRefs(gitPath, repo, mergeBase, 'HEAD');
        } catch {
            vscode.window.showErrorMessage('変更ファイルの取得に失敗しました。');
            return;
        }
    }

    if (!changedFiles || changedFiles.length === 0) {
        vscode.window.showInformationMessage('ベースブランチとの差分はありません。');
        return;
    }

    type PrFileItem = vscode.QuickPickItem & { relativePath: string; };

    const items: PrFileItem[] = changedFiles.map(relativePath => ({
        label: path.basename(relativePath),
        description: relativePath,
        relativePath,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'レビューするファイルを選択 (複数選択可)',
        title: 'PR 変更ファイルのプレビューレビュー',
    });

    if (!selected || selected.length === 0) {
        return;
    }

    const diffs: Array<{ fileName: string; diffText: string; }> = [];
    let totalSize = 0;
    let skippedCount = 0;

    for (const item of selected) {
        const fileName = item.description ?? item.label;
        let diffText: string | undefined;
        const fileChange = fileChangesByPath.get(item.relativePath);

        try {
            if (fileChange?.patch) {
                diffText = fileChange.patch;
            } else if (baseRefForDiff) {
                diffText = await getGitDiffBetweenRefs(gitPath, repo, baseRefForDiff, headRefForDiff, item.relativePath);
            }
        } catch {
            skippedCount++;
            continue;
        }

        if (!diffText || isBinary(diffText)) {
            skippedCount++;
            continue;
        }

        if (totalSize + diffText.length > DIFF_SIZE_LIMIT) {
            skippedCount += selected.length - diffs.length;
            break;
        }

        totalSize += diffText.length;
        diffs.push({ fileName, diffText });
    }

    if (diffs.length === 0) {
        vscode.window.showInformationMessage('レビュー可能な差分が見つかりませんでした。');
        return;
    }

    const prompt = buildPrompt(diffs, skippedCount);
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
}
