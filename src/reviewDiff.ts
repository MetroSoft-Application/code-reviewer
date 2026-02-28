/**
 * reviewDiff.ts
 * SCM差分を取得してGitHub Copilot Chatに渡すコードレビュー処理
 */
import * as vscode from 'vscode';
import type { GitExtension, Repository } from './api/git';
// Status は const enum のため type-only import では使用できない
import { Status } from './api/git';

/*
 * 差分テキストの上限サイズ（文字数）
 * GPT-4oのコンテキストウィンドウ（128Kトークン）に対して安全マージンを確保するため
 * コード換算で50KBを上限とする
 */
const DIFF_SIZE_LIMIT = 50_000;

/**
 * 言語コードとプロンプト文言のテーブル
 * キーはcode-reviewer.reviewLanguageの enum 値（auto を除く）
 */
const PROMPT_TEMPLATES: Record<string, {
    header: string;
    fileLabel: string;
    skipNotice: (count: number) => string;
}> = {
    ja: {
        header: '以下のgit差分をコードレビューしてください。\n各ファイルについて、問題点・改善案・良い点をそれぞれ具体的に指摘してください。',
        fileLabel: 'ファイル',
        skipNotice: (n) => `> 注意: 差分サイズが上限を超えたため、${n}件のファイルをスキップしました。`,
    },
    en: {
        header: 'Please review the following git diff.\nFor each file, point out problems, suggestions for improvement, and good points specifically.',
        fileLabel: 'File',
        skipNotice: (n) => `> Note: ${n} file(s) were skipped because the diff size exceeded the limit.`,
    },
    'zh-cn': {
        header: '请对以下git差异进行代码审查。\n对于每个文件，请具体指出问题、改进建议和优点。',
        fileLabel: '文件',
        skipNotice: (n) => `> 注意：由于差异大小超出限制，已跳过 ${n} 个文件。`,
    },
    ko: {
        header: '다음 git 차이를 코드 리뷰해주세요.\n각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.',
        fileLabel: '파일',
        skipNotice: (n) => `> 주의: 차이 크기가 제한을 초과하여 ${n}개의 파일을 건너뛰었습니다.`,
    },
    fr: {
        header: 'Veuillez effectuer une revue de code du diff git suivant.\nPour chaque fichier, indiquez précisément les problèmes, les suggestions d\'amélioration et les points positifs.',
        fileLabel: 'Fichier',
        skipNotice: (n) => `> Remarque : ${n} fichier(s) ont été ignorés car la taille du diff dépassait la limite.`,
    },
    de: {
        header: 'Bitte führen Sie ein Code-Review des folgenden Git-Diffs durch.\nGeben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.',
        fileLabel: 'Datei',
        skipNotice: (n) => `> Hinweis: ${n} Datei(en) wurden übersprungen, da die Diff-Größe das Limit überschritten hat.`,
    },
    es: {
        header: 'Por favor, realice una revisión de código del siguiente diff de git.\nPara cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.',
        fileLabel: 'Archivo',
        skipNotice: (n) => `> Nota: Se omitieron ${n} archivo(s) porque el tamaño del diff superó el límite.`,
    },
};

/** デフォルトは英語 */
const DEFAULT_LANG = 'en';

/**
 * 設定とVS CodeのUI言語からプロンプト用の言語コードを解決する
 * - 設定が "auto" の場合は vscode.env.language から判定
 * - 未対応言語は英語にフォールバックする
 *
 * @returns PROMPT_TEMPLATES のキー（一致するcode-reviewer.reviewLanguageのenum値）
 */
function resolveLanguage(): string {
    const configured = vscode.workspace
        .getConfiguration('code-reviewer')
        .get<string>('reviewLanguage', 'auto');

    if (configured !== 'auto') {
        /*
         * 明示指定の場合はenum値をそのまま使用する
         * PROMPT_TEMPLATESに存在しない場合はデフォルトにフォールバックする
         */
        return configured in PROMPT_TEMPLATES ? configured : DEFAULT_LANG;
    }

    /*
     * auto の場合は vscode.env.language から判定する
     * vscode.env.language は "ja", "en-us", "zh-cn", "ko" などの形式で返る
     */
    const vscodeLang = vscode.env.language.toLowerCase();
    if (vscodeLang.startsWith('zh')) {
        return 'zh-cn';
    }
    const twoChar = vscodeLang.slice(0, 2);
    return twoChar in PROMPT_TEMPLATES ? twoChar : DEFAULT_LANG;
}

/**
 * vscode.git拡張機能のAPIインスタンスを取得する
 * @returns git APIインスタンス。取得できない場合はundefined
 */
function getGitAPI(): ReturnType<GitExtension['getAPI']> | undefined {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
        vscode.window.showErrorMessage('vscode.git extension not found.');
        return undefined;
    }
    if (!gitExtension.isActive) {
        vscode.window.showErrorMessage('vscode.git extension is not active.');
        return undefined;
    }
    return gitExtension.exports.getAPI(1);
}

/**
 * リソースURIに対応するGitリポジトリを取得する
 * @param gitAPI - git APIインスタンス
 * @param resourceUri - 対象ファイルのURI
 * @returns Repositoryインスタンス。見つからない場合はundefined
 */
function getRepositoryForUri(
    gitAPI: ReturnType<GitExtension['getAPI']>,
    resourceUri: vscode.Uri
): Repository | undefined {
    const repo = gitAPI.getRepository(resourceUri);
    if (!repo) {
        vscode.window.showErrorMessage(
            `Git repository not found: ${resourceUri.fsPath}`
        );
        return undefined;
    }
    return repo;
}

/**
 * バイナリデータが含まれているかを判定する
 * nullバイト（0x00）が含まれている場合はバイナリとみなす
 *
 * @param content - 検査する文字列
 */
function isBinary(content: string): boolean {
    return content.includes('\0');
}

/**
 * ファイル内容から擬似diff文字列を生成する
 * 新規ファイルは全行に '+' を、削除ファイルは全行に '-' を付与する
 *
 * @param relativePath - ヘッダ表示用の相対パス
 * @param content - ファイル内容
 * @param prefix - 行先頭に付与する文字（'+' または '-'）
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
 * 単一ファイルのgit差分テキストを取得する
 * ファイルのgitステータスに応じて以下の処理を行う:
 * - 通常の変更: diffWithHEAD / diffIndexWithHEAD
 * - 新規ファイル (UNTRACKED / INTENT_TO_ADD): ファイル内容を読み込み全行 '+' のdiffを生成
 * - 削除ファイル (DELETED / INDEX_DELETED): HEADの内容を取得し全行 '-' のdiffを生成
 *
 * @param repo - Gitリポジトリ
 * @param resourceUri - 対象ファイルのURI
 * @returns 差分テキスト。取得できない場合はundefined
 */
async function getDiffText(
    repo: Repository,
    resourceUri: vscode.Uri
): Promise<string | undefined> {
    const filePath = resourceUri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(resourceUri);

    /*
     * workingTreeChanges と indexChanges を合わせてステータスを取得する
     * 同一ファイルが両方に存在する場合は workingTreeChanges を優先する
     */
    const allChanges = [
        ...repo.state.workingTreeChanges,
        ...repo.state.indexChanges,
    ];
    const change = allChanges.find(c => c.uri.fsPath === filePath);
    const status = change?.status;

    // 新規ファイル（未追跡 / git add -N 済み）の処理
    if (status === Status.UNTRACKED || status === Status.INTENT_TO_ADD) {
        const rawContent = await vscode.workspace.fs.readFile(resourceUri);
        const content = Buffer.from(rawContent).toString('utf8');
        if (isBinary(content)) {
            return undefined;
        }
        return buildPseudoDiff(
            relativePath,
            content,
            '+',
            '/dev/null',
            `b/${relativePath}`
        );
    }

    // 削除ファイル（未ステージ削除 / ステージ済み削除）の処理
    if (status === Status.DELETED || status === Status.INDEX_DELETED) {
        const content = await repo.show('HEAD', filePath);
        if (isBinary(content)) {
            return undefined;
        }
        return buildPseudoDiff(
            relativePath,
            content,
            '-',
            `a/${relativePath}`,
            '/dev/null'
        );
    }

    /*
     * 通常の変更ファイル
     * ワーキングツリーの差分を優先して取得する
     * 未ステージの変更がない場合はステージ済みの差分を取得する
     */
    let diffText = await repo.diffWithHEAD(filePath);
    if (!diffText || diffText.trim() === '') {
        diffText = await repo.diffIndexWithHEAD(filePath);
    }
    return diffText || undefined;
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
        .getConfiguration('code-reviewer')
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
 * SCMコンテキストメニューから呼び出されるコマンドハンドラー
 * 選択されたリソースの差分を取得してCopilot Chatに送信する
 *
 * @param resourceState - 右クリックされたリソース（単体）
 * @param resourceStates - 複数選択されたリソースの配列
 */
export async function reviewDiff(
    resourceState: vscode.SourceControlResourceState,
    resourceStates: vscode.SourceControlResourceState[]
): Promise<void> {
    /*
     * 複数選択されている場合は全選択リソースを対象とする
     * 単体選択の場合は右クリックされたリソースのみを対象とする
     */
    const targets =
        resourceStates && resourceStates.length > 0
            ? resourceStates
            : [resourceState];

    const gitAPI = getGitAPI();
    if (!gitAPI) {
        return;
    }

    const diffs: Array<{ fileName: string; diffText: string; }> = [];
    let totalSize = 0;
    let skippedCount = 0;

    for (const target of targets) {
        const filePath = target.resourceUri.fsPath;
        const fileName = vscode.workspace.asRelativePath(target.resourceUri);

        const repo = getRepositoryForUri(gitAPI, target.resourceUri);
        if (!repo) {
            continue;
        }

        let diffText: string | undefined;
        try {
            diffText = await getDiffText(repo, target.resourceUri);
        } catch (error) {
            /*
             * バイナリファイル等では差分取得が失敗する場合がある
             * その場合はスキップして次のファイルを処理する
             */
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

        /*
         * 累積サイズが上限を超えた場合はユーザーに確認を求める
         * 先頭50KBのみ送信するか、キャンセルするかを選択させる
         */
        if (totalSize + diffText.length > DIFF_SIZE_LIMIT) {
            if (diffs.length === 0) {
                /*
                 * 最初のファイルだけで上限を超える場合は先頭部分を切り捨てて送信する
                 * ユーザーに切り捨て送信かキャンセルかを確認する
                 */
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
                /*
                 * 2件目以降でサイズ上限に達した場合は残りをスキップする
                 */
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

    /*
     * Copilot Chatパネルを開いてプロンプトを入力欄にセットする
     * VS Code 1.85以降でquery引数がサポートされている
     */
    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
    });
}
