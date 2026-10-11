import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Disposable workspace/profile: integration tests never edit message_app.
const workspaceFolder = resolve('.vscode-test/analysis-save-fixture');
mkdirSync(workspaceFolder, { recursive: true });
const profile = mkdtempSync(resolve('.vscode-test/cache-test-profile-'));
mkdirSync(join(profile, 'User'));
writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({
    'files.autoSave': 'off',
    // Tests invoke providers explicitly so automatic requests do not skew races.
    'editor.codeLens': false,
    'workbench.startupEditor': 'none',
    'extensions.autoUpdate': false,
}));

export default defineConfig({
	files: 'out/test/**/*.test.js',
    workspaceFolder,
    launchArgs: ['--disable-extensions', `--user-data-dir=${profile}`],
    mocha: { timeout: 20000 },
});
