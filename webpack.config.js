/**
 * webpack設定ファイル
 * VS Code拡張機能向けにNode.jsターゲットでバンドルする
 */
'use strict';

const path = require('path');

/**
 * @type {import('webpack').Configuration}
 */
module.exports = {
    /*
     * vs code拡張機能のエントリポイント
     */
    entry: './src/extension.ts',

    /*
     * 出力先設定
     * CommonJS形式でdist/extension.jsに出力する
     */
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },

    /*
     * Node.jsランタイム向けターゲット
     * ブラウザ向けのポリフィルを除外する
     */
    target: 'node',

    /*
     * vscode APIはバンドルに含めず実行時に解決する
     * vscode.git拡張機能のAPIも同様に除外する
     */
    externals: {
        vscode: 'commonjs vscode',
    },

    resolve: {
        extensions: ['.ts', '.js'],
    },

    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                    },
                ],
            },
        ],
    },

    devtool: 'source-map',
};
