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

    test('WebSocket lenses use precomputed match status even when raw destinations coincide', async () => {
        const service = new AnalysisService();
        const result = snapshot(0);
        const call = { type: 'publish' as const, destination: '/app/chat.send', filePath: 'Client.ts', line: 0 };
        result.websocketCalls = [call];
        result.websocketEndpoints = [{ inboundDestination: call.destination, filePath: 'Controller.java', line: 0 }];
        result.websocketMatches = [{ call, matched: false }];
        stubScan(service, async () => result);
        const provider = new FullStackCodeLensProvider(service);
        disposables.push(provider);
        const doc = { languageId: 'typescript', fileName: call.filePath,
            uri: vscode.Uri.file(call.filePath) } as vscode.TextDocument;
        // Use the URI's absolute path consistently with the analysis snapshot.
        call.filePath = doc.uri.fsPath;
        const lenses = await provider.provideCodeLenses(doc);
        assert.strictEqual(lenses.length, 1);
        assert.strictEqual(lenses[0].command?.title, '$(warning) No Backend Found · PUBLISH /app/chat.send');
        assert.strictEqual(lenses[0].command?.command, 'fullstack-lens.showNoBackendInfo');
    });

    test('a CodeLens request cannot publish a snapshot invalidated before its continuation runs', async () => {
        const service = new AnalysisService();
        stubScan(service, async revision => snapshot(revision));
        const old = await service.getAnalysis();
        // Model a save queued after getAnalysis resolves but before the provider resumes.
        service.getAnalysis = async () => {
            queueMicrotask(() => service.clearCache());
            return old;
        };
        old.restMatches = [{ call: { method: 'GET', path: '/old', filePath: 'stale.ts', line: 0 }, matched: false }];
        const provider = new FullStackCodeLensProvider(service);
        try {
            const doc = { languageId: 'typescript', fileName: 'stale.ts', uri: { fsPath: 'stale.ts' } } as vscode.TextDocument;
            assert.deepStrictEqual(await provider.provideCodeLenses(doc), []);
        } finally { provider.dispose(); }
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

    type BackendPick = vscode.QuickPickItem & { endpoint: { filePath: string; line: number; path: string } };
    async function withBackendPick(
        pick: (items: BackendPick[]) => Promise<BackendPick | undefined>,
        action: () => Promise<void>
    ) {
        const original = vscode.window.showQuickPick;
        vscode.window.showQuickPick = (async (items: BackendPick[]) => pick(items)) as unknown as typeof original;
        try { await action(); } finally { vscode.window.showQuickPick = original; }
    }

    test('ambiguous lens resolves all best candidates and selection opens the exact file and line', async () => {
        const other = await document('OtherController.java', '\n\n@RestController\n@RequestMapping("/api")\n' +
            'class OtherController {\n@GetMapping("/users/{userId}")\nvoid user() {}\n}\n');
        try {
            const analysis = await api.analysisService.getAnalysis(true);
            const forward = await lens(frontend, 'rest', '/api/users/{id}');
            assert.ok(forward.command!.title.includes('Ambiguous Route'));
            assert.strictEqual(forward.command!.command, 'fullstack-lens.selectBackendEndpoint');
            assert.deepStrictEqual(forward.command!.arguments, [{
                type: 'rest', revision: analysis.revision, method: 'GET', path: '/api/users/{id}',
                filePath: frontend.uri.fsPath, line: 1
            }]);
            assert.ok(analysis.diagnostics.some(d => d.filePath === frontend.uri.fsPath && d.code === 'FSL003'));
            const candidates = analysis.restMatches.find(m => m.call.filePath === frontend.uri.fsPath &&
                m.call.line === 1)!.candidateEndpoints!;
            assert.strictEqual(candidates.length, 2);
            let picks = 0;
            await withBackendPick(async items => {
                picks++;
                assert.deepStrictEqual(items.map(item => item.endpoint), candidates);
                assert.ok(items.every(item => item.label.includes('GET /api/users/') &&
                    item.description?.includes(`${item.endpoint.line + 1}`)));
                return items.find(item => item.endpoint.filePath === other.uri.fsPath);
            }, async () => {
                await vscode.window.showTextDocument(frontend);
                await execute(forward);
                assertEditor(other, 5);
                // The normal command must also guard against first-match navigation.
                await vscode.commands.executeCommand('fullstack-lens.goToBackend', ...forward.command!.arguments!);
                assertEditor(other, 5);
            });
            assert.strictEqual(picks, 2);
            assert.strictEqual(await api.analysisService.getAnalysis(), analysis);
        } finally { await save(other, '// removed endpoint\n'); }
    });

    test('ambiguous cancellation and a save while Quick Pick is open never navigate', async () => {
        const ambiguous = java.replace('void user() {}', 'void user() {}\n@GetMapping("/users/{userId}")\nvoid other() {}');
        await save(backend, ambiguous);
        const forward = await lens(frontend, 'rest', '/api/users/{id}');
        await vscode.window.showTextDocument(frontend);
        const originalLine = vscode.window.activeTextEditor!.selection.active.line;
        await withBackendPick(async () => undefined, async () => {
            await execute(forward); assertEditor(frontend, originalLine);
        });
        await withBackendPick(async items => {
            await save(backend, '\n' + ambiguous);
            return items[1];
        }, async () => {
            await execute(forward);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
        });
    });

    test('saving away ambiguity rejects old payload and fresh selection command navigates directly', async () => {
        await save(backend, java.replace('void user() {}',
            'void user() {}\n@GetMapping("/users/{userId}")\nvoid other() {}'));
        const old = await lens(frontend, 'rest', '/api/users/{id}');
        const refreshed = deferred<void>();
        const listener = api.codeLensProvider.onDidChangeCodeLenses(() => refreshed.resolve());
        try {
            await save(backend, java);
            await refreshed.promise;
            const fresh = await lens(frontend, 'rest', '/api/users/{id}');
            assert.ok(fresh.command!.title.includes('Go to Backend'));
            assert.strictEqual(fresh.command!.command, 'fullstack-lens.goToBackend');
            await vscode.window.showTextDocument(frontend);
            await withBackendPick(async () => { assert.fail('Resolved/stale routes must not show Quick Pick'); }, async () => {
                await execute(old);
                assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
                await vscode.commands.executeCommand('fullstack-lens.selectBackendEndpoint', ...fresh.command!.arguments!);
                assertEditor(backend, 3);
            });
        } finally { listener.dispose(); }
    });

    test('ambiguous command rejects malformed and missing current targets safely', async () => {
        await vscode.window.showTextDocument(frontend);
        const current = await api.analysisService.getAnalysis();
        await withBackendPick(async () => { assert.fail('Invalid targets must not show Quick Pick'); }, async () => {
            for (const target of [undefined, { type: 'rest', filePath: 42, line: -1, revision: current.revision,
                method: 'GET', path: '/api/users/{id}' }, { type: 'rest', filePath: frontend.uri.fsPath,
                line: 9999, revision: current.revision, method: 'GET', path: '/api/users/{id}' }]) {
                await vscode.commands.executeCommand('fullstack-lens.selectBackendEndpoint', target);
            }
        });
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
    });

    test('missing and method-mismatched routes keep their titles and diagnostic codes', async () => {
        await save(frontend, 'axios.get("/api/missing");\naxios.post("/api/users/123");\n');
        const missing = await lens(frontend, 'rest', '/api/missing');
        const mismatch = await lens(frontend, 'rest', '/api/users/123');
        assert.ok(missing.command!.title.includes('No Backend Found'));
        assert.ok(mismatch.command!.title.includes('Method Mismatch'));
        assert.strictEqual(missing.command!.command, 'fullstack-lens.goToBackend');
        assert.strictEqual(mismatch.command!.command, 'fullstack-lens.goToBackend');
        const analysis = await api.analysisService.getAnalysis();
        assert.deepStrictEqual(analysis.diagnostics.filter(d => d.filePath === frontend.uri.fsPath)
            .map(d => d.code), ['FSL001', 'FSL002']);
    });

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
        assert.strictEqual(forward.command!.title, '$(radio-tower) Go to Backend · PUBLISH /app/chat.send');
        assert.strictEqual(forward.command!.command, 'fullstack-lens.goToBackend');
        const reverse = await lens(backend, 'websocket', '/app/chat.send');
        assert.ok(reverse.command!.title.includes('1 Frontend Usage'));
        await vscode.window.showTextDocument(frontend);
        await execute(forward); assertEditor(backend, 5);
        await execute(reverse); assertEditor(frontend, 3);
    });

    test('publish CodeLens refreshes matched → unmatched → matched after frontend saves', async () => {
        const initial = await lens(frontend, 'websocket', '/app/chat.send');
        assert.strictEqual(initial.command!.command, 'fullstack-lens.goToBackend');
        let previous = await api.analysisService.getAnalysis();
        for (const destination of ['/app/chat.test', '/app/chat.send']) {
            const refreshed = deferred<void>();
            const listener = api.codeLensProvider.onDidChangeCodeLenses(() => refreshed.resolve());
            try {
                await save(frontend, js.replace('/app/chat.send', destination));
                await refreshed.promise;
                const current = await api.analysisService.getAnalysis();
                assert.ok(current.revision > previous.revision);
                const item = await lens(frontend, 'websocket', destination);
                const matched = destination === '/app/chat.send';
                assert.strictEqual(item.command!.title, matched
                    ? `$(radio-tower) Go to Backend · PUBLISH ${destination}`
                    : `$(warning) No Backend Found · PUBLISH ${destination}`);
                assert.strictEqual(item.command!.command, matched
                    ? 'fullstack-lens.goToBackend' : 'fullstack-lens.showNoBackendInfo');
                assert.strictEqual(item.command!.arguments![0].revision, current.revision);
                assert.ok((await lens(backend, 'websocket', '/app/chat.send')).command!.title
                    .includes(`${matched ? 1 : 0} Frontend Usage`));
                previous = current;
            } finally { listener.dispose(); }
        }
        await vscode.window.showTextDocument(frontend);
        await execute(await lens(frontend, 'websocket', '/app/chat.send'));
        assertEditor(backend, 5);
    });

    test('clicking an unmatched publish only shows information and never attempts navigation', async () => {
        await save(frontend, js.replace('/app/chat.send', '/app/chat.test'));
        const item = await lens(frontend, 'websocket', '/app/chat.test');
        assert.strictEqual(item.command!.title, '$(warning) No Backend Found · PUBLISH /app/chat.test');
        assert.strictEqual(item.command!.command, 'fullstack-lens.showNoBackendInfo');
        await vscode.window.showTextDocument(frontend);
        const originalInfo = vscode.window.showInformationMessage;
        const originalOpen = vscode.window.showTextDocument;
        const originalAnalysis = api.analysisService.getAnalysis;
        let messages = 0;
        try {
            vscode.window.showInformationMessage = ((message: string) => {
                assert.strictEqual(message, 'No matching WebSocket backend endpoint found for this publish destination.');
                messages++;
                return Promise.resolve(undefined);
            }) as typeof originalInfo;
            vscode.window.showTextDocument = (() => {
                assert.fail('An unmatched publish must not open a navigation target');
            }) as typeof originalOpen;
            api.analysisService.getAnalysis = async () => {
                assert.fail('An unmatched publish click must not request navigation analysis');
            };
            await execute(item);
            assert.strictEqual(messages, 1);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, frontend.uri.fsPath);
        } finally {
            vscode.window.showInformationMessage = originalInfo;
            vscode.window.showTextDocument = originalOpen;
            api.analysisService.getAnalysis = originalAnalysis;
        }
    });

    test('subscriptions and duplicate WebSocket endpoints preserve counts, ordering and first navigation target', async () => {
        await save(backend, java.replace('void chat() {}',
            'void chat() {}\n@MessageMapping("/chat.send")\nvoid duplicate() {}'));
        await save(frontend, js + 'client.subscribe("/app/chat.send", handler);\n' +
            'client.subscribe("/topic/messages", handler);\n' +
            'client.publish({destination:"/app/chat.test"});\n' +
            'client.publish({destination:"/app/chat.send"});\n');
        const analysis = await api.analysisService.getAnalysis();
        const endpoints = analysis.websocketEndpoints.filter(item => item.filePath === backend.uri.fsPath);
        assert.strictEqual(endpoints.length, 2);
        assert.deepStrictEqual(endpoints.map(endpoint => analysis.websocketUsages.get(endpoint)?.length), [2, 2]);
        const matches = analysis.websocketMatches.filter(item => item.call.filePath === frontend.uri.fsPath);
        assert.deepStrictEqual(matches.map(item => [item.call.line, item.matched]), [[3, true], [6, false], [7, true]]);
        assert.strictEqual(matches[0].endpoint, endpoints[0]);
        assert.strictEqual(matches[2].endpoint, endpoints[0]);
        const lenses = (await api.codeLensProvider.provideCodeLenses(frontend))
            .filter(item => item.command?.arguments?.[0].type === 'websocket');
        assert.deepStrictEqual(lenses.map(item => item.range.start.line), [3, 6, 7]);
        const reverse = (await api.codeLensProvider.provideCodeLenses(backend))
            .filter(item => item.command?.arguments?.[0].type === 'websocket');
        assert.ok(reverse.every(item => item.command!.title.includes('2 Frontend Usages')));
        await vscode.window.showTextDocument(frontend);
        await execute(lenses[0]);
        assertEditor(backend, 5);
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

    test('reverse usage Quick Pick selects the exact line, cancels, and rejects a selection after save', async () => {
        await save(frontend, js + 'axios.get("/api/users/2");\n');
        const reverse = await lens(backend, 'rest', '/api/users/{id}');
        type UsagePick = vscode.QuickPickItem & { call: { filePath: string; line: number } };
        const original = vscode.window.showQuickPick;
        try {
            vscode.window.showQuickPick = (async (items: UsagePick[]) => {
                assert.deepStrictEqual(items.map(item => item.call.line), [1, 4]);
                assert.ok(items[1].description?.endsWith(' : 5'));
                return items[1];
            }) as unknown as typeof original;
            await vscode.window.showTextDocument(backend);
            await execute(reverse); assertEditor(frontend, 4);
            vscode.window.showQuickPick = (async () => undefined) as unknown as typeof original;
            await vscode.window.showTextDocument(backend);
            await execute(reverse);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, backend.uri.fsPath);
            vscode.window.showQuickPick = (async (items: UsagePick[]) => {
                await save(frontend, '\n' + frontend.getText());
                return items[1];
            }) as unknown as typeof original;
            await execute(reverse);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, backend.uri.fsPath);
        } finally { vscode.window.showQuickPick = original; }
    });

    test('CodeLens distinguishes missing and method-mismatched calls on the same line', async () => {
        await save(frontend, 'axios.post("/api/users/1"); axios.get("/api/absent");\n');
        assert.ok((await lens(frontend, 'rest', '/api/users/1')).command!.title.includes('Method Mismatch'));
        assert.ok((await lens(frontend, 'rest', '/api/absent')).command!.title.includes('No Backend Found'));
    });

    test('relevant saves refresh published Problems diagnostics and remove fixed errors', async () => {
        const diagnosticCodes = () => vscode.languages.getDiagnostics(frontend.uri)
            .filter(d => d.source === 'FullStack Lens').map(d => d.code);
        async function waitForCodes(expected: string[]) {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (JSON.stringify(diagnosticCodes()) === JSON.stringify(expected)) { return; }
                await delay(50);
            }
            assert.deepStrictEqual(diagnosticCodes(), expected);
        }
        await save(frontend, 'axios.post("/api/users/1");\n');
        await waitForCodes(['FSL002']);
        await save(frontend, 'axios.get("/api/users/1");\n');
        await waitForCodes([]);
        await save(backend, java.replace('@GetMapping("/users/{id}")', '@PostMapping("/users/{id}")'));
        await waitForCodes(['FSL002']);
    });

    test('specific routes drive precomputed usages, CodeLens and navigation after saves', async () => {
        const routes = '@RestController\n@RequestMapping("/api/chat")\nclass Controller {\n' +
            '@GetMapping("/{userId}")\nvoid user() {}\n' +
            '@GetMapping("/history")\nvoid history() {}\n' +
            '@GetMapping("/pending")\nvoid pending() {}\n}\n';
        await save(backend, routes);
        await save(frontend, 'axios.get("/api/chat/history");\n' +
            'axios.get("/api/chat/history");\naxios.get("/api/chat/pending");\n');
        const analysis = await api.analysisService.getAnalysis();
        const counts = analysis.restEndpoints.filter(item => item.filePath === backend.uri.fsPath)
            .map(item => [item.path, analysis.restUsages.get(item)?.length ?? 0]);
        assert.deepStrictEqual(counts, [
            ['/api/chat/{userId}', 0], ['/api/chat/history', 2], ['/api/chat/pending', 1]
        ]);
        assert.ok(analysis.restMatches.filter(item => item.call.filePath === frontend.uri.fsPath)
            .every(item => item.candidateEndpoints?.length === 1));
        assert.ok(!analysis.diagnostics.some(item => item.filePath === frontend.uri.fsPath));
        assert.ok((await lens(backend, 'rest', '/api/chat/{userId}'))
            .command!.title.includes('0 Frontend Usages'));
        assert.ok((await lens(backend, 'rest', '/api/chat/history'))
            .command!.title.includes('2 Frontend Usages'));
        const forward = await lens(frontend, 'rest', '/api/chat/pending');
        const reverse = await lens(backend, 'rest', '/api/chat/pending');
        await vscode.window.showTextDocument(frontend);
        await execute(forward); assertEditor(backend, 7);
        await execute(reverse); assertEditor(frontend, 2);
        assert.strictEqual(await api.analysisService.getAnalysis(), analysis);

        const refreshed = deferred<void>();
        const listener = api.codeLensProvider.onDidChangeCodeLenses(() => refreshed.resolve());
        try {
            // Removing a static route must move its calls to the dynamic fallback.
            await save(backend, routes.replace('@GetMapping("/history")\nvoid history() {}\n', ''));
            await refreshed.promise;
            const fresh = await api.analysisService.getAnalysis();
            assert.notStrictEqual(fresh, analysis);
            const dynamic = fresh.restEndpoints.find(item => item.filePath === backend.uri.fsPath &&
                item.path === '/api/chat/{userId}');
            assert.ok(dynamic);
            assert.strictEqual(fresh.restUsages.get(dynamic)?.length, 2);
            assert.ok((await lens(backend, 'rest', dynamic.path))
                .command!.title.includes('2 Frontend Usages'));
            await execute(await lens(frontend, 'rest', '/api/chat/history'));
            assertEditor(backend, 3);
        } finally { listener.dispose(); }
    });

    test('explicit workspace scan replaces the cache and emits a refresh', async () => {
        await delay(500); // Drain any save-triggered debounce from setup.
        const old = await api.analysisService.getAnalysis();
        let events = 0;
        const listener = api.codeLensProvider.onDidChangeCodeLenses(() => events++);
        // Scan Workspace shows Output asynchronously; finish that UI transition
        // before the next test selects a source editor.
        const outputShown = deferred<void>();
        const outputListener = vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor?.document.uri.scheme === 'output') { outputShown.resolve(); }
        });
        if (vscode.window.activeTextEditor?.document.uri.scheme === 'output') { outputShown.resolve(); }
        try {
            await vscode.commands.executeCommand('fullstack-lens.scanWorkspace');
            await outputShown.promise;
            assert.notStrictEqual(await api.analysisService.getAnalysis(), old);
            assert.strictEqual(events, 1);
        } finally { listener.dispose(); outputListener.dispose(); }
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
