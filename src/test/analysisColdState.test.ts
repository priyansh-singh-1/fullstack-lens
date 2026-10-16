import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalysisService } from '../core/analysis/AnalysisService';
import { AnalysisResult } from '../core/analysis/AnalysisResult';
import { FileAnalysis } from '../core/analysis/FileAnalysis';
import { RestDiagnosticAnalyzer } from '../core/analysis/RestDiagnosticAnalyzer';
import { ProjectFile } from '../core/models/ProjectFile';
import { EndpointMatcher } from '../core/matching/EndPointMatcher';
import { WebSocketMatcher } from '../core/matching/WebSocketMatcher';
import { FrontendApiScanner } from '../core/parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../core/parsing/frontend/FrontendWebSocketScanner';
import { SpringEndpointScanner } from '../core/parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../core/parsing/spring/SpringWebSocketScanner';

// Instrument private I/O boundaries, following the existing analysis concurrency tests.
// The real loading, scanning, matching and revision/publication paths still run.
interface AnalysisInternals {
    indexer: { indexWorkspace(): Promise<ProjectFile[]> };
    readSource(file: ProjectFile): Promise<string>;
    analyzeFiles(files: ProjectFile[]): Promise<FileAnalysis[]>;
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

/** Independent full-scan orchestration through the retained compatibility wrappers. */
function fullScan(files: ProjectFile[], revision = 0): AnalysisResult {
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

suite('Per-file cold analysis state', () => {
    let directory: string;
    let created: ProjectFile[];
    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-cold-'));
        created = [];
    });
    teardown(() => {
        for (const file of created) {
            if (fs.existsSync(file.path)) { fs.unlinkSync(file.path); }
        }
        fs.rmdirSync(directory);
    });

    function file(name: string, source: string): ProjectFile {
        const result: ProjectFile = {
            path: path.join(directory, name),
            language: name.endsWith('.java') ? 'java' : name.endsWith('.jsx') ? 'javascript' : 'typescript'
        };
        fs.writeFileSync(result.path, source);
        created.push(result);
        return result;
    }

    function fixture(): ProjectFile[] {
        return [
            file('Consumer.tsx', 'client.subscribe("/app/send", handler);\r\n' +
                'fetch(buildUrl(id));\r\nAPI.get("/items/static");\r\n' +
                'axios.get("/missing");\r\naxios.delete("/api/items/static");\r\n' +
                'axios.get("/api/items/42");\r\nclient.publish({destination: "/app/send"});'),
            file('Mixed.java', '@RestController\r\n@RequestMapping("/api")\r\nclass C {\r\n' +
                '@PostMapping("/items/static")\r\nvoid post() {}\r\n' +
                '@GetMapping("/items/{id}")\r\nvoid get() {}\r\n' +
                '@GetMapping("/items/static")\r\nvoid exact() {}\r\n' +
                '@MessageMapping("/send")\r\n@SendTo("/topic/messages")\r\nvoid send() {}\r\n}'),
            file('Definition.ts', 'const API = axios.create({baseURL: "/api"});'),
            file('Other.java', '@RestController\n@RequestMapping("/api")\nclass C {\n' +
                '@GetMapping("/items/{other}")\nvoid get() {}\n@MessageMapping("/send")\nvoid send() {}\n}'),
            file('Config.java', 'registry.setApplicationDestinationPrefixes("/app/");'),
            file('Empty.ts', 'export const unrelated = 1;'),
            file('Empty.java', 'class Empty {}'),
            file('Other.jsx', 'client.publish({destination: "/app/send"});\n' +
                'axios.get("/api/items/static");\nclient.subscribe("/topic/messages", handler);')
        ];
    }

    function serviceFor(files: ProjectFile[]) {
        const service = new AnalysisService();
        const internals = service as unknown as AnalysisInternals;
        let indexes = 0;
        internals.indexer.indexWorkspace = async () => { indexes++; return files; };
        return { service, internals, indexes: () => indexes };
    }

    test('cold result exactly matches full wrappers, diagnostics, usages and snapshot references', async () => {
        const files = fixture();
        const expected = fullScan(files);
        const { service } = serviceFor(files);
        const actual = await service.getAnalysis();
        assert.deepStrictEqual(actual, expected);
        assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));
        assert.deepStrictEqual(actual.diagnostics.map(item => item.code), ['FSL001', 'FSL002', 'FSL003', 'FSL004']);
        for (const match of actual.restMatches) {
            assert.ok(actual.restCalls.includes(match.call));
            for (const endpoint of match.candidateEndpoints ?? []) {
                assert.ok(actual.restEndpoints.includes(endpoint));
            }
        }
        for (const [endpoint, calls] of actual.restUsages) {
            assert.ok(actual.restEndpoints.includes(endpoint));
            assert.ok(calls.every(call => actual.restCalls.includes(call)));
        }
        for (const [endpoint, calls] of actual.websocketUsages) {
            assert.ok(actual.websocketEndpoints.includes(endpoint));
            assert.ok(calls.every(call => actual.websocketCalls.includes(call) && call.type === 'publish'));
        }
        assert.ok(actual.websocketMatches.every(match => match.endpoint === actual.websocketEndpoints[0]));
    });

    test('interleaved and reversed file orders preserve prefix selection and WebSocket first-match targets', async () => {
        const files = fixture();
        const alternate = file('Alternate.java', 'registry.setApplicationDestinationPrefixes("/alternate");');
        for (const order of [[...files, alternate], [alternate, ...files.slice().reverse()]]) {
            const { service } = serviceFor(order);
            assert.deepStrictEqual(await service.getAnalysis(), fullScan(order));
        }
        const { service } = serviceFor(files.slice().reverse());
        const result = await service.getAnalysis();
        assert.strictEqual(result.websocketMatches[0].endpoint?.filePath, files[3].path);
        assert.strictEqual(result.websocketEndpoints[0].inboundDestination, '/app/send');
    });

    test('cold loading reads every indexed file once; warm cache reads none; force rebuild rereads all', async () => {
        const files = fixture();
        const { service, internals, indexes } = serviceFor(files);
        const read = internals.readSource.bind(service);
        const reads: string[] = [];
        internals.readSource = async file => { reads.push(file.path); return read(file); };
        const first = await service.getAnalysis();
        assert.deepStrictEqual(reads, files.map(file => file.path));
        assert.strictEqual(indexes(), 1);
        assert.strictEqual(await service.getAnalysis(), first);
        assert.strictEqual(reads.length, 8);
        fs.appendFileSync(files[0].path, '\naxios.get("/fresh-route");');
        const forced = await service.getAnalysis(true);
        assert.strictEqual(forced.revision, first.revision + 1);
        assert.notStrictEqual(forced, first);
        assert.deepStrictEqual(forced, fullScan(files, forced.revision));
        assert.deepStrictEqual(reads, [...files, ...files].map(file => file.path));
        assert.strictEqual(indexes(), 2);
        console.log('[FSL test] 8 indexed files: cold=8 source reads, warm=0, forced rebuild=8');
    });

    test('content path succeeds after loading removes all source files and full-scan wrappers are forbidden', async () => {
        const files = fixture();
        const expected = fullScan(files);
        const { service, internals } = serviceFor(files);
        const read = internals.readSource.bind(service);
        let reads = 0;
        internals.readSource = async file => {
            const source = await read(file);
            if (++reads === files.length) {
                for (const item of files) { fs.unlinkSync(item.path); }
            }
            return source;
        };
        for (const scanner of [internals.springScanner, internals.frontendScanner,
            internals.springwebsocketScanner, internals.frontendWebSocketScanner]) {
            scanner.scan = () => { throw new Error('AnalysisService must use supplied content'); };
        }
        assert.deepStrictEqual(await service.getAnalysis(), expected);
        assert.strictEqual(reads, files.length);
    });

    test('per-file entries include mixed protocols and zero-entity files without retaining source text', async () => {
        const files = fixture();
        const { service, internals } = serviceFor(files);
        const analyze = internals.analyzeFiles.bind(service);
        let entries: FileAnalysis[] = [];
        internals.analyzeFiles = async files => { entries = await analyze(files); return entries; };
        await service.getAnalysis();
        assert.deepStrictEqual(entries.map(entry => entry.file), files);
        assert.strictEqual(entries[0].restCalls.length, 5);
        assert.strictEqual(entries[0].websocketCalls.length, 2);
        assert.strictEqual(entries[1].restEndpoints.length, 3);
        assert.strictEqual(entries[1].websocketEndpoints.length, 1);
        for (const entry of entries) {
            assert.deepStrictEqual(Object.keys(entry), [
                'file', 'restEndpoints', 'restCalls', 'websocketEndpoints', 'websocketCalls',
                'axiosInstances', 'applicationPrefix'
            ]);
        }
        for (const index of [2, 4, 5, 6]) {
            const entry = entries[index];
            assert.deepStrictEqual([entry.restEndpoints, entry.restCalls,
                entry.websocketEndpoints, entry.websocketCalls], [[], [], [], []]);
        }
    });

    test('cross-file Axios conflicts and local precedence match the full path in both definition orders', async () => {
        const files = [file('Consumer.ts', 'API.get("/items");'),
            file('One.ts', 'const API = axios.create({baseURL: "/one"});\nAPI.get("/items");'),
            file('Two.ts', 'const API = axios.create({baseURL: "/two"});\nAPI.get("/items");')];
        for (const order of [files, files.slice().reverse()]) {
            const { service } = serviceFor(order);
            const result = await service.getAnalysis();
            assert.deepStrictEqual(result, fullScan(order));
            assert.strictEqual(result.restCalls.find(call => call.filePath === files[0].path)?.resolution, 'unresolved');
            assert.strictEqual(result.restCalls.find(call => call.filePath === files[1].path)?.path, '/one/items');
        }
    });

    test('empty workspace performs no reads and produces the same empty snapshot', async () => {
        const { service, internals, indexes } = serviceFor([]);
        internals.readSource = async () => { throw new Error('Empty workspace must not read'); };
        assert.deepStrictEqual(await service.getAnalysis(), fullScan([]));
        assert.strictEqual(indexes(), 1);
    });

    test('invalidation during actual cold loading discards old content and shares a serialized rebuild', async () => {
        const files = [file('Changing.ts', 'axios.get("/old");')];
        const { service, internals, indexes } = serviceFor(files);
        const read = internals.readSource.bind(service);
        const started = deferred<void>(), release = deferred<void>();
        let reads = 0, active = 0, maxActive = 0;
        internals.readSource = async file => {
            active++; maxActive = Math.max(maxActive, active);
            try {
                const source = await read(file);
                if (++reads === 1) { started.resolve(); await release.promise; }
                return source;
            } finally { active--; }
        };
        const first = service.getAnalysis();
        const concurrent = service.getAnalysis();
        await started.promise;
        fs.writeFileSync(files[0].path, 'axios.get("/latest");');
        service.clearCache();
        assert.strictEqual(service.isCurrentRevision(0), false);
        const latest = service.getAnalysis();
        release.resolve();
        const [a, b, c] = await Promise.all([first, concurrent, latest]);
        assert.strictEqual(a, b);
        assert.strictEqual(a, c);
        assert.strictEqual(a.revision, 1);
        assert.deepStrictEqual(a, fullScan(files, 1));
        assert.strictEqual(a.restCalls[0].path, '/latest');
        assert.strictEqual(reads, 2);
        assert.strictEqual(indexes(), 2);
        assert.strictEqual(maxActive, 1);
        assert.strictEqual(await service.getAnalysis(), a);
    });

    test('a failed obsolete source load retries while a current source failure remains retryable', async () => {
        const files = [file('Source.ts', 'axios.get("/latest");')];
        const { service, internals } = serviceFor(files);
        const read = internals.readSource.bind(service);
        const started = deferred<void>(), gate = deferred<string>();
        let reads = 0;
        internals.readSource = async file => {
            if (++reads === 1) { started.resolve(); return gate.promise; }
            return read(file);
        };
        const first = service.getAnalysis();
        await started.promise;
        service.clearCache();
        gate.reject(new Error('obsolete read failed'));
        assert.deepStrictEqual(await first, fullScan(files, 1));
        service.clearCache();
        internals.readSource = async () => { throw new Error('current read failed'); };
        await assert.rejects(service.getAnalysis(), /current read failed/);
        internals.readSource = read;
        assert.deepStrictEqual(await service.getAnalysis(), fullScan(files, 2));
    });
});
