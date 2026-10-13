import * as assert from 'assert';
import { EndpointMatcher } from '../core/matching/EndPointMatcher';
import { RestDiagnosticAnalyzer } from '../core/analysis/RestDiagnosticAnalyzer';
import { HttpCall } from '../core/models/HttpCall';
import { HttpEndpoint } from '../core/models/HttpEndpoint';

const endpoint = (path: string, method = 'GET', line = 0): HttpEndpoint =>
    ({ path, method, filePath: 'Controller.java', line });
const call = (path: string, method = 'GET', line = 0): HttpCall =>
    ({ path, method, filePath: 'api.ts', line });

suite('REST route specificity', () => {
    const matcher = new EndpointMatcher();
    const analyzer = new RestDiagnosticAnalyzer();

    test('static wins in either endpoint order and with or without a usage map', () => {
        const staticRoute = endpoint('/api/chat/history');
        const dynamicRoute = endpoint('/api/chat/{userId}');
        for (const endpoints of [[dynamicRoute, staticRoute], [staticRoute, dynamicRoute]]) {
            for (const usages of [undefined, new Map<HttpEndpoint, HttpCall[]>()]) {
                const matches = matcher.match([call('/api/chat/history')], endpoints, usages);
                assert.strictEqual(matches[0].endpoint, staticRoute);
                assert.deepStrictEqual(matches[0].candidateEndpoints, [staticRoute]);
                assert.strictEqual(matches[0].matched, true);
                assert.deepStrictEqual(analyzer.analyze(matches, endpoints), []);
                if (usages) {
                    assert.strictEqual(usages.get(staticRoute)?.length, 1);
                    assert.ok(!usages.has(dynamicRoute));
                }
            }
        }
    });

    test('dynamic fallback accepts concrete paths and frontend template placeholders', () => {
        const dynamicRoute = endpoint('/api/chat/{userId}');
        const matches = matcher.match([
            call('/api/chat/123'), call('/api/chat/{UserId}')
        ], [endpoint('/api/chat/history'), dynamicRoute]);
        for (const result of matches) {
            assert.strictEqual(result.endpoint, dynamicRoute);
            assert.deepStrictEqual(result.candidateEndpoints, [dynamicRoute]);
        }
    });

    test('equally specific dynamic routes remain ambiguous with deterministic navigation', () => {
        const id = endpoint('/api/users/{id}');
        const userId = endpoint('/api/users/{userId}');
        for (const endpoints of [[id, userId], [userId, id]]) {
            const usages = new Map<HttpEndpoint, HttpCall[]>();
            const matches = matcher.match([call('/api/users/123')], endpoints, usages);
            assert.strictEqual(matches[0].endpoint, id);
            assert.deepStrictEqual(matches[0].candidateEndpoints, [id, userId]);
            assert.deepStrictEqual(analyzer.analyze(matches, endpoints).map(d => d.code), ['FSL003']);
            assert.strictEqual(usages.get(id)?.length, 1);
            assert.strictEqual(usages.get(userId)?.length, 1);
        }
    });

    test('trailing slash normalization does not affect specificity', () => {
        for (const backendPath of ['/api/chat/history', '/api/chat/history/']) {
            for (const frontendPath of ['/api/chat/history', '/api/chat/history/']) {
                const staticRoute = endpoint(backendPath);
                const matches = matcher.match([call(frontendPath)], [
                    endpoint('/api/chat/{userId}/'), staticRoute
                ]);
                assert.deepStrictEqual(matches[0].candidateEndpoints, [staticRoute]);
            }
        }
    });

    test('regex-style variables remain dynamic and lose to static routes', () => {
        const regexRoute = endpoint('/api/users/{id:\\d+}');
        const staticRoute = endpoint('/api/users/123');
        const matches = matcher.match([
            call('/api/users/123'), call('/api/users/456'), call('/api/users/{UserId}')
        ], [regexRoute, staticRoute]);
        assert.deepStrictEqual(matches.map(m => m.endpoint), [staticRoute, regexRoute, regexRoute]);
        assert.deepStrictEqual(matches[0].candidateEndpoints, [staticRoute]);
    });

    test('partial static routes outrank routes with more variables', () => {
        const specific = endpoint('/api/{group}/history');
        const fallback = endpoint('/api/{group}/{action}');
        const matches = matcher.match([call('/api/chat/history')], [fallback, specific]);
        assert.deepStrictEqual(matches[0].candidateEndpoints, [specific]);
    });

    test('equal static counts remain ambiguous even at different segment positions', () => {
        const endpoints = [endpoint('/api/chat/{action}'), endpoint('/api/{group}/history')];
        const matches = matcher.match([call('/api/chat/history')], endpoints);
        assert.strictEqual(matches[0].candidateEndpoints?.length, 2);
        assert.strictEqual(analyzer.analyze(matches, endpoints)[0].code, 'FSL003');
    });

    test('two history calls and one pending call never count toward the dynamic fallback', () => {
        const history = endpoint('/api/chat/history');
        const pending = endpoint('/api/chat/pending');
        const dynamic = endpoint('/api/chat/{userId}');
        const calls = [call(history.path, 'GET', 1), call(history.path, 'GET', 2), call(pending.path)];
        const usages = new Map<HttpEndpoint, HttpCall[]>();
        matcher.match(calls, [dynamic, history, pending], usages);
        assert.deepStrictEqual(usages.get(history), calls.slice(0, 2));
        assert.deepStrictEqual(usages.get(pending), calls.slice(2));
        assert.strictEqual(usages.get(dynamic)?.length ?? 0, 0);
        const fallback = call('/api/chat/123');
        matcher.match([fallback], [dynamic, history, pending], usages);
        assert.deepStrictEqual(usages.get(dynamic), [fallback]);
    });

    test('FSL001 and FSL002 remain correct; specificity compares only same-method routes', () => {
        const endpoints = [endpoint('/api/chat/history', 'POST'), endpoint('/api/chat/{id}')];
        const matches = matcher.match([
            call('/api/missing'), call('/api/chat/history', 'DELETE'), call('/api/chat/history')
        ], endpoints);
        assert.strictEqual(matches[0].matched, false);
        assert.strictEqual(matches[0].endpoint, undefined);
        assert.deepStrictEqual(matches[0].candidateEndpoints, []);
        assert.deepStrictEqual(matches[1].candidateEndpoints, []);
        assert.strictEqual(matches[2].endpoint, endpoints[1]);
        assert.deepStrictEqual(analyzer.analyze(matches, endpoints).map(d => d.code), ['FSL001', 'FSL002']);
    });

    test('duplicate static routes remain ambiguous with a stable file and line tie-break', () => {
        const first = endpoint('/api/chat/history', 'GET', 3);
        const second = endpoint('/api/chat/history', 'GET', 8);
        const third = { ...first, filePath: 'OtherController.java' };
        const endpoints = [third, second, first, endpoint('/api/chat/{id}')];
        const matches = matcher.match([call('/api/chat/history')], endpoints);
        assert.strictEqual(matches[0].endpoint, first);
        assert.deepStrictEqual(matches[0].candidateEndpoints, [first, second, third]);
        assert.strictEqual(analyzer.analyze(matches, endpoints)[0].code, 'FSL003');
    });
});
