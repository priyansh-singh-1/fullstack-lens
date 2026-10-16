import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalysisService } from '../core/analysis/AnalysisService';
import { AnalysisResult } from '../core/analysis/AnalysisResult';
import { FileAnalysis } from '../core/analysis/FileAnalysis';
import { RestDiagnosticAnalyzer } from '../core/analysis/RestDiagnosticAnalyzer';
import { FullStackCodeLensProvider } from '../core/codelens/FullStackCodeLensProvider';
import { EndpointMatcher } from '../core/matching/EndPointMatcher';
import { WebSocketMatcher } from '../core/matching/WebSocketMatcher';
import { ProjectFile } from '../core/models/ProjectFile';
import { FrontendApiScanner } from '../core/parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../core/parsing/frontend/FrontendWebSocketScanner';
import { SpringEndpointScanner } from '../core/parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../core/parsing/spring/SpringWebSocketScanner';
import * as vscode from 'vscode';

interface Internals {
    indexer: { indexWorkspace(): Promise<ProjectFile[]> };
    readSource(file: ProjectFile): Promise<string>;
    committedState: { result: AnalysisResult; files: Map<string, FileAnalysis> };
    springScanner: SpringEndpointScanner;
    frontendScanner: FrontendApiScanner;
    springwebsocketScanner: SpringWebSocketScanner;
    frontendWebSocketScanner: FrontendWebSocketScanner;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function reference(files: ProjectFile[], revision: number): AnalysisResult {
    const restEndpoints = new SpringEndpointScanner().scan(files);
    const restCalls = new FrontendApiScanner().scan(files);
    const websocketEndpoints = new SpringWebSocketScanner().scan(files);
    const websocketCalls = new FrontendWebSocketScanner().scan(files);
    const restUsages: AnalysisResult['restUsages'] = new Map();
    const websocketUsages: AnalysisResult['websocketUsages'] = new Map();
    const restMatches = new EndpointMatcher().match(restCalls, restEndpoints, restUsages);
    const websocketMatches = new WebSocketMatcher().match(websocketCalls, websocketEndpoints, websocketUsages);
    return {
        revision, files, restEndpoints, restCalls, restMatches, restUsages,
        websocketEndpoints, websocketCalls, websocketMatches, websocketUsages,
        diagnostics: new RestDiagnosticAnalyzer().analyze(restMatches, restEndpoints)
    };
}

suite('Changed-file rescanning with global derivation', () => {
    let directory: string;
    let files: ProjectFile[];
    let frontend: ProjectFile, backend: ProjectFile, definitions: ProjectFile, config: ProjectFile;
    let service: AnalysisService, internal: Internals;
    let reads: string[], scans: string[], indexes: number;
    const java = '@RestController\n@RequestMapping("/api")\nclass C {\n' +
        '@GetMapping("/items/{id}")\nvoid dynamic() {}\n' +
        '@GetMapping("/items/static")\nvoid exact() {}\n' +
        '@MessageMapping("/send")\nvoid send() {}\n}';
    const js = 'API.get("/items/static");\nclient.publish({destination: "/app/send"});\n';

    function file(name: string, source: string): ProjectFile {
        const result: ProjectFile = { path: path.join(directory, name),
            language: name.endsWith('.java') ? 'java' : 'typescript' };
        fs.writeFileSync(result.path, source);
        files.push(result);
        return result;
    }

    setup(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-incremental-'));
        files = [];
        frontend = file('Client.ts', js);
        backend = file('Controller.java', java);
        definitions = file('Definitions.ts', 'const API = axios.create({baseURL: "/api"});');
        config = file('Config.java', 'registry.setApplicationDestinationPrefixes("/app");');
        file('Empty.ts', 'export const unrelated = true;');
        service = new AnalysisService();
        internal = service as unknown as Internals;
        reads = []; scans = []; indexes = 0;
        internal.indexer.indexWorkspace = async () => { indexes++; return files.slice(); };
        const read = internal.readSource.bind(service);
        internal.readSource = async file => { reads.push(file.path); return read(file); };
        const spring = internal.springScanner.scanFile.bind(internal.springScanner);
        internal.springScanner.scanFile = (file, source) => { scans.push(file.path); return spring(file, source); };
        const rest = internal.frontendScanner.scanFile.bind(internal.frontendScanner);
        internal.frontendScanner.scanFile = (file, source, instances) => {
            scans.push(file.path); return rest(file, source, instances);
        };
        const springSocket = internal.springwebsocketScanner.scanFile.bind(internal.springwebsocketScanner);
        internal.springwebsocketScanner.scanFile = (file, source, prefix) => {
            scans.push(file.path); return springSocket(file, source, prefix);
        };
        const socket = internal.frontendWebSocketScanner.scanFile.bind(internal.frontendWebSocketScanner);
        internal.frontendWebSocketScanner.scanFile = (file, source) => {
            scans.push(file.path); return socket(file, source);
        };
        await service.getAnalysis();
        assert.strictEqual(reads.length, 5);
        resetCounts();
    });
    teardown(() => {
        for (const file of files) {
            if (fs.existsSync(file.path)) { fs.unlinkSync(file.path); }
        }
        fs.rmdirSync(directory);
    });

    function resetCounts() { reads.length = 0; scans.length = 0; indexes = 0; }
    function save(file: ProjectFile, source: string) {
        fs.writeFileSync(file.path, source);
        service.enqueueFileChange(file.path);
    }
    async function parity() {
        const actual = await service.getAnalysis();
        assert.deepStrictEqual(actual, reference(files, actual.revision));
        assert.strictEqual(internal.committedState.result, actual);
        return actual;
    }
    function oneFile(file: ProjectFile) {
        assert.deepStrictEqual(reads, [file.path]);
        assert.deepStrictEqual(scans, Array(4).fill(file.path));
        assert.strictEqual(indexes, 0, 'No workspace discovery on ordinary warm save');
    }

    test('ordinary frontend save reads one source, reuses unchanged entries and preserves old snapshots', async () => {
        const old = await service.getAnalysis();
        const oldState = internal.committedState;
        const previousEntries = Array.from(oldState.files.values());
        save(frontend, 'API.get("/items/42");\n');
        assert.strictEqual(service.isCurrentRevision(old.revision), false);
        const updated = await parity();
        oneFile(frontend);
        const newEntries = Array.from(internal.committedState.files.values());
        assert.notStrictEqual(newEntries[0], previousEntries[0]);
        for (let index = 1; index < files.length; index++) {
            assert.strictEqual(newEntries[index], previousEntries[index]);
        }
        assert.strictEqual(old.restCalls[0].path, '/api/items/static');
        assert.strictEqual(old.websocketCalls.length, 1);
        assert.strictEqual(old.restUsages.get(old.restEndpoints[1])?.length, 1);
        assert.strictEqual(updated.restCalls[0].path, '/api/items/42');
        assert.strictEqual(oldState.result, old);
        assert.strictEqual(await service.getAnalysis(), updated);
        oneFile(frontend);
    });

    test('backend line movement updates forward targets and reverse CodeLens with one source read', async () => {
        save(backend, '\n\n' + java);
        const result = await parity();
        oneFile(backend);
        assert.strictEqual(result.restMatches[0].endpoint?.line, 7);
        const provider = new FullStackCodeLensProvider(service);
        try {
            const document = { languageId: 'java', fileName: backend.path,
                uri: vscode.Uri.file(backend.path) } as vscode.TextDocument;
            const lenses = await provider.provideCodeLenses(document);
            const lens = lenses.find(item => item.command?.title.includes('/api/items/static'));
            assert.strictEqual(lens?.range.start.line, 7);
            assert.strictEqual(lens?.command?.arguments?.[0].revision, result.revision);
        } finally { provider.dispose(); }
    });

    test('adding and removing frontend calls replaces usages and all four diagnostic classifications', async () => {
        save(frontend, 'API.get("/items/static");\nAPI.get("/items/42");\n' +
            'axios.get("/missing");\naxios.post("/api/items/42");\nfetch(buildUrl());');
        let result = await parity();
        oneFile(frontend);
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['FSL001', 'FSL002', 'FSL004']);
        assert.deepStrictEqual(result.restEndpoints.map(endpoint => result.restUsages.get(endpoint)?.length ?? 0), [1, 1]);
        resetCounts();
        save(frontend, '// all calls removed');
        result = await parity();
        oneFile(frontend);
        assert.deepStrictEqual(result.restCalls, []);
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.restUsages.size, 0);
    });

    test('removing a static backend route redistributes usage to the dynamic fallback', async () => {
        save(backend, java.replace('@GetMapping("/items/static")\nvoid exact() {}\n', ''));
        const result = await parity();
        oneFile(backend);
        assert.strictEqual(result.restMatches[0].endpoint?.path, '/api/items/{id}');
        assert.strictEqual(result.restUsages.get(result.restEndpoints[0])?.length, 1);
        assert.deepStrictEqual(result.diagnostics, []);
    });

    test('backend method and route changes transition FSL002 and FSL001 without rescanning consumers', async () => {
        save(backend, java.replaceAll('@GetMapping', '@PostMapping'));
        let result = await parity();
        oneFile(backend);
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['FSL002']);
        resetCounts();
        save(backend, java.replaceAll('/items/', '/other/'));
        result = await parity();
        oneFile(backend);
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['FSL001']);
    });

    test('adding equal-specificity backend mappings introduces ambiguity and preserves candidate ordering', async () => {
        save(frontend, 'API.get("/items/42");');
        await parity(); resetCounts();
        save(backend, java.replace('void dynamic() {}',
            'void dynamic() {}\n@GetMapping("/items/{other}")\nvoid other() {}'));
        const result = await parity();
        oneFile(backend);
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['FSL003']);
        assert.strictEqual(result.restMatches[0].candidateEndpoints?.length, 2);
    });

    test('WebSocket publish edits and subscription removal update exact matches and usages', async () => {
        save(frontend, js.replace('/app/send', '/app/other') + 'client.subscribe("/app/send", handler);');
        let result = await parity();
        oneFile(frontend);
        assert.strictEqual(result.websocketMatches[0].matched, false);
        assert.deepStrictEqual(result.websocketUsages.get(result.websocketEndpoints[0]), []);
        resetCounts(); save(frontend, js);
        result = await parity(); oneFile(frontend);
        assert.strictEqual(result.websocketUsages.get(result.websocketEndpoints[0])?.length, 1);
    });

    test('MessageMapping edits with unchanged prefix rescan only the Java file', async () => {
        save(backend, java.replace('@MessageMapping("/send")', '@MessageMapping("/other")'));
        const result = await parity(); oneFile(backend);
        assert.strictEqual(result.websocketEndpoints[0].inboundDestination, '/app/other');
        assert.strictEqual(result.websocketMatches[0].matched, false);
    });

    test('repeated saves coalesce to one latest read and retain revision increments', async () => {
        const previous = await service.getAnalysis();
        save(frontend, 'API.get("/old");');
        save(frontend, 'API.get("/middle");');
        save(frontend, 'API.get("/items/static");');
        const result = await parity(); oneFile(frontend);
        assert.strictEqual(result.revision, previous.revision + 3);
        console.log('[FSL test] warm single save: 1 read; same-file burst: 1 read; workspace discoveries: 0');
    });

    test('two-file rapid saves read each changed source once and preserve inventory order', async () => {
        save(frontend, 'API.get("/new");');
        save(backend, java.replace('/items/static', '/new'));
        const result = await parity();
        assert.deepStrictEqual(reads, [frontend.path, backend.path]);
        assert.strictEqual(indexes, 0);
        assert.ok(scans.every(file => file === frontend.path || file === backend.path));
        assert.strictEqual(result.restMatches[0].matched, true);
        assert.deepStrictEqual(result.files, files);
    });

    for (const newerFile of ['same', 'other'] as const) {
        test(`save during incremental loading retains dirty files and rejects obsolete success (${newerFile} file)`, async () => {
            const committed = internal.committedState;
            const started = deferred<void>(), release = deferred<void>();
            const read = internal.readSource.bind(service);
            let firstRead = true, active = 0, maxActive = 0;
            internal.readSource = async file => {
                active++; maxActive = Math.max(maxActive, active);
                try {
                    const source = await read(file);
                    if (firstRead) { firstRead = false; started.resolve(); await release.promise; }
                    return source;
                } finally { active--; }
            };
            save(frontend, 'API.get("/items/old");');
            const first = service.getAnalysis();
            await started.promise;
            assert.strictEqual(internal.committedState, committed);
            if (newerFile === 'same') { save(frontend, 'API.get("/items/latest");'); }
            else { save(backend, '\n' + java); }
            const second = service.getAnalysis();
            release.resolve();
            const [a, b] = await Promise.all([first, second]);
            assert.strictEqual(a, b);
            assert.deepStrictEqual(a, reference(files, a.revision));
            assert.strictEqual(indexes, 0);
            assert.strictEqual(maxActive, 1);
            assert.deepStrictEqual(reads, newerFile === 'same'
                ? [frontend.path, frontend.path] : [frontend.path, frontend.path, backend.path]);
        });
    }

    test('obsolete incremental failure retries latest dirty paths without triggering full discovery', async () => {
        const read = internal.readSource.bind(service);
        const started = deferred<void>(), release = deferred<string>();
        let firstRead = true;
        internal.readSource = async file => {
            if (firstRead) { firstRead = false; reads.push(file.path); started.resolve(); return release.promise; }
            return read(file);
        };
        save(frontend, js);
        const pending = service.getAnalysis();
        await started.promise;
        save(frontend, 'API.get("/items/latest");');
        release.reject(new Error('obsolete read failed'));
        const result = await pending;
        assert.deepStrictEqual(result, reference(files, result.revision));
        assert.strictEqual(indexes, 0);
        assert.deepStrictEqual(reads, [frontend.path, frontend.path]);
    });

    test('forced full rebuild during incremental loading supersedes it and rebuilds committed state', async () => {
        const read = internal.readSource.bind(service);
        const started = deferred<void>(), release = deferred<void>();
        let firstRead = true;
        internal.readSource = async file => {
            const source = await read(file);
            if (firstRead) { firstRead = false; started.resolve(); await release.promise; }
            return source;
        };
        save(frontend, js);
        const incremental = service.getAnalysis();
        await started.promise;
        const forced = service.getAnalysis(true);
        release.resolve();
        const [a, b] = await Promise.all([incremental, forced]);
        assert.strictEqual(a, b);
        assert.deepStrictEqual(a, reference(files, a.revision));
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, [frontend.path, ...files.map(file => file.path)]);
        resetCounts(); save(backend, '\n' + java); await parity(); oneFile(backend);
    });

    test('explicit full scan after incremental publication rereads the complete inventory', async () => {
        save(frontend, 'API.get("/items/42");');
        const old = await parity(); resetCounts();
        const rebuilt = await service.getAnalysis(true);
        assert.deepStrictEqual(rebuilt, reference(files, rebuilt.revision));
        assert.strictEqual(rebuilt.revision, old.revision + 1);
        assert.deepStrictEqual(reads, files.map(file => file.path));
        assert.strictEqual(indexes, 1);
    });

    test('Axios definition changes rebuild all consumers and resume ordinary incremental saves afterward', async () => {
        save(definitions, 'const API = axios.create({baseURL: "/changed"});');
        const result = await parity();
        assert.strictEqual(result.restCalls[0].path, '/changed/items/static');
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, [definitions.path, ...files.map(file => file.path)]);
        resetCounts(); save(frontend, 'API.get("/items/42");'); await parity(); oneFile(frontend);
    });

    test('prefix candidate changes rebuild MessageMapping destinations, including removal', async () => {
        save(config, 'registry.setApplicationDestinationPrefixes("/changed");');
        let result = await parity();
        assert.strictEqual(result.websocketEndpoints[0].inboundDestination, '/changed/send');
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, [config.path, ...files.map(file => file.path)]);
        resetCounts(); save(config, '// prefix removed');
        result = await parity();
        assert.strictEqual(result.websocketEndpoints[0].inboundDestination, '/send');
        assert.strictEqual(indexes, 1);
    });

    test('unchanged Axios and prefix configuration facts allow one-file updates', async () => {
        save(definitions, '// line moved\nconst API = axios.create({baseURL: "/api"});');
        await parity(); oneFile(definitions);
        resetCounts();
        save(config, '// line moved\nregistry.setApplicationDestinationPrefixes("/app");');
        await parity(); oneFile(config);
    });

    test('introducing a conflicting Axios definition triggers full consumer re-resolution', async () => {
        save(files[4], 'const API = axios.create({baseURL: "/conflict"});');
        const result = await parity();
        assert.strictEqual(indexes, 1);
        assert.strictEqual(result.restCalls[0].resolution, 'unresolved');
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['FSL004']);
        assert.deepStrictEqual(reads, [files[4].path, ...files.map(file => file.path)]);
    });

    test('changing an unselected prefix candidate conservatively rebuilds without changing effective destinations', async () => {
        const alternate = file('Alternate.java', 'registry.setApplicationDestinationPrefixes("/unused");');
        await service.getAnalysis(true); resetCounts();
        save(alternate, 'registry.setApplicationDestinationPrefixes("/different-unused");');
        const result = await parity();
        assert.strictEqual(indexes, 1);
        assert.strictEqual(result.websocketEndpoints[0].inboundDestination, '/app/send');
    });

    test('a partially scanned candidate is isolated while a later dirty source is loading', async () => {
        const committed = internal.committedState;
        const previousEntries = Array.from(committed.files.values());
        const read = internal.readSource.bind(service);
        const started = deferred<void>(), release = deferred<void>();
        let blocked = false;
        internal.readSource = async file => {
            const source = await read(file);
            if (file === backend && !blocked) { blocked = true; started.resolve(); await release.promise; }
            return source;
        };
        save(frontend, 'API.get("/first");');
        save(backend, java.replace('/items/static', '/first'));
        const pending = service.getAnalysis();
        await started.promise;
        assert.strictEqual(internal.committedState, committed);
        assert.deepStrictEqual(Array.from(committed.files.values()), previousEntries);
        assert.strictEqual(committed.result.restCalls[0].path, '/api/items/static');
        save(frontend, 'API.get("/items/latest");');
        release.resolve();
        const result = await pending;
        assert.deepStrictEqual(result, reference(files, result.revision));
        assert.strictEqual(indexes, 0);
        assert.deepStrictEqual(reads, [frontend.path, backend.path, frontend.path, backend.path]);
    });

    test('a missing committed entry falls back to one full repair of the inventory', async () => {
        const key = internal.committedState.files.keys().next().value!;
        internal.committedState.files.delete(key);
        save(backend, '\n' + java);
        await parity();
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, files.map(file => file.path));
        assert.strictEqual(internal.committedState.files.size, files.length);
    });

    test('an unindexed saved path conservatively performs full discovery', async () => {
        const added = file('PreviouslyUnindexed.ts', 'API.get("/items/42");');
        service.enqueueFileChange(added.path);
        await parity();
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, files.map(file => file.path));
    });

    test('current incremental failure attempts one full repair; full failure preserves the old committed state', async () => {
        const read = internal.readSource.bind(service);
        const committed = internal.committedState;
        let fail = true;
        internal.readSource = async file => {
            if (fail) { reads.push(file.path); throw new Error('read unavailable'); }
            return read(file);
        };
        save(frontend, js);
        await assert.rejects(service.getAnalysis(), /read unavailable/);
        assert.strictEqual(indexes, 1);
        assert.strictEqual(reads.length, 2, 'One incremental failure and one full failure, without a loop');
        assert.strictEqual(internal.committedState, committed);
        fail = false; resetCounts();
        await parity();
        assert.strictEqual(indexes, 1);
        assert.deepStrictEqual(reads, files.map(file => file.path));
    });
});
