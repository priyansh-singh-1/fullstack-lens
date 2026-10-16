import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectFile } from '../core/models/ProjectFile';
import { FrontendApiScanner } from '../core/parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../core/parsing/frontend/FrontendWebSocketScanner';
import { SpringEndpointScanner } from '../core/parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../core/parsing/spring/SpringWebSocketScanner';

suite('Content-based scanner equivalence', () => {
    let directory: string;
    let sources: Map<ProjectFile, string>;
    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-content-'));
        sources = new Map();
    });
    teardown(() => {
        for (const file of sources.keys()) {
            if (fs.existsSync(file.path)) { fs.unlinkSync(file.path); }
        }
        fs.rmdirSync(directory);
    });

    function file(name: string, source: string, language?: ProjectFile['language']): ProjectFile {
        const file = {
            path: path.join(directory, name),
            language: language ?? (name.endsWith('.java') ? 'java' : 'typescript')
        };
        sources.set(file, source);
        fs.writeFileSync(file.path, source);
        return file;
    }

    // Remove every fixture after the compatibility scan: content APIs must need no disk access.
    function removeSources() {
        for (const file of sources.keys()) { fs.unlinkSync(file.path); }
    }

    function restCalls(files: ProjectFile[]) {
        const scanner = new FrontendApiScanner();
        const instances = files.flatMap(file => scanner.discoverAxiosInstances(file, sources.get(file)!));
        return files.flatMap(file => scanner.scanFile(file, sources.get(file)!, instances));
    }

    function socketEndpoints(files: ProjectFile[]) {
        const scanner = new SpringWebSocketScanner();
        const prefix = files.map(file => scanner.discoverApplicationPrefix(file, sources.get(file)!))
            .find(value => value !== undefined) ?? '';
        return files.flatMap(file => scanner.scanFile(file, sources.get(file)!, prefix));
    }

    test('REST endpoints preserve file, annotation-group, method, path and CRLF line ordering', () => {
        const first = file('First.java', '@RestController\r\n@RequestMapping("/api/")\r\nclass C {\r\n' +
            '@PostMapping("/users")\r\nvoid post() {}\r\n@GetMapping("/users/{id}")\r\nvoid get() {}\r\n' +
            '// @GetMapping("/ignored")\r\n@PatchMapping("/users/{id}")\r\nvoid patch() {}\r\n}');
        const second = file('Second.java', '@RestController\nclass C {\n@DeleteMapping("/users")\nvoid x() {}\n}');
        const files = [first, file('Ignored.java', '// @RestController\n@GetMapping("/ghost")'),
            file('frontend.ts', '@RestController\n@GetMapping("/ghost")'), second];
        const scanner = new SpringEndpointScanner();
        const expected = scanner.scan(files);
        assert.deepStrictEqual(expected.map(e => [e.method, e.path, e.line]), [
            ['GET', '/api/users/{id}', 5], ['POST', '/api/users', 3],
            ['PATCH', '/api/users/{id}', 8], ['DELETE', '/users', 2]
        ]);
        removeSources();
        assert.deepStrictEqual(files.flatMap(file => scanner.scanFile(file, sources.get(file)!)), expected);
    });

    test('REST calls preserve direct, instance and fetch ordering and all resolution states', () => {
        const files = [file('calls.tsx', 'const API = axios.create({ baseURL: "/api" });\r\n' +
            'fetch("/fetch", { method: "post" });\r\nAPI.get("/users/" + UserId);\r\n' +
            'axios.put(`/users/${id}`);\r\nAPI.delete("/users/" + getId(a, b));\r\n' +
            'fetch(buildUrl(id));\r\naxios.patch("https://test.invalid/items?q=1");\r\n' +
            '// axios.get("/ignored");\r\nAPI.get("https://test.invalid/absolute");'),
        file('calls.js', 'axios.get("/other");\nfetch(`/items/${getId()}`);', 'javascript')];
        const expected = new FrontendApiScanner().scan(files);
        assert.deepStrictEqual(expected.map(c => [c.method, c.path, c.line, c.resolution]), [
            ['PUT', '/users/{id}', 3, 'resolved'], ['PATCH', '/items', 6, 'resolved'],
            ['GET', '/api/users/{UserId}', 2, 'resolved'], ['DELETE', '/api/users/{dynamic}', 4, 'partial'],
            ['GET', '/absolute', 8, 'resolved'], ['POST', '/fetch', 1, 'resolved'],
            ['GET', 'buildUrl(id)', 5, 'unresolved'], ['GET', '/other', 0, 'resolved'],
            ['GET', '/items/{getId()}', 1, 'partial']
        ]);
        removeSources();
        assert.deepStrictEqual(restCalls(files), expected);
    });

    test('cross-file Axios definitions apply even when the consumer precedes its definition', () => {
        const consumer = file('consumer.ts', 'API.get("/users");\nAPI.post("/users/" + id);');
        const definition = file('definition.ts', 'const API = axios.create({ baseURL: "https://test.invalid/api" });');
        const ignored = file('Ignored.java', 'const API = axios.create({ baseURL: "/wrong" });');
        const orders = [[consumer, ignored, definition], [definition, consumer, ignored]];
        const expected = orders.map(files => new FrontendApiScanner().scan(files));
        assert.deepStrictEqual(expected[0].map(c => c.path), ['/api/users', '/api/users/{id}']);
        removeSources();
        orders.forEach((files, index) => assert.deepStrictEqual(restCalls(files), expected[index]));
    });

    test('Axios conflicts and local precedence preserve results under reversed workspace order', () => {
        const one = file('one.ts', 'const API = axios.create({ baseURL: "/one" });\nAPI.get("/users");');
        const two = file('two.ts', 'const API = axios.create({ baseURL: "/two" });\nAPI.get("/users");');
        const consumer = file('consumer.ts', 'API.get("/users");\nAPI.get("https://test.invalid/absolute");');
        const orders = [[one, two, consumer], [consumer, two, one]];
        const expected = orders.map(files => new FrontendApiScanner().scan(files));
        assert.deepStrictEqual(expected[0].map(c => [c.path, c.resolution]), [
            ['/one/users', 'resolved'], ['/two/users', 'resolved'],
            ['/one/users', 'unresolved'], ['/absolute', 'resolved']
        ]);
        removeSources();
        orders.forEach((files, index) => assert.deepStrictEqual(restCalls(files), expected[index]));
    });

    test('Axios partial and unresolved base definitions retain resolution and absolute overrides', () => {
        const files = [file('definitions.ts', 'const PART = axios.create({ baseURL: "/api/" + getTenant() });\n' +
            'const UNKNOWN = axios.create({ baseURL: getBase() });'),
        file('consumer.ts', 'PART.get("/users");\nUNKNOWN.get("/users");\n' +
            'PART.get("https://test.invalid/absolute");\nUNKNOWN.get("https://test.invalid/absolute");')];
        const expected = new FrontendApiScanner().scan(files);
        assert.deepStrictEqual(expected.map(c => [c.path, c.resolution]), [
            ['/api/{dynamic}/users', 'partial'], ['/absolute', 'resolved'],
            ['/users', 'unresolved'], ['/absolute', 'resolved']
        ]);
        removeSources();
        assert.deepStrictEqual(restCalls(files), expected);
    });

    test('WebSocket endpoints preserve first workspace prefix, separate mappings and outbound destinations', () => {
        const mapping = file('First.java', 'class C {\r\n@MessageMapping("/chat.send")\r\n' +
            '@SendTo("/topic/messages")\r\nvoid x() {}\r\n}');
        const config = file('Config.java', 'registry.setApplicationDestinationPrefixes("/app/");\n' +
            'registry.setApplicationDestinationPrefixes("/ignored");');
        const second = file('Second.java', '@MessageMapping("notify")\nvoid y() {}');
        const alternate = file('Alternate.java', 'registry.setApplicationDestinationPrefixes("/alternate");');
        const ignored = file('config.ts', 'registry.setApplicationDestinationPrefixes("/wrong");');
        const orders = [[mapping, ignored, config, second, alternate], [alternate, second, config, mapping]];
        const expected = orders.map(files => new SpringWebSocketScanner().scan(files));
        assert.deepStrictEqual(expected[0].map(e => [e.inboundDestination, e.outboundDestination, e.line]), [
            ['/app/chat.send', '/topic/messages', 1], ['/app/notify', undefined, 0]
        ]);
        assert.deepStrictEqual(expected[1].map(e => e.inboundDestination),
            ['/alternate/notify', '/alternate/chat.send']);
        removeSources();
        orders.forEach((files, index) => assert.deepStrictEqual(socketEndpoints(files), expected[index]));
    });

    test('WebSocket mappings preserve empty-prefix fallback and nearby SendTo lookup', () => {
        const files = [file('Mapping.java', '@MessageMapping("send")\nvoid x() {}\n' +
            '@MessageMapping("/next")\n@SendTo("/topic/next")\nvoid y() {}')];
        const expected = new SpringWebSocketScanner().scan(files);
        assert.deepStrictEqual(expected.map(e => [e.inboundDestination, e.outboundDestination, e.line]), [
            ['/send', '/topic/next', 0], ['/next', '/topic/next', 2]
        ]);
        removeSources();
        assert.deepStrictEqual(socketEndpoints(files), expected);
    });

    test('WebSocket calls retain publish-before-subscribe ordering, types and CRLF lines', () => {
        const first = file('socket.jsx', 'client.subscribe("/topic/first", handler);\r\n' +
            'client.publish({ destination: "/app/first" });\r\n' +
            'client.subscribe("/app/first", handler);\r\nclient.publish({destination: `/app/second`});', 'javascript');
        const files = [first, file('Ignored.java', 'client.publish({destination: "/ignored"});'),
            file('other.ts', 'client.subscribe("/topic/other", handler);')];
        const scanner = new FrontendWebSocketScanner();
        const expected = scanner.scan(files);
        assert.deepStrictEqual(expected.map(c => [c.type, c.destination, c.line]), [
            ['publish', '/app/first', 1], ['publish', '/app/second', 3],
            ['subscribe', '/topic/first', 0], ['subscribe', '/app/first', 2],
            ['subscribe', '/topic/other', 0]
        ]);
        removeSources();
        assert.deepStrictEqual(files.flatMap(file => scanner.scanFile(file, sources.get(file)!)), expected);
    });

    test('empty workspaces and unsupported file languages remain empty', () => {
        const unsupported = file('raw.tsx', 'axios.get("/users");\n@MessageMapping("/send")', 'tsx');
        const api = new FrontendApiScanner();
        const socket = new SpringWebSocketScanner();
        assert.deepStrictEqual(api.scan([]), []);
        assert.deepStrictEqual(socket.scan([]), []);
        assert.deepStrictEqual(new SpringEndpointScanner().scan([]), []);
        assert.deepStrictEqual(new FrontendWebSocketScanner().scan([]), []);
        removeSources();
        assert.deepStrictEqual(api.discoverAxiosInstances(unsupported, sources.get(unsupported)!), []);
        assert.deepStrictEqual(api.scanFile(unsupported, sources.get(unsupported)!, []), []);
        assert.strictEqual(socket.discoverApplicationPrefix(unsupported, sources.get(unsupported)!), undefined);
        assert.deepStrictEqual(socket.scanFile(unsupported, sources.get(unsupported)!, ''), []);
    });
});
