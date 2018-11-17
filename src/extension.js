const vscode = require('vscode');
const window = vscode.window;
const workspace = vscode.workspace;

const exec = require('child_process').exec;
const path = require('path');
const opn = require('opn');
const R = require('ramda');

function baseCommand(commandName) {
    const activeTextEditor = window.activeTextEditor;

    if (!activeTextEditor) {
        window.showErrorMessage('No opened files.');
        return;
    }

    const filePath = window.activeTextEditor.document.fileName;
    const fileUri = window.activeTextEditor.document.uri;
    const lineStart = window.activeTextEditor.selection.start.line + 1;
    const lineEnd = window.activeTextEditor.selection.end.line + 1;
    const selectedLines = { start: lineStart, end: lineEnd };
    const defaultBranch = workspace.getConfiguration('openInGitHub', fileUri).get('defaultBranch') || 'develop';
    const defaultRemote = workspace.getConfiguration('openInGitHub', fileUri).get('defaultRemote') || 'origin';
    const maxBuffer = workspace.getConfiguration('openInGithub', fileUri).get('maxBuffer') || undefined;
    const excludeCurrentRevision = workspace.getConfiguration('openInGitHub').get('excludeCurrentRevision') || true;
    const projectPath = path.dirname(filePath);
    
    if (commandName === 'project') {
        getAllRemotes(exec, projectPath).then(formatRemotes).then(remotes => {
            if (remotes) {
                opn(remotes[0]);
                return;
            }
        });
    }

    return getRepoRoot(exec, projectPath).then(repoRootPath => {
        const relativeFilePath = path.relative(repoRootPath, filePath);
        
        return getBranches(exec, projectPath, defaultBranch, maxBuffer, excludeCurrentRevision)
            .then(branches => {
                const getRemotesPromise = getRemotes(exec, projectPath, defaultRemote, defaultBranch, branches).then(formatRemotes);
                return Promise.all([getRemotesPromise, branches]);
            })
            .then(result => prepareQuickPickItems(commandName, relativeFilePath, selectedLines, result))
            .then(result => showQuickPickWindow(result, defaultBranch))
            .catch(err => window.showErrorMessage(err));
    });
}

function getBranches(exec, projectPath, defaultBranch, maxBuffer, excludeCurrentRevision) {
    return new Promise((resolve, reject) => {
        const options = { cwd: projectPath };
        if (maxBuffer) options.maxBuffer = maxBuffer;
  
        exec('git branch --no-color -a', options, (error, stdout, stderr) => {
            if (stderr || error) return reject(stderr || error);
  
            const getCurrentBranch = R.compose(
                R.trim,
                R.replace('*', ''),
                R.find(line => line.startsWith('*')),
                R.split('\n')
            );
  
            const processBranches = R.compose(
                R.filter(br => stdout.match(new RegExp(`remotes\/.*\/${br}`))),
                R.uniq
            );
  
            const currentBranch = getCurrentBranch(stdout);
            const branches = processBranches([currentBranch, defaultBranch]);
  
            return excludeCurrentRevision
                ? resolve(branches)
                : getCurrentRevision(exec, projectPath).then(currentRevision => resolve(branches.concat(currentRevision)));
      });
    });
}

/**
 * Returns the commit sha for HEAD.
 */
function getCurrentRevision(exec, projectPath) {
    return new Promise((resolve, reject) => {
        exec('git rev-parse HEAD', { cwd: projectPath }, (error, stdout, stderr) => {
            if (stderr || error) return reject(stderr || error);
            resolve(stdout.trim());
        });
    });
}

/**
 * Returns raw list of remotes.
 */
function getRemotes(exec, projectPath, defaultRemote, defaultBranch, branches) {
    /**
     * If there is only default branch that was pushed to remote then return only default remote.
     */
    if (branches.length === 1 && branches[0] === defaultBranch) {
        return getRemoteByName(exec, projectPath, defaultRemote);
    }
  
    return getAllRemotes(exec, projectPath);
}

/**
 * Returns raw list of all remotes.
 */
function getAllRemotes(exec, projectPath) {
    const process = R.compose(
        R.uniq,
        R.map(R.head),
        R.map(R.split(' ')),
        R.reject(R.isEmpty),
        R.map(R.last),
        R.map(R.split(/\t/)),
        R.split('\n')
    );
  
    return new Promise((resolve, reject) => {
        exec('git remote -v', { cwd: projectPath }, (error, stdout, stderr) => {
            if (stderr || error) return reject(stderr || error);
            resolve(process(stdout));
        });
    });
}

/**
 * Returns raw remote by given name e.g. – origin
 */
function getRemoteByName(exec, projectPath, remoteName) {
    return new Promise((resolve, reject) => {
        exec(`git config --get remote.${remoteName}.url`, { cwd: projectPath }, (error, stdout, stderr) => {
            if (stderr || error) return reject(stderr || error);
            resolve([stdout]);
        });
    });
}

/**
 * Returns formatted list of remotes.
 */
function formatRemotes(remotes) {
    const process = R.compose(
      R.uniq,
      R.map(R.replace(/\/$/, '')),
      R.reject(R.isEmpty),
      R.map(R.replace(/\n/, '')),
      R.map(R.trim),
      R.map(rem => rem.replace(/\/\/(.+)@github/, '//github')),
      R.map(rem =>
        rem.match(/github\.com/)
          ? rem.replace(/\.git(\b|$)/, '')
          : rem),
      R.reject(R.isNil),
      R.map(rem => {
        if (rem.match(/^https?:/)) {
          return rem.replace(/\.git(\b|$)/, '');
        } else if (rem.match(/@/)) {
          return 'https://' +
            rem
              .replace(/^.+@/, '')
              .replace(/\.git(\b|$)/, '')
              .replace(/:/g, '/');
        } else if (rem.match(/^ftps?:/)) {
          return rem.replace(/^ftp/, 'http');
        } else if (rem.match(/^ssh:/)) {
          return rem.replace(/^ssh/, 'https');
        } else if (rem.match(/^git:/)) {
          return rem.replace(/^git/, 'https');
        }
      })
    );
    return process(remotes);
}

function prepareQuickPickItems(commandName, relativeFilePath, lines, [remotes, branches]) {
    if (!branches.length) {
        return [];
    }

    let quickPickItems = [];
  
    if (branches.length === 1) {
        quickPickItems = formatQuickPickItems(commandName, relativeFilePath, lines, remotes, branches[0]);
    } else {
        const processBranches = R.compose(
            R.flatten,
            // Join: [1,2,3], [4,5,6], [7,8,9] -> [1,4,7], [2,5,8], [3,6,9]
            (results) => R.map((i) => R.map((item) => item[i], results), R.range(0, results[0].length)),
            R.map(branch => formatQuickPickItems(commandName, relativeFilePath, lines, remotes, branch))
        );
        quickPickItems = processBranches(branches);
    }

    remotes.map(remote => {
        quickPickItems.push({
            label: `Select branch from ${remote}`,
            getUrl: getGitHubUrl(commandName, remote, relativeFilePath, lines),
        });
    });

    return {quickPickItems, remotes, branches, commandName};
}

function formatQuickPickItems(commandName, relativeFilePath, lines, remotes, branch) {
    return remotes
        .map(remote => ({ 
            remote, 
            url: getGitHubUrl(commandName, remote, relativeFilePath, lines)(branch),
        }))
        .map(remote => ({
            label: relativeFilePath,
            detail: `${branch} | ${remote.remote}`,
            description: `[${commandName}]`,
            url: remote.url
        }));
}

function getGitHubUrl(commandName, remote, relativeFilePath, lines) {
    switch (commandName) {
        case 'file':
            return (branch) => `${remote}/blob/${branch}/${relativeFilePath}${formatGitHubLinePointer(lines)}`;
        case 'blame':
            return (branch) => `${remote}/blame/${branch}/${relativeFilePath}${formatGitHubLinePointer(lines)}`;
        case 'history':
            return (branch) => `${remote}/commits/${branch}/${relativeFilePath}`;
        default:
            return () => {};
    }

    return;
}

function formatGitHubLinePointer(lines) {
    if (!lines || !lines.start) {
        return '';
    }
  
    let linePointer = `#L${lines.start}`;
    if (lines.end && lines.end != lines.start) linePointer += `:L${lines.end}`;
  
    return linePointer;
}

function showQuickPickWindow({quickPickItems, commandName, branches, remotes}, defaultBranch) {
    if (commandName === 'compare') {
        window.showInputBox({ 
            prompt: 'Enter source branch',
            value: branches[0]
        }).then(sourceBranch => {
            if (!sourceBranch) return;
            window.showInputBox({ 
                prompt: 'Enter target branch',
                value: defaultBranch
            }).then(targetBranch => opn(`${remotes[0]}/compare/${targetBranch}...${sourceBranch}`));
        })
    } else {
        window
            .showQuickPick(quickPickItems)
            .then(item => {
                if (!item) return;

                if (!item.url) {
                    window.showInputBox({ prompt: 'Branch name' }).then(branch => opn(item.getUrl(branch)));
                } else {
                    opn((item).url);
                }
            });
    }
}

function getRepoRoot(exec, workspacePath) {
    return new Promise((resolve, reject) => {
        exec('git rev-parse --show-toplevel', { cwd: workspacePath }, (error, stdout, stderr) => {
            if (stderr || error) return reject(stderr || error);
            resolve(stdout.trim());
        });
    });
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openInGitHubFile', () => baseCommand('file')),
        vscode.commands.registerCommand('extension.openInGitHubBlame', () => baseCommand('blame')),
        vscode.commands.registerCommand('extension.openInGitHubHistory', () => baseCommand('history')),
        vscode.commands.registerCommand('extension.openInGitHubProject', () => baseCommand('project')),
        vscode.commands.registerCommand('extension.openInGitHubCompare', () => baseCommand('compare'))
    );
}
exports.activate = activate;

function deactivate() {
}
exports.deactivate = deactivate;