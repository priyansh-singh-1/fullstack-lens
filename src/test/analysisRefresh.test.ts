import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisService } from '../core/analysis/AnalysisService';
import { AnalysisResult } from '../core/analysis/AnalysisResult';
import { FullStackCodeLensProvider } from '../core/codelens/FullStackCodeLensProvider';
import { isRelevantAnalysisFile, registerAnalysisSaveRefresh } from '../core/analysis/registerAnalysisSaveRefresh';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
function snapshot(revision: number): AnalysisResult {
    return {
        revision, files: [], restEndpoints: [], restCalls: [], restMatches: [], restUsages: new Map(),
        websocketEndpoints: [], websocketCalls: [], websocketMatches: [], websocketUsages: new Map(),
        diagnostics: [],
    };
}
// Gate scan completion without changing scanners or exposing test-only service APIs.
function stubScan(service: AnalysisService, scan: (revision: number) => Promise<AnalysisResult>) {
    (service as unknown as { analyzeWorkspace: typeof scan }).analyzeWorkspace = scan;
}

suite('Analysis cache concurrency', () => {
    test('warm requests reuse a snapshot; forced scan replaces it', async () => {
        const service = new AnalysisService();
        let scans = 0;
        stubScan(service, async revision => { scans++; return snapshot(revision); });
        const first = await service.getAnalysis();
        assert.strictEqual(await service.getAnalysis(), first);
        const fresh = await service.getAnalysis(true);
        assert.notStrictEqual(fresh, first);
        assert.ok(fresh.revision > first.revision);
        assert.strictEqual(await service.getAnalysis(), fresh);
        assert.strictEqual(scans, 2);
    });

    test('concurrent cold requests share one scan', async () => {
        const service = new AnalysisService(), gate = deferred<AnalysisResult>();
        let scans = 0;
        stubScan(service, async () => { scans++; return gate.promise; });
        const requests = Array.from({ length: 5 }, () => service.getAnalysis());
        gate.resolve(snapshot(0));
        const results = await Promise.all(requests);
        assert.ok(results.every(result => result === results[0]));
        assert.strictEqual(scans, 1);
    });

    test('rapid invalidations discard an in-flight snapshot and serialize one retry', async () => {
        const service = new AnalysisService(), gate = deferred<AnalysisResult>();
        let scans = 0, active = 0, maxActive = 0;
        stubScan(service, async revision => {
            scans++; active++; maxActive = Math.max(maxActive, active);
            const result = scans === 1 ? await gate.promise : snapshot(revision);
            active--; return result;
        });
        const first = service.getAnalysis();
        service.clearCache(); service.clearCache(); service.clearCache();
        const second = service.getAnalysis();
        gate.resolve(snapshot(0));
        const [a, b] = await Promise.all([first, second]);
        assert.strictEqual(a, b);
        assert.strictEqual(a.revision, 3);
        assert.strictEqual(await service.getAnalysis(), a);
        assert.strictEqual(scans, 2);
        assert.strictEqual(maxActive, 1);
    });

    test('forced refresh during a scan waits for a fresh serialized result', async () => {
        const service = new AnalysisService(), gate = deferred<AnalysisResult>();
        let scans = 0;
        stubScan(service, async revision => ++scans === 1 ? gate.promise : snapshot(revision));
        const first = service.getAnalysis();
        const forced = service.getAnalysis(true);
        gate.resolve(snapshot(0));
        const [a, b] = await Promise.all([first, forced]);
        assert.strictEqual(a, b);
        assert.strictEqual(a.revision, 1);
        assert.strictEqual(scans, 2);
    });

    test('failed scan releases pending work so the next request can retry', async () => {
        const service = new AnalysisService();
        let scans = 0;
        stubScan(service, async revision => {
            if (++scans === 1) { throw new Error('scan failed'); }
            return snapshot(revision);
        });
        await assert.rejects(service.getAnalysis(), /scan failed/);
        assert.strictEqual((await service.getAnalysis()).revision, 0);
        assert.strictEqual(scans, 2);
    });

    test('an obsolete failing scan retries rather than failing requests for saved changes', async () => {
        const service = new AnalysisService(), gate = deferred<AnalysisResult>();
        let scans = 0;
        stubScan(service, async revision => ++scans === 1 ? gate.promise : snapshot(revision));
        const first = service.getAnalysis();
        service.clearCache();
        const second = service.getAnalysis();
        gate.reject(new Error('obsolete file disappeared'));
        const [a, b] = await Promise.all([first, second]);
        assert.strictEqual(a, b);
        assert.strictEqual(a.revision, 1);
        assert.strictEqual(scans, 2);
    });

    test('another save during the follow-up scan still returns only the latest generation', async () => {
        const service = new AnalysisService();
        const firstGate = deferred<AnalysisResult>(), secondGate = deferred<AnalysisResult>();
        const secondStarted = deferred<void>();
        let scans = 0, active = 0, maxActive = 0;
        stubScan(service, async revision => {
            scans++; active++; maxActive = Math.max(maxActive, active);
            if (scans === 2) { secondStarted.resolve(); }
            const result = scans === 1 ? await firstGate.promise :
                scans === 2 ? await secondGate.promise : snapshot(revision);
            active--; return result;
        });
        const first = service.getAnalysis();
        service.clearCache();
        firstGate.resolve(snapshot(0));
        await secondStarted.promise;
        service.clearCache();
        const second = service.getAnalysis();
        secondGate.resolve(snapshot(1));
        const [a, b] = await Promise.all([first, second]);
        assert.strictEqual(a, b);
        assert.strictEqual(a.revision, 2);
        assert.strictEqual(scans, 3);
        assert.strictEqual(maxActive, 1);
    });
});

const createdFiles: string[] = [];
let fixtureRoot: string;
let sequence = 0;
async function document(name: string, content = '// initial\n'): Promise<vscode.TextDocument> {
    const file = path.join(fixtureRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    createdFiles.push(file);
    return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}
async function save(document: vscode.TextDocument, content = document.getText() + '// saved\n') {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await document.save());
}

suite('Saved-file invalidation and CodeLens events', () => {
    const disposables: vscode.Disposable[] = [];
    setup(() => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Run with the configured disposable test workspace');
        fixtureRoot = folder.uri.fsPath;
    });
    teardown(() => { while (disposables.length) { disposables.pop()!.dispose(); } });

    test('all five relevant extensions invalidate immediately and refresh after debounce', async () => {
        for (const extension of ['java', 'js', 'jsx', 'ts', 'tsx']) {
            const service = new AnalysisService();
            stubScan(service, async revision => snapshot(revision));
            const provider = new FullStackCodeLensProvider(service);
            disposables.push(provider, registerAnalysisSaveRefresh(service, provider, 100));
            const refreshed = deferred<void>();
            disposables.push(provider.onDidChangeCodeLenses(() => refreshed.resolve()));
            const old = await service.getAnalysis();
            const doc = await document(`save-${sequence++}.${extension}`);
            await save(doc);
            assert.ok(!service.isCurrentRevision(old.revision), extension);
            const fresh = await service.getAnalysis();
            assert.notStrictEqual(fresh, old);
            await refreshed.promise;
            while (disposables.length) { disposables.pop()!.dispose(); }
        }
    });

    test('irrelevant files, excluded folders, non-file URIs and outside-workspace files are ignored', async () => {
        const service = new AnalysisService();
        stubScan(service, async revision => snapshot(revision));
        const provider = new FullStackCodeLensProvider(service);
        let events = 0;
        disposables.push(provider, registerAnalysisSaveRefresh(service, provider, 80),
            provider.onDidChangeCodeLenses(() => events++));
        const old = await service.getAnalysis();
        for (const name of ['notes.txt', 'config.json', 'node_modules/ignored.ts', 'dist/ignored.js',
            'build/ignored.jsx', 'target/ignored.java', 'nested/node_modules/ignored.tsx']) {
            await save(await document(name));
        }
        assert.ok(!isRelevantAnalysisFile(vscode.Uri.parse('untitled:unsaved.ts')));
        assert.ok(!isRelevantAnalysisFile(vscode.Uri.file(path.join(path.dirname(fixtureRoot), 'outside.ts'))));
        await delay(160);
        assert.strictEqual(await service.getAnalysis(), old);
        assert.strictEqual(events, 0);
    });

    test('three rapid saves trigger one refresh and one demanded replacement scan', async () => {
        const service = new AnalysisService();
        let scans = 0, events = 0;
        stubScan(service, async revision => { scans++; return snapshot(revision); });
        const provider = new FullStackCodeLensProvider(service), refreshed = deferred<void>();
        disposables.push(provider, registerAnalysisSaveRefresh(service, provider),
            provider.onDidChangeCodeLenses(() => { events++; refreshed.resolve(); }));
        const old = await service.getAnalysis();
        const docs = await Promise.all(['js', 'ts', 'java'].map(ext => document(`burst-${sequence++}.${ext}`)));
        await Promise.all(docs.map(doc => save(doc)));
        assert.strictEqual(scans, 1, 'Saves themselves never scan');
        await refreshed.promise;
        const fresh = await service.getAnalysis();
        await delay(450);
        assert.notStrictEqual(fresh, old);
        assert.strictEqual(events, 1);
        assert.strictEqual(scans, 2);
    });

    test('a real save during in-flight analysis cannot publish the old snapshot', async () => {
        const doc = await document(`in-flight-${sequence++}.js`);
        const service = new AnalysisService(), gate = deferred<AnalysisResult>();
        let scans = 0;
        stubScan(service, async revision => ++scans === 1 ? gate.promise : snapshot(revision));
        const provider = new FullStackCodeLensProvider(service);
        disposables.push(provider, registerAnalysisSaveRefresh(service, provider));
        const oldRequest = service.getAnalysis();
        await save(doc);
        const newRequest = service.getAnalysis();
        gate.resolve(snapshot(0));
        const [a, b] = await Promise.all([oldRequest, newRequest]);
        assert.strictEqual(a, b);
        assert.ok(a.revision > 0);
        assert.strictEqual(scans, 2);
    });

    test('disposal cancels pending refreshes and stops save invalidation', async () => {
        const doc = await document(`dispose-${sequence++}.ts`);
        const service = new AnalysisService();
        stubScan(service, async revision => snapshot(revision));
        const provider = new FullStackCodeLensProvider(service);
        let events = 0;
        disposables.push(provider, provider.onDidChangeCodeLenses(() => events++));
        const registration = registerAnalysisSaveRefresh(service, provider, 100);
        disposables.push(registration);
        await save(doc);
        registration.dispose();
        const old = await service.getAnalysis();
        await save(doc);
        await delay(180);
        assert.strictEqual(events, 0);
        assert.strictEqual(await service.getAnalysis(), old);
    });

    test('refresh fires the event without starting analysis', () => {
        const service = new AnalysisService();
        let scans = 0, events = 0;
        stubScan(service, async revision => { scans++; return snapshot(revision); });
        const provider = new FullStackCodeLensProvider(service);
        disposables.push(provider, provider.onDidChangeCodeLenses(() => events++));
        provider.refresh();
        assert.strictEqual(events, 1);
        assert.strictEqual(scans, 0);
    });

    test('unsaved keystrokes do not invalidate analysis or emit a refresh', async () => {
        const doc = await document(`unsaved-${sequence++}.ts`);
        const service = new AnalysisService();
        stubScan(service, async revision => snapshot(revision));
        const provider = new FullStackCodeLensProvider(service);
        let events = 0;
        disposables.push(provider, registerAnalysisSaveRefresh(service, provider, 80),
            provider.onDidChangeCodeLenses(() => events++));
        const old = await service.getAnalysis();
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), '// unsaved edit\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        try {
            assert.ok(doc.isDirty);
            await delay(160);
            assert.strictEqual(await service.getAnalysis(), old);
            assert.strictEqual(events, 0);
        } finally { await doc.save(); }
    });
});

suite('Navigation and saved endpoint changes', () => {
    let api: { analysisService: AnalysisService; codeLensProvider: FullStackCodeLensProvider };
    let frontend: vscode.TextDocument, backend: vscode.TextDocument;
    const java = '@RestController\n@RequestMapping("/api")\nclass Controller {\n' +
        '@GetMapping("/users/{id}")\nvoid user() {}\n' +
        '@MessageMapping("/chat.send")\nvoid chat() {}\n}\n' +
        'class Config { void config() { registry.setApplicationDestinationPrefixes("/app"); } }\n';
    const js = 'const id = 1;\naxios.get(`/api/users/${id}`);\n' +
        'axios.get("/api/missing");\nclient.publish({destination:"/app/chat.send"});\n';
    suiteSetup(async () => {
        fixtureRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const extension = vscode.extensions.all.find(ext => ext.packageJSON.name === 'fullstack-lens');
        assert.ok(extension);
        api = await extension.activate();
        assert.ok(api.analysisService && api.codeLensProvider);
        frontend = await document('Navigation.jsx', js);
        backend = await document('Controller.java', java);
    });
    setup(async () => {
        if (frontend.getText() !== js) { await save(frontend, js); }
        if (backend.getText() !== java) { await save(backend, java); }
        await api.analysisService.getAnalysis(true);
    });
    async function lens(doc: vscode.TextDocument, type: string, pathText: string) {
        const lenses = await api.codeLensProvider.provideCodeLenses(doc);
        const result = lenses.find(item => item.command?.arguments?.[0].type === type &&
            item.command.title.includes(pathText));
        assert.ok(result?.command);
        return result;
    }
    async function execute(item: vscode.CodeLens) {
        await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    }
    function assertEditor(doc: vscode.TextDocument, line: number) {
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, doc.uri.fsPath);
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, line);
    }

    test('dynamic REST, usage counts, unmatched lenses and bidirectional navigation survive', async () => {
        const cached = await api.analysisService.getAnalysis();
        const forward = await lens(frontend, 'rest', '/api/users/{id}');
        const reverse = await lens(backend, 'rest', '/api/users/{id}');
        assert.ok(reverse.command!.title.includes('1 Frontend Usage'));
        assert.ok((await lens(frontend, 'rest', '/api/missing')).command!.title.includes('No Backend Found'));
        await vscode.window.showTextDocument(frontend);
        await execute(forward); assertEditor(backend, 3);
        await execute(reverse); assertEditor(frontend, 1);
        assert.strictEqual(await api.analysisService.getAnalysis(), cached, 'Clicks reuse the cache');
    });

    test('WebSocket/STOMP navigation works in both directions', async () => {
        const forward = await lens(frontend, 'websocket', '/app/chat.send');
        const reverse = await lens(backend, 'websocket', '/app/chat.send');
        assert.ok(reverse.command!.title.includes('1 Frontend Usage'));
        await vscode.window.showTextDocument(frontend);
        await execute(forward); assertEditor(backend, 5);
        await execute(reverse); assertEditor(frontend, 3);
    });

    test('saving moved endpoint lines rejects old payloads and refreshed lenses navigate correctly', async () => {
        const oldForward = await lens(frontend, 'rest', '/api/users/{id}');
        const oldReverse = await lens(backend, 'rest', '/api/users/{id}');
        const refreshed = deferred<void>();
        const listener = api.codeLensProvider.onDidChangeCodeLenses(() => refreshed.resolve());
        try {
            await save(backend, '\n\n\n\n\n' + java);
            await refreshed.promise;
            const newForward = await lens(frontend, 'rest', '/api/users/{id}');
            const newReverse = await lens(backend, 'rest', '/api/users/{id}');
            assert.strictEqual(newReverse.range.start.line, 8);
            await vscode.window.showTextDocument(frontend);
            await execute(oldForward);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
            await execute(newForward); assertEditor(backend, 8);
            await execute(oldReverse);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, backend.uri.fsPath);
            await execute(newReverse); assertEditor(frontend, 1);
        } finally { listener.dispose(); }
    });

    test('multiple frontend usages retain their count and Quick Pick command', async () => {
        await save(frontend, js + 'axios.get("/api/users/2");\n');
        const reverse = await lens(backend, 'rest', '/api/users/{id}');
        assert.ok(reverse.command!.title.includes('2 Frontend Usages'));
        assert.strictEqual(reverse.command!.command, 'fullstack-lens.findFrontendUsages');
        const analysis = await api.analysisService.getAnalysis();
        const endpoint = analysis.restEndpoints.find(item => item.path === '/api/users/{id}');
        assert.ok(endpoint);
        assert.strictEqual(analysis.restUsages.get(endpoint)?.length, 2);
    });

    test('explicit workspace scan replaces the cache and emits a refresh', async () => {
        await delay(500); // Drain any save-triggered debounce from setup.
        const old = await api.analysisService.getAnalysis();
        let events = 0;
        const listener = api.codeLensProvider.onDidChangeCodeLenses(() => events++);
        try {
            await vscode.commands.executeCommand('fullstack-lens.scanWorkspace');
            assert.notStrictEqual(await api.analysisService.getAnalysis(), old);
            assert.strictEqual(events, 1);
        } finally { listener.dispose(); }
    });

    test('missing or malformed targets complete without throwing or navigating', async () => {
        await vscode.window.showTextDocument(frontend);
        const current = await api.analysisService.getAnalysis();
        await vscode.commands.executeCommand('fullstack-lens.goToBackend', {
            type: 'rest', filePath: frontend.uri.fsPath, line: 9999, revision: current.revision,
        });
        await vscode.commands.executeCommand('fullstack-lens.findFrontendUsages', {
            type: 'rest', filePath: 42, line: -1,
        });
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Only individually tracked files in the disposable fixture are removed.
        for (const file of createdFiles) {
            if (fs.existsSync(file)) { fs.unlinkSync(file); }
        }
        api.analysisService.clearCache();
    });
});
