/**
 * promptTemplates.ts
 * 言語別プロンプトテンプレートと言語解決ロジック
 */
import * as vscode from 'vscode';

/** 複数コミットレビュー用のリストエントリ型 */
export interface ReviewListEntry {
    revision: string;
    author: string;
    msg: string;
}

/** Git コミット複数レビュー用のリストエントリ型 */
export interface GitReviewListEntry {
    hash: string;
    author: string;
    msg: string;
    repoRoot: string;
}

/** プロンプトテンプレートの型定義 */
export interface PromptTemplate {
    header: string;
    fileLabel: string;
    skipNotice: (count: number) => string;
    commitHeader: (revision: string, author: string, msg: string, wcRoot: string) => string;
    multiCommitHeader: (entries: ReviewListEntry[], wcRoot: string) => string;
    gitCommitHeader: (hash: string, author: string, msg: string, repoRoot: string) => string;
    multiGitCommitHeader: (entries: GitReviewListEntry[], repoRoot: string) => string;
    gitCommitFileHeader: (hash: string, author: string, msg: string, repoRoot: string, files: string[]) => string;
}

/**
 * 言語コードとプロンプト文言のテーブル
 * キーはcopilot-scm-code-reviewer.reviewLanguageの enum 値（auto を除く）
 */
export const PROMPT_TEMPLATES: Record<string, PromptTemplate> = {
    ja: {
        header: '以下の差分をコードレビューしてください。\n各ファイルについて、問題点・改善案・良い点をそれぞれ具体的に指摘してください。',
        fileLabel: 'ファイル ',
        skipNotice: (n) => `> 注意: 差分サイズが上限を超えたため、${n}件のファイルをスキップしました。`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `リビジョン r${revision} のコミット差分をコードレビューしてください。\n` +
            `以下のコマンドをターミナルで実行して差分を取得し、各ファイルについて問題点・改善案・良い点をそれぞれ具体的に指摘してください。\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `以下の複数コミットの差分をまとめてコードレビューしてください。\n\n` +
                `レビュー対象コミット:\n${commitList}\n\n` +
                `以下のコマンドをターミナルですべて実行して全差分を収集してください。\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `全差分を収集し終えたら、それらをまとめて一括レビューしてください。\n` +
                `各ファイルについて問題点・改善案・良い点をそれぞれ具体的に指摘してください。`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `コミット ${hash.slice(0, 7)} のコミット差分をコードレビューしてください。\n` +
            `以下のコマンドをターミナルで実行して差分を取得し、各ファイルについて問題点・改善案・良い点をそれぞれ具体的に指摘してください。\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `以下の複数コミットの差分をまとめてコードレビューしてください。\n\n` +
                `レビュー対象コミット:\n${commitList}\n\n` +
                `以下のコマンドをターミナルですべて実行して全差分を収集してください。\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `全差分を収集し終えたら、それらをまとめて一括レビューしてください。\n` +
                `各ファイルについて問題点・改善案・良い点をそれぞれ具体的に指摘してください。`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `コミット ${hash.slice(0, 7)} の選択ファイルの差分をコードレビューしてください。\n` +
                `以下のコマンドをターミナルで実行して差分を取得し、各ファイルについて問題点・改善案・良い点をそれぞれ具体的に指摘してください。\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    en: {
        header: 'Please review the following diff.\nFor each file, point out problems, suggestions for improvement, and good points specifically.',
        fileLabel: 'File',
        skipNotice: (n) => `> Note: ${n} file(s) were skipped because the diff size exceeded the limit.`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `Please review the diff for revision r${revision}.\n` +
            `Run the following command in the terminal to get the diff, then for each file, point out problems, suggestions for improvement, and good points specifically.\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `Please review the diffs of the following commits all together.\n\n` +
                `Target commits:\n${commitList}\n\n` +
                `Run all of the following commands in the terminal to collect all diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Once you have collected all diffs, review them together as a whole.\n` +
                `For each file, point out problems, suggestions for improvement, and good points specifically.`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `Please review the diff for commit ${hash.slice(0, 7)}.\n` +
            `Run the following command in the terminal to get the diff, then for each file, point out problems, suggestions for improvement, and good points specifically.\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `Please review the diffs of the following commits all together.\n\n` +
                `Target commits:\n${commitList}\n\n` +
                `Run all of the following commands in the terminal to collect all diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Once you have collected all diffs, review them together as a whole.\n` +
                `For each file, point out problems, suggestions for improvement, and good points specifically.`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `Please review the diff of the selected file(s) in commit ${hash.slice(0, 7)}.\n` +
                `Run the following command(s) in the terminal to get the diff, then for each file, point out problems, suggestions for improvement, and good points specifically.\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    'zh-cn': {
        header: '请对以下差异进行代码审查。\n对于每个文件，请具体指出问题、改进建议和优点。',
        fileLabel: '文件',
        skipNotice: (n) => `> 注意：由于差异大小超出限制，已跳过 ${n} 个文件。`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `请对版本 r${revision} 的提交差异进行代码审查。\n` +
            `请在终端中运行以下命令获取差异，并对每个文件具体指出问题、改进建议和优点。\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `请将以下多个提交的差异一并进行代码审查。\n\n` +
                `审查目标提交：\n${commitList}\n\n` +
                `请在终端中依次运行以下所有命令，收集全部差异。\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `收集完所有差异后，请将其作为整体一并审查。\n` +
                `对每个文件具体指出问题、改进建议和优点。`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `请对提交 ${hash.slice(0, 7)} 的差异进行代码审查。\n` +
            `请在终端中运行以下命令获取差异，并对每个文件具体指出问题、改进建议和优点。\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `请将以下多个提交的差异一并进行代码审查。\n\n` +
                `审查目标提交：\n${commitList}\n\n` +
                `请在终端中依次运行以下所有命令，收集全部差异。\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `收集完所有差异后，请将其作为整体一并审查。\n` +
                `对每个文件具体指出问题、改进建议和优点。`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `请对提交 ${hash.slice(0, 7)} 中所选文件的差异进行代码审查。\n` +
                `请在终端中运行以下命令获取差异，并对每个文件具体指出问题、改进建议和优点。\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    ko: {
        header: '다음 차이를 코드 리뷰해주세요.\n각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.',
        fileLabel: '파일',
        skipNotice: (n) => `> 주의: 차이 크기가 제한을 초과하여 ${n}개의 파일을 건너뛰었습니다.`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `리비전 r${revision} 의 커밋 차이를 코드 리뷰해주세요.\n` +
            `터미널에서 다음 명령을 실행하여 차이를 가져온 후, 각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `다음 여러 커밋의 차이를 함께 코드 리뷰해주세요.\n\n` +
                `리뷰 대상 커밋:\n${commitList}\n\n` +
                `터미널에서 아래 모든 명령을 순서대로 실행하여 전체 차이를 수집해주세요.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `모든 차이를 수집한 후 전체를 일괄 리뷰해주세요.\n` +
                `각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `커밋 ${hash.slice(0, 7)} 의 차이를 코드 리뷰해주세요.\n` +
            `터미널에서 다음 명령을 실행하여 차이를 가져온 후, 각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `다음 여러 커밋의 차이를 함께 코드 리뷰해주세요.\n\n` +
                `리뷰 대상 커밋:\n${commitList}\n\n` +
                `터미널에서 아래 모든 명령을 순서대로 실행하여 전체 차이를 수집해주세요.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `모든 차이를 수집한 후 전체를 일괄 리뷰해주세요.\n` +
                `각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `커밋 ${hash.slice(0, 7)} 의 선택한 파일의 차이를 코드 리뷰해주세요.\n` +
                `터미널에서 다음 명령을 실행하여 차이를 가져온 후, 각 파일에 대해 문제점, 개선 제안, 좋은 점을 구체적으로 지적해주세요.\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    fr: {
        header: 'Veuillez effectuer une revue de code du diff suivant.\nPour chaque fichier, indiquez précisément les problèmes, les suggestions d\'amélioration et les points positifs.',
        fileLabel: 'Fichier',
        skipNotice: (n) => `> Remarque : ${n} fichier(s) ont été ignorés car la taille du diff dépassait la limite.`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `Veuillez effectuer une revue de code du diff pour la révision r${revision}.\n` +
            `Exécutez la commande suivante dans le terminal pour obtenir le diff, puis pour chaque fichier, indiquez précisément les problèmes, les suggestions d'amélioration et les points positifs.\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `Veuillez effectuer une revue de code des diffs des commits suivants dans leur ensemble.\n\n` +
                `Commits cibles :\n${commitList}\n\n` +
                `Exécutez toutes les commandes suivantes dans le terminal pour collecter tous les diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Une fois tous les diffs collectés, effectuez une revue globale.\n` +
                `Pour chaque fichier, indiquez précisément les problèmes, les suggestions d'amélioration et les points positifs.`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `Veuillez effectuer une revue de code du diff pour le commit ${hash.slice(0, 7)}.\n` +
            `Exécutez la commande suivante dans le terminal pour obtenir le diff, puis pour chaque fichier, indiquez précisément les problèmes, les suggestions d'amélioration et les points positifs.\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `Veuillez effectuer une revue de code des diffs des commits suivants dans leur ensemble.\n\n` +
                `Commits cibles :\n${commitList}\n\n` +
                `Exécutez toutes les commandes suivantes dans le terminal pour collecter tous les diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Une fois tous les diffs collectés, effectuez une revue globale.\n` +
                `Pour chaque fichier, indiquez précisément les problèmes, les suggestions d'amélioration et les points positifs.`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `Veuillez effectuer une revue de code du diff des fichiers sélectionnés dans le commit ${hash.slice(0, 7)}.\n` +
                `Exécutez la commande suivante dans le terminal pour obtenir le diff, puis pour chaque fichier, indiquez précisément les problèmes, les suggestions d'amélioration et les points positifs.\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    de: {
        header: 'Bitte führen Sie ein Code-Review des folgenden Diffs durch.\nGeben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.',
        fileLabel: 'Datei',
        skipNotice: (n) => `> Hinweis: ${n} Datei(en) wurden übersprungen, da die Diff-Größe das Limit überschritten hat.`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `Bitte führen Sie ein Code-Review des Diffs für Revision r${revision} durch.\n` +
            `Führen Sie den folgenden Befehl im Terminal aus, um den Diff zu erhalten, und geben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `Bitte führen Sie ein Code-Review der Diffs der folgenden Commits insgesamt durch.\n\n` +
                `Ziel-Commits:\n${commitList}\n\n` +
                `Führen Sie alle folgenden Befehle im Terminal aus, um alle Diffs zu sammeln.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Nachdem Sie alle Diffs gesammelt haben, führen Sie eine Gesamtbewertung durch.\n` +
                `Geben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `Bitte führen Sie ein Code-Review des Diffs für Commit ${hash.slice(0, 7)} durch.\n` +
            `Führen Sie den folgenden Befehl im Terminal aus, um den Diff zu erhalten, und geben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `Bitte führen Sie ein Code-Review der Diffs der folgenden Commits insgesamt durch.\n\n` +
                `Ziel-Commits:\n${commitList}\n\n` +
                `Führen Sie alle folgenden Befehle im Terminal aus, um alle Diffs zu sammeln.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Nachdem Sie alle Diffs gesammelt haben, führen Sie eine Gesamtbewertung durch.\n` +
                `Geben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `Bitte führen Sie ein Code-Review des Diffs der ausgewählten Datei(en) in Commit ${hash.slice(0, 7)} durch.\n` +
                `Führen Sie den folgenden Befehl im Terminal aus, um den Diff zu erhalten, und geben Sie für jede Datei konkret Probleme, Verbesserungsvorschläge und positive Aspekte an.\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
    },
    es: {
        header: 'Por favor, realice una revisión de código del siguiente diff.\nPara cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.',
        fileLabel: 'Archivo',
        skipNotice: (n) => `> Nota: Se omitieron ${n} archivo(s) porque el tamaño del diff superó el límite.`,
        commitHeader: (revision, author, msg, wcRoot) =>
            `Por favor, realice una revisión de código del diff para la revisión r${revision}.\n` +
            `Ejecute el siguiente comando en el terminal para obtener el diff y para cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.\n` +
            `\`\`\`\nsvn diff -c ${revision} "${wcRoot}"\n\`\`\``,
        multiCommitHeader: (entries, wcRoot) => {
            const sorted = [...entries].sort((a, b) => parseInt(a.revision, 10) - parseInt(b.revision, 10));
            const commitList = sorted.map(e => `  r${e.revision}: ${e.author} - ${e.msg}`).join('\n');
            const commands = sorted.map(e => `svn diff -c ${e.revision} "${wcRoot}"`).join('\n');
            return `Por favor, realice una revisión de código de los diffs de los siguientes commits en conjunto.\n\n` +
                `Commits objetivo:\n${commitList}\n\n` +
                `Ejecute todos los siguientes comandos en el terminal para recopilar todos los diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Una vez recopilados todos los diffs, realice una revisión global.\n` +
                `Para cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.`;
        },
        gitCommitHeader: (hash, author, msg, repoRoot) =>
            `Por favor, realice una revisión de código del diff para el commit ${hash.slice(0, 7)}.\n` +
            `Ejecute el siguiente comando en el terminal para obtener el diff y para cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.\n` +
            `\`\`\`\ngit -C "${repoRoot}" show ${hash}\n\`\`\``,
        multiGitCommitHeader: (entries, repoRoot) => {
            const commitList = entries.map(e => `  ${e.hash.slice(0, 7)}: ${e.author} - ${e.msg}`).join('\n');
            const commands = entries.map(e => `git -C "${repoRoot}" show ${e.hash}`).join('\n');
            return `Por favor, realice una revisión de código de los diffs de los siguientes commits en conjunto.\n\n` +
                `Commits objetivo:\n${commitList}\n\n` +
                `Ejecute todos los siguientes comandos en el terminal para recopilar todos los diffs.\n` +
                `\`\`\`\n${commands}\n\`\`\`\n\n` +
                `Una vez recopilados todos los diffs, realice una revisión global.\n` +
                `Para cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.`;
        },
        gitCommitFileHeader: (hash, author, msg, repoRoot, files) => {
            const commands = files.map(f => `git -C "${repoRoot}" show ${hash} -- "${f}"`).join('\n');
            return `Por favor, realice una revisión de código del diff de los archivos seleccionados en el commit ${hash.slice(0, 7)}.\n` +
                `Ejecute el siguiente comando en el terminal para obtener el diff y para cada archivo, indique concretamente los problemas, sugerencias de mejora y puntos positivos.\n` +
                `\`\`\`\n${commands}\n\`\`\``;
        },
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
