import { describe, it, expect } from 'vitest';
import { UA, EMAIL } from './comments-test-utils';
import { MAX_AUTHOR_NAME_LENGTH, MAX_CONTENT_LENGTH, isValidEmail, normalizePagePath, normalizeWebsite, sanitizeAuthorName, validateSubmitInput } from './validate';
import { gravatarHash } from './client-info';
import { UAParser } from 'ua-parser-js';

describe('input validation helpers', () => {
	it('validateSubmitInput enforces email and normalizes website', () => {
		const ok = validateSubmitInput({ content: 'hi', path: '/a', email: 'A@Test.dev' });
		expect(ok.ok && ok.data.email === 'a@test.dev').toBe(true);

		const noEmail = validateSubmitInput({ content: 'hi', path: '/a' });
		expect(noEmail.ok).toBe(false);

		const website = normalizeWebsite('example.com/x');
		expect(website).toBe('https://example.com/x');
		expect(normalizeWebsite('')).toBeNull();
		expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
		expect(isValidEmail('a@b.dev')).toBe(true);
		expect(isValidEmail('a@b')).toBe(false);
	});

	it('normalizePagePath and sanitizeAuthorName stay strict', () => {
		expect(normalizePagePath('/a/?x=1')).toBe('/a');
		expect(normalizePagePath('a')).toBeNull();
		expect(sanitizeAuthorName('  A '.repeat(30)).length).toBeLessThanOrEqual(
			MAX_AUTHOR_NAME_LENGTH
		);
		expect(
			validateSubmitInput({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1), path: '/a', email: EMAIL })
				.ok
		).toBe(false);
	});
});

describe('client info helpers (framework UAParser + ip-region + gravatar)', () => {
	it('hashes emails for gravatar; raw UA strings yield null env fields', () => {
		expect(gravatarHash('A@B.dev')).toBe(gravatarHash('a@b.dev'));
		expect(gravatarHash('a@b.dev')).toMatch(/^[0-9a-f]{32}$/);
		expect(gravatarHash(null)).toBeNull();

		// 无法识别的 UA（如 vitest）→ UAParser 解析为空 → 入库留空，不臆造
		expect(new UAParser('vitest').getOS().name ?? null).toBeNull();
	});
});
