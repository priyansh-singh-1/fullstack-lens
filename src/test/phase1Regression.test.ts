import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrontendApiScanner } from '../core/parsing/frontend/FrontendApiScanner';
import { SpringEndpointScanner } from '../core/parsing/spring/SpringEndpointScanner';
import { FrontendWebSocketScanner } from '../core/parsing/frontend/FrontendWebSocketScanner';
import { SpringWebSocketScanner } from '../core/parsing/spring/SpringWebSocketScanner';
import { WebSocketMatcher } from '../core/matching/WebSocketMatcher';
import { EndpointMatcher } from '../core/matching/EndPointMatcher';
import { RestDiagnosticAnalyzer } from '../core/analysis/RestDiagnosticAnalyzer';
import { ProjectFile } from '../core/models/ProjectFile';
import { WebSocketEndpoint } from '../core/models/WebSocketEndpoint';
import { WebSocketCall } from '../core/models/WebSocketCall';

suite('Phase 1 scanner regressions', () => {
    let directory: string;
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-phase1-')); });
    teardown(() => {
        for (const name of fs.readdirSync(directory)) { fs.unlinkSync(path.join(directory, name)); }
        fs.rmdirSync(directory);
    });
    function file(name: string, source: string): ProjectFile {
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, source);
        return { path: filePath, language: name.endsWith('.java') ? 'java' : 'typescript' };
    }
    function scan(source: string) {
        return new FrontendApiScanner().scan([file('api.ts', source)]);
    }

    test('Spring CRUD annotations and direct Axios preserve methods, CRLF lines and valid diagnostics', () => {
        const endpoints = new SpringEndpointScanner().scan([file('Controller.java',
            '@RestController\r\n@RequestMapping("/api")\r\nclass C {\r\n' +
            '@GetMapping("/users")\r\nvoid a() {}\r\n@PostMapping("/users")\r\nvoid b() {}\r\n' +
            '@PutMapping("/users/{id}")\r\nvoid c() {}\r\n@DeleteMapping("/users/{userId}")\r\nvoid d() {}\r\n}')]);
        assert.deepStrictEqual(endpoints.map(e => [e.method, e.path, e.line]), [
            ['GET', '/api/users', 3], ['POST', '/api/users', 5],
            ['PUT', '/api/users/{id}', 7], ['DELETE', '/api/users/{userId}', 9]
        ]);
        const calls = scan('axios.get("/api/users?sort=name");\r\naxios.post("/api/users/");\r\n' +
            'axios.put(`/api/users/${id}`);\r\naxios.delete("/api/users/" + UserId);');
        assert.deepStrictEqual(calls.map(c => c.line), [0, 1, 2, 3]);
        assert.deepStrictEqual(new RestDiagnosticAnalyzer().analyze(
            new EndpointMatcher().match(calls, endpoints), endpoints), []);
    });

    test('direct Axios and fetch share string, template, concatenation and complex query handling', () => {
        const expressions = [
            ['"/api/users?sort=name"', '/api/users', 'resolved'],
            ['`/api/users/${UserId}`', '/api/users/{UserId}', 'resolved'],
            ['"/api/users/" + id', '/api/users/{id}', 'resolved'],
            ['"/api/users/" + getId(a, b)', '/api/users/{dynamic}', 'partial'],
            ['`/api/users?filter=${choose(a, b)}`', '/api/users', 'resolved'],
            ['"/api/users?filter=" + choose(a, b)', '/api/users', 'resolved'],
        ];
        for (const caller of ['axios.get', 'fetch']) {
            for (const [expression, route, resolution] of expressions) {
                const calls = scan(`${caller}(${expression});`);
                assert.deepStrictEqual(calls.map(c => [c.path, c.resolution]), [[route, resolution]]);
            }
        }
    });

    test('fetch options detect every implemented HTTP method without reading nested properties', () => {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
            assert.strictEqual(scan(`fetch("/api/users", { method: "${method.toLowerCase()}" });`)[0].method, method);
        }
        assert.strictEqual(scan('fetch("/api/users");')[0].method, 'GET');
        assert.strictEqual(scan('fetch("/api/users", { headers: { method: "DELETE" } });')[0].method, 'GET');
        assert.strictEqual(scan('fetch("/api/users", { method: "POST", headers: { method: "DELETE" } });')[0].method, 'POST');
        assert.strictEqual(scan('fetch("/api/users", { /* config */ method: /* value */ "PATCH" });')[0].method, 'PATCH');
    });

    test('unsupported whole URL expressions produce FSL004 rather than disappearing', () => {
        for (const caller of ['axios.get', 'fetch', 'API.get']) {
            const calls = scan('const API = axios.create({ baseURL: "/api" });\n' + `${caller}(buildUrl(id));`);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].resolution, 'unresolved');
            assert.deepStrictEqual(new RestDiagnosticAnalyzer().analyze(
                new EndpointMatcher().match(calls, []), []).map(d => d.code), ['FSL004']);
        }
    });

    test('template operators and nested braces never truncate the pathname or resolve complex expressions', () => {
        for (const expression of ['`/api/users/${flag ? id : other}`', '`/api/users/${({ id }).id}`',
            '`/api/users/${lookup({ key: id })}`']) {
            const call = scan(`axios.get(${expression});`)[0];
            assert.strictEqual(call.resolution, 'partial');
            assert.ok(call.path.startsWith('/api/users/'));
            assert.ok(call.path.endsWith('}'), call.path);
        }
        const absolute = scan('axios.get(`https://example.test/api/users/${flag ? id : other}`);')[0];
        assert.strictEqual(absolute.path, '/api/users/{flag ? id : other}');
        assert.strictEqual(absolute.resolution, 'partial');
    });

    test('malformed URL escapes do not throw or turn an absolute URL into a pathname', () => {
        assert.deepStrictEqual(scan('axios.get("https://example.test/api/%broken");\n' +
            'fetch("/api/%broken");').map(c => c.path), ['/api/%broken', '/api/%broken']);
    });

    test('Axios baseURL expressions are parsed completely and absolute call URLs override the base', () => {
        for (const [base, route, resolution] of [
            ['"/api" + "/v1"', '/api/v1/users', 'resolved'],
            ['"/api/" + tenant', '/api/{tenant}/users', 'resolved'],
            ['"/api/" + getTenant()', '/api/{dynamic}/users', 'partial'],
            ['getBase()', '/users', 'unresolved'],
        ]) {
            const calls = scan(`const API = axios.create({ baseURL: ${base} });\nAPI.get("/users");`);
            assert.deepStrictEqual(calls.map(c => [c.path, c.resolution]), [[route, resolution]]);
        }
        const absolute = scan('const API = axios.create({ baseURL: "/api" });\nAPI.get("https://example.test/users?q=1");');
        assert.strictEqual(absolute[0].path, '/users');
        const commented = scan('const API = axios.create({ /* config */ baseURL: /* value */ "/api" });\nAPI.get("/users");');
        assert.strictEqual(commented[0].path, '/api/users');
    });

    test('same-named local Axios instances do not duplicate scans or leak base URLs across files', () => {
        const files = [file('one.ts', 'const API = axios.create({ baseURL: "/one" });\nAPI.get("/users");'),
            file('two.ts', 'const API = axios.create({ baseURL: "/two" });\nAPI.get("/users");')];
        for (const order of [files, [...files].reverse()]) {
            const calls = new FrontendApiScanner().scan(order);
            assert.strictEqual(calls.length, 2);
            assert.deepStrictEqual(calls.map(c => c.path).sort(), ['/one/users', '/two/users']);
        }
        const imported = file('consumer.ts', 'API.get("/users");');
        for (const order of [[...files, imported], [imported, ...files].reverse()]) {
            const calls = new FrontendApiScanner().scan(order).filter(c => c.filePath === imported.path);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].resolution, 'unresolved');
        }
    });

    test('call names require identifier boundaries and ignore comments and string examples', () => {
        const calls = scan('// axios.get("/comment");\n/* fetch("/block"); */\n' +
            'const example = \'axios.get("/example")\';\nconst other = `fetch("/template")`;\n' +
            'notaxios.get("/suffix"); prefetch("/suffix");\n' +
            'const API = axios.create({ baseURL: "/api" });\nOTHER_API.get("/suffix");\nAPI.get("/users");');
        assert.deepStrictEqual(calls.map(c => [c.path, c.line]), [['/api/users', 7]]);
        const interpolation = scan('const text = `result: ${fetch("/api/users")}`;');
        assert.deepStrictEqual(interpolation.map(c => [c.path, c.line]), [['/api/users', 0]]);
    });

    test('Spring ignores commented controllers and mappings without shifting annotation lines', () => {
        assert.deepStrictEqual(new SpringEndpointScanner().scan([file('Disabled.java',
            '// @RestController\nclass C { @GetMapping("/ghost") void x() {} }')]), []);
        const endpoints = new SpringEndpointScanner().scan([file('Controller.java',
            '@RestController\n// @RequestMapping("/ghost")\n@RequestMapping("/api")\nclass C {\n' +
            '/* @GetMapping("/ghost") */\n@GetMapping("/users")\nvoid x() {}\n}')]);
        assert.deepStrictEqual(endpoints.map(e => [e.path, e.line]), [['/api/users', 5]]);
        const regex = new SpringEndpointScanner().scan([file('Regex.java',
            '@RestController\nclass C {\n@GetMapping("/api/users/{id:\\\\d{1,3}}")\nvoid x() {}\n}')]);
        assert.strictEqual(regex.length, 1);
        assert.strictEqual(new EndpointMatcher().pathMatch('/api/users/123', regex[0].path), true);
    });

    test('dynamic backend segments cannot match an empty pathname segment', () => {
        const matcher = new EndpointMatcher();
        assert.strictEqual(matcher.pathMatch('/api//details', '/api/{id}/details'), false);
        assert.strictEqual(matcher.pathMatch('/api/42/details', '/api/{id:\\d{1,3}}/details'), true);
    });

    test('STOMP subscriptions remain scanned but never inflate publish matches or reverse usages', () => {
        const files = [file('socket.ts', 'client.publish({destination: "/app/chat.send"});\n' +
            'client.subscribe("/topic/messages", handler);\nclient.subscribe("/app/chat.send", handler);'),
        file('Socket.java', 'class Config { void x() { registry.setApplicationDestinationPrefixes("/app"); } }\n' +
            'class C {\n@MessageMapping("/chat.send")\n@SendTo("/topic/messages")\nvoid chat() {}\n}')];
        const calls = new FrontendWebSocketScanner().scan(files);
        const endpoints = new SpringWebSocketScanner().scan(files);
        assert.deepStrictEqual(calls.map(c => [c.type, c.line]), [['publish', 0], ['subscribe', 1], ['subscribe', 2]]);
        assert.deepStrictEqual(endpoints.map(e => [e.inboundDestination, e.outboundDestination, e.line]),
            [['/app/chat.send', '/topic/messages', 2]]);
        const usages = new Map<WebSocketEndpoint, WebSocketCall[]>();
        const matches = new WebSocketMatcher().match(calls, endpoints, usages);
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].endpoint, endpoints[0]);
        assert.deepStrictEqual(usages.get(endpoints[0]), [calls[0]]);
    });
});
