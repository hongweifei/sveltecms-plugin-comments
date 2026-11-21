import { describe, it, expect } from 'vitest';
import { UA, EMAIL } from './comments-test-utils';
import {
	MAX_AUTHOR_NAME_LENGTH,
	MAX_CONTENT_LENGTH,
	decodePagePath,
	isValidEmail,
	normalizePagePath,
	normalizeWebsite,
	pathToHref,
	sanitizeAuthorName,
	validateSubmitInput
} from './validate';
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

	it('normalizePagePath decodes percent-encoded segments into readable text', () => {
		const encoded = '/article/%E7%BD%91%E7%BB%9C%E5%AE%89%E5%85%A8';
		expect(normalizePagePath(encoded)).toBe('/article/网络安全');
		// 已是原文的路径保持原样；尾斜杠折叠
		expect(normalizePagePath('/article/网络安全/')).toBe('/article/网络安全');
		expect(normalizePagePath('/a%20b')).toBe('/a b');
		// 段内分隔符编码不还原：解码不能改变路径结构
		expect(normalizePagePath('/a%2Fb')).toBe('/a%2Fb');
		// 非法编码序列原样保留，不抛错不吞字符
		expect(normalizePagePath('/100%off')).toBe('/100%off');
		expect(decodePagePath('no-escapes')).toBe('no-escapes');
		// 长度上限按解码后原文计：90 个汉字（地址栏 810 字符）在上限内
		const cjk = `/${'网'.repeat(90)}`;
		expect(normalizePagePath(cjk)).toBe(cjk);
	});

	it('pathToHref turns a readable path back into a URL path', () => {
		expect(pathToHref('/article/网络安全')).toBe(
			'/article/%E7%BD%91%E7%BB%9C%E5%AE%89%E5%85%A8'
		);
		expect(pathToHref('/a/?x=1')).toBe('/a');
		expect(pathToHref(null)).toBe('/');
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
