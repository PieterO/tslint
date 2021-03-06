/**
 * @license
 * Copyright 2013 Palantir Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// tslint:disable strict-boolean-expressions (TODO: Fix up options)

import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import * as ts from "typescript";

import {
    CONFIG_FILENAME,
    DEFAULT_CONFIG,
    findConfiguration,
    IConfigurationFile,
} from "./configuration";
import { FatalError } from "./error";
import { LintResult } from "./index";
import * as Linter from "./linter";
import { consoleTestResultsHandler, runTests } from "./test";
import { arrayify, flatMap } from "./utils";

export interface Options {
    /**
     * Path to a configuration file.
     */
    config?: string;

    /**
     * Exclude globs from path expansion.
     */
    exclude?: string | string[];

    /**
     * File paths to lint.
     */
    files?: string[];

    /**
     * Whether to return status code 0 even if there are lint errors.
     */
    force?: boolean;

    /**
     * Whether to fixes linting errors for select rules. This may overwrite linted files.
     */
    fix?: boolean;

    /**
     * Output format.
     */
    format?: string;

    /**
     * Formatters directory path.
     */
    formattersDirectory?: string;

    /**
     * Whether to generate a tslint.json config file in the current working directory.
     */
    init?: boolean;

    /**
     * Output file path.
     */
    out?: string;

    /**
     * Whether to output absolute paths
     */
    outputAbsolutePaths?: boolean;

    /**
     * tsconfig.json file.
     */
    project?: string;

    /**
     * Rules directory paths.
     */
    rulesDirectory?: string | string[];

    /**
     * That TSLint produces the correct output for the specified directory.
     */
    test?: string;

    /**
     * Whether to enable type checking when linting a project.
     */
    typeCheck?: boolean;
}

export const enum Status {
    Ok = 0,
    FatalError = 1,
    LintError = 2,
}

export interface Logger {
    log(message: string): void;
    error(message: string): void;
}

export async function run(options: Options, logger: Logger): Promise<Status> {
    try {
        return await runWorker(options, logger);
    } catch (error) {
        if ((error as FatalError).name === FatalError.NAME) {
            logger.error((error as FatalError).message);
            return Status.FatalError;
        }
        throw error;
    }
}

async function runWorker(options: Options, logger: Logger): Promise<Status> {
    if (options.init) {
        if (fs.existsSync(CONFIG_FILENAME)) {
            throw new FatalError(`Cannot generate ${CONFIG_FILENAME}: file already exists`);
        }

        fs.writeFileSync(CONFIG_FILENAME, JSON.stringify(DEFAULT_CONFIG, undefined, "    "));
        return Status.Ok;
    }

    if (options.test) {
        const results = runTests((options.files || []).map(trimSingleQuotes), options.rulesDirectory);
        return consoleTestResultsHandler(results) ? Status.Ok : Status.FatalError;
    }

    if (options.config && !fs.existsSync(options.config)) {
        throw new FatalError(`Invalid option for configuration: ${options.config}`);
    }

    const { output, errorCount } = await runLinter(options, logger);
    logger.log(output);
    return options.force || errorCount === 0 ? Status.Ok : Status.LintError;
}

async function runLinter(options: Options, logger: Logger): Promise<LintResult> {
    const { files, program } = resolveFilesAndProgram(options);
    // if type checking, run the type checker
    if (program && options.typeCheck) {
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.length !== 0) {
            const message = diagnostics.map((d) => showDiagnostic(d, program, options.outputAbsolutePaths === true)).join("\n");
            if (options.force) {
                logger.error(message);
            } else {
                throw new FatalError(message);
            }
        }
    }
    return doLinting(options, files, program, logger);
}

function resolveFilesAndProgram({ files, project, exclude, outputAbsolutePaths }: Options): { files: string[]; program?: ts.Program } {
    // if both files and tsconfig are present, use files
    if (project === undefined) {
        return { files: resolveFiles() };
    }

    const projectPath = findTsconfig(project);
    if (projectPath === undefined) {
        throw new FatalError(`Invalid option for project: ${project}`);
    }

    const program = Linter.createProgram(projectPath);
    return { files: files === undefined || files.length === 0 ? Linter.getFileNames(program) : resolveFiles(), program };

    function resolveFiles(): string[] {
        return resolveGlobs(files, exclude, outputAbsolutePaths === true);
    }
}

function resolveGlobs(files: string[] | undefined, exclude: Options["exclude"], outputAbsolutePaths: boolean): string[] {
    const ignore = arrayify(exclude).map(trimSingleQuotes);
    return flatMap(arrayify(files), (file) =>
        // remove single quotes which break matching on Windows when glob is passed in single quotes
        glob.sync(trimSingleQuotes(file), { ignore, nodir: true }))
        .map((file) => outputAbsolutePaths ? path.resolve(file) : path.relative(process.cwd(), file));
}

async function doLinting(
        options: Options, files: string[], program: ts.Program | undefined, logger: Logger): Promise<LintResult> {
    const possibleConfigAbsolutePath = options.config !== undefined ? path.resolve(options.config) : null;
    const linter = new Linter({
        fix: !!options.fix,
        formatter: options.format,
        formattersDirectory: options.formattersDirectory,
        rulesDirectory: options.rulesDirectory,
    }, program);

    let lastFolder: string | undefined;
    let configFile: IConfigurationFile | undefined;
    for (const file of files) {
        if (!fs.existsSync(file)) {
            throw new FatalError(`Unable to open file: ${file}`);
        }

        const contents = await tryReadFile(file, logger);
        if (contents !== undefined) {
            const folder = path.dirname(file);
            if (lastFolder !== folder) {
                configFile = findConfiguration(possibleConfigAbsolutePath, folder).results;
                lastFolder = folder;
            }
            linter.lint(file, contents, configFile);
        }
    }

    return linter.getResult();
}

/** Read a file, but return undefined if it is an MPEG '.ts' file. */
async function tryReadFile(filename: string, logger: Logger): Promise<string | undefined> {
    const buffer = new Buffer(256);
    const fd = fs.openSync(filename, "r");
    try {
        fs.readSync(fd, buffer, 0, 256, 0);
        if (buffer.readInt8(0, true) === 0x47 && buffer.readInt8(188, true) === 0x47) {
            // MPEG transport streams use the '.ts' file extension. They use 0x47 as the frame
            // separator, repeating every 188 bytes. It is unlikely to find that pattern in
            // TypeScript source, so tslint ignores files with the specific pattern.
            logger.error(`${filename}: ignoring MPEG transport stream`);
            return undefined;
        }
    } finally {
        fs.closeSync(fd);
    }

    return fs.readFileSync(filename, "utf8");
}

function showDiagnostic({ file, start, category, messageText }: ts.Diagnostic, program: ts.Program, outputAbsolutePaths: boolean): string {
    let message = ts.DiagnosticCategory[category];
    if (file) {
        const {line, character} = file.getLineAndCharacterOfPosition(start!);
        const currentDirectory = program.getCurrentDirectory();
        const filePath = outputAbsolutePaths
            ? path.resolve(currentDirectory, file.fileName)
            : path.relative(currentDirectory, file.fileName);
        message += ` at ${filePath}:${line + 1}:${character + 1}:`;
    }
    return `${message} ${ts.flattenDiagnosticMessageText(messageText, "\n")}`;
}

function trimSingleQuotes(str: string): string {
    return str.replace(/^'|'$/g, "");
}

function findTsconfig(project: string): string | undefined {
    try {
        const stats = fs.statSync(project); // throws if file does not exist
        if (!stats.isDirectory()) {
            return project;
        }
        const projectFile = path.join(project, "tsconfig.json");
        fs.accessSync(projectFile); // throws if file does not exist
        return projectFile;
    } catch (e) {
        return undefined;
    }
}
