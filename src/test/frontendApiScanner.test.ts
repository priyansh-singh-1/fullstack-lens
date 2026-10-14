import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrontendApiScanner } from '../core/parsing/frontend/FrontendApiScanner';
import { EndpointMatcher } from '../core/matching/EndPointMatcher';
import { RestDiagnosticAnalyzer } from '../core/analysis/RestDiagnosticAnalyzer';

suite('Frontend API template resolution', () => {
    let directory: string;
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-scanner-')); });
    teardown(() => {
        for (const file of fs.readdirSync(directory)) {
            fs.unlinkSync(path.join(directory, file));
        }
        fs.rmdirSync(directory);
    });

    function scan(content: string) {
        const file = path.join(directory, 'api.ts');
        fs.writeFileSync(file, content);
        return new FrontendApiScanner().scan([{ path: file, language: 'typescript' }]);
    }

    test('direct instance concatenation preserves the identifier without capturing the call terminator', () => {
        const calls = scan('const API = axios.create({ baseURL: "/api" });\nAPI.get("/users/" + UserId);');
        assert.deepStrictEqual(calls.map(call => [call.path, call.resolution, call.line]), [
            ['/api/users/{UserId}', 'resolved', 1]
        ]);
    });

    const cases: [string, string, 'resolved' | 'partial'][] = [
        ['"/users/" + UserId', '/users/{UserId}', 'resolved'],
        ['"/users/" + id', '/users/{id}', 'resolved'],
        ['"/users/" + getId()', '/users/{dynamic}', 'partial'],
        ['"/users/" + user.id', '/users/{dynamic}', 'partial'],
        ['`/users/${id}`', '/users/{id}', 'resolved'],
        ['`/users/${getId()}`', '/users/{getId()}', 'partial'],
        ['"/users/" + getId(a, nested(b, c))', '/users/{dynamic}', 'partial'],
        ['"/users/" + getId(")", ",", "a+b")', '/users/{dynamic}', 'partial'],
        ['"/users/" + (id)', '/users/{dynamic}', 'partial'],
        ['"/users/" + ids[index]', '/users/{dynamic}', 'partial'],
        ['"/users/" + getId({ key: [a, b] })', '/users/{dynamic}', 'partial'],
        ['`/users/${getId("x,y", nested(id))}`', '/users/{getId("x,y", nested(id))}', 'partial'],
        ['"/users/" + getId(`key-${id}`)', '/users/{dynamic}', 'partial'],
        ['"/users/" + id + "?filter=" + getFilter(a, b)', '/users/{id}', 'resolved'],
        ['`/users/${id}?filter=${getFilter(a, b)}`', '/users/{id}', 'resolved'],
        ['"/users?filter=" + user.filter', '/users', 'resolved'],
        ['"/users?filter=" + getFilter("a+b", nested(a, b))', '/users', 'resolved'],
        ['"/users/" + getId() + "?filter=" + id', '/users/{dynamic}', 'partial'],
        ['"/users#" + getId()', '/users', 'resolved'],
        ['"/users"', '/users', 'resolved'],
        ["'/users'", '/users', 'resolved'],
        ['`/users`', '/users', 'resolved'],
        ['"/users" + "/active"', '/users/active', 'resolved'],
        ['"/users/a+b,c)"', '/users/a+b,c)', 'resolved'],
        ['"/users/" + id + "/posts/" + postId', '/users/{id}/posts/{postId}', 'resolved'],
        ['"/users/" + getId(/* ), + */ a, b)', '/users/{dynamic}', 'partial'],
        ['"/users/" + getId(\n a, // ), +\n b\n)', '/users/{dynamic}', 'partial'],
    ];

    for (const [expression, route, resolution] of cases) {
        test(`instance first argument: ${expression}`, () => {
            for (const baseURL of ['/', '/api', 'https://example.test/api']) {
                const prefix = baseURL === '/' ? '' : '/api';
                // Check both a terminating ')' and a second Axios argument.
                for (const config of ['', ', { params: { page: 1 } }']) {
                    const calls = scan(`const API = axios.create({ baseURL: "${baseURL}" });\n` +
                        `API.get(${expression}${config});\n`);
                    assert.strictEqual(calls.length, 1);
                    assert.deepStrictEqual([calls[0].path, calls[0].resolution, calls[0].line],
                        [prefix + route, resolution, 1]);
                    const endpoints = [{ method: 'GET', path: prefix + route,
                        filePath: 'Controller.java', line: 0 }];
                    const matches = new EndpointMatcher().match(calls, endpoints);
                    assert.strictEqual(matches[0].matched, resolution === 'resolved');
                    assert.deepStrictEqual(new RestDiagnosticAnalyzer().analyze(matches, endpoints)
                        .map(d => d.code), resolution === 'partial' ? ['FSL004'] : []);
                }
            }
        });
    }

    test('multiline calls preserve method and source line and do not consume following calls', () => {
        const calls = scan('const API = axios.create({ baseURL: "/api" });\n' +
            'API.post(\n "/users/" +\n id, { name: "test" }); API.delete("/users/" + UserId);\n');
        assert.deepStrictEqual(calls.map(call => [call.method, call.path, call.resolution, call.line]), [
            ['POST', '/api/users/{id}', 'resolved', 1],
            ['DELETE', '/api/users/{UserId}', 'resolved', 3]
        ]);
    });

    test('unterminated strings and unbalanced first arguments are skipped', () => {
        for (const expression of ['"/users/" + getId(', '"/users', '"/users/" + getId(]',
            '"/users/" +', '"/users/" + + id']) {
            assert.deepStrictEqual(scan('const API = axios.create({ baseURL: "/api" });\n' +
                `API.get(${expression});`), []);
        }
    });

    test('scanned calls retain static precedence and FSL001/FSL002/FSL003/FSL004', () => {
        const calls = scan('const API = axios.create({ baseURL: "/api" });\n' +
            'API.get("/users/active");\nAPI.get("/missing");\nAPI.delete("/users/" + id);\n' +
            'API.get("/users/" + id);\nAPI.get("/users/" + getId());');
        const endpoints = ['/api/users/{id}', '/api/users/{UserId}', '/api/users/active']
            .map(path => ({ method: 'GET', path, filePath: 'Controller.java', line: 0 }));
        const matches = new EndpointMatcher().match(calls, endpoints);
        assert.deepStrictEqual(matches[0].candidateEndpoints, [endpoints[2]]);
        assert.deepStrictEqual(new RestDiagnosticAnalyzer().analyze(matches, endpoints)
            .map(d => d.code), ['FSL001', 'FSL002', 'FSL003', 'FSL004']);
    });

    test('literal and simple-identifier Axios URLs remain resolved with correct paths and lines', () => {
        const calls = scan('axios.get("/api/users");\naxios.post(`/api/users/${userId}`);\n');
        assert.deepStrictEqual(calls.map(call => [call.method, call.path, call.line, call.resolution]), [
            ['GET', '/api/users', 0, 'resolved'],
            ['POST', '/api/users/{userId}', 1, 'resolved']
        ]);
    });

    test('complex expressions are partial for both Axios and fetch', () => {
        const calls = scan('axios.get(`/api/users/${user.id}`);\n' +
            'fetch(`/api/users/${userId}`);\nfetch(`/api/users/${getId()}`);\n');
        assert.deepStrictEqual(calls.map(call => [call.path, call.line, call.resolution]), [
            ['/api/users/{user.id}', 0, 'partial'],
            ['/api/users/{userId}', 1, 'resolved'],
            ['/api/users/{getId()}', 2, 'partial']
        ]);
    });

    test('Axios instance resolution includes expressions from the base URL and call URL', () => {
        const calls = scan('const api = axios.create({ baseURL: "/api" });\n' +
            'const tenantClient = axios.create({ baseURL: `/api/${tenant.id}` });\n' +
            'api.get(`/users/${userId}`);\napi.post(`/users/${user.id}`);\n' +
            'tenantClient.get("/users");\n');
        assert.deepStrictEqual(calls.map(call => [call.method, call.path, call.line, call.resolution]), [
            ['GET', '/api/users/{userId}', 2, 'resolved'],
            ['POST', '/api/users/{user.id}', 3, 'partial'],
            ['GET', '/api/{tenant.id}/users', 4, 'partial']
        ]);
    });
});
