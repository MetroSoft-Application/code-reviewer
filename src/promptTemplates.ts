/**
 * promptTemplates.ts
 * 言語別プロンプトテンプレートと言語解決ロジック
 */
import * as vscode from 'vscode';

/** プロンプトテンプレートの型定義 */
export interface PromptTemplate {
    header: string;
    fileLabel: string;
    skipNotice: (count: number) => string;
}

/**
 * 言語コードとプロンプト文言のテーブル
 * キーはcopilot-scm-code-reviewer.reviewLanguageの enum 値（auto を除く）
 */
export const PROMPT_TEMPLATES: Record<string, PromptTemplate> = {
    ja: {
        header: '以下の差分をコードレビューしてください。\n各ファイルについて、問題点・改善案・良い点をそれぞれ具体的に指摘してください。',
        fileLabel: 'ファイル',
        skipNotice: (n) => `> 注意: 差分サイズが上限を超えたため、${n}件のファイルをスキップしました。`,
    },
    en: {
        header: 'Please review the following diff.\nFor each file, point out problems, suggestions for improvement, and good points specifically.',
        fileLabel: 'File',
        skipNotice: (n) => `> Note: ${n} file(s) were skipped because the diff size exceeded the limit.`,
    },
    'zh-cn': {
        header: '请对以下差异进行代码审查。\n对于每个文件，请具体指出问题、改进建议和优点。',
        fileLabel: '文件',
        skipNotice: (n) => `> 注意：由于差异大小超出限制，已跳过 ${n} 个文件。`,
    },
    ko: {
        header: '다음 차이를 코드 리뷰해주세요.\n각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.',
        fileLabel: '파일',
        skipNotice: (n) => `> 주의: 차이 크기가 제한을 초과하여 ${n}개의 파일을 건너뛰었습니다.`,
    },
    fr: {
        header: 'Veuillez effectuer une revue de code du diff suivant.\nPour chaque fichier, indiquez précisément les problèmes, les suggestions d\'amélioration et les points positifs.',
        fileLabel: 'Fichier',
        skipNotice: (n) => `> Remarque : ${n} fichier(s) ont été ignorés car la taille du diff dépassait la limite.`,
    },
    de: {
        header: 'Bitte führen Sie ein Code-Review des folgenden Diffs durch.\nGeben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.',
        fileLabel: 'Datei',
        skipNotice: (n) => `> Hinweis: ${n} Datei(en) wurden übersprungen, da die Diff-Größe das Limit überschritten hat.`,
    },
    es: {
        header: 'Por favor, realice una revisión de código del siguiente diff.\nPara cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.',
        fileLabel: 'Archivo',
        skipNotice: (n) => `> Nota: Se omitieron ${n} archivo(s) porque el tamaño del diff superó el límite.`,
    },
};

/** デフォルトは英語 */
export const DEFAULT_LANG = 'en';

/**
 * 設定とVS CodeのUI言語からプロンプト用の言語コードを解決する
 * - 設定が "auto" の場合は vscode.env.language から判定
 * - 未対応言語は英語にフォールバックする
 *
 * @returns PROMPT_TEMPLATES のキー（一致するcopilot-scm-code-reviewer.reviewLanguageのenum値）
 */
export function resolveLanguage(): string {
    const configured = vscode.workspace
        .getConfiguration('copilot-scm-code-reviewer')
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
