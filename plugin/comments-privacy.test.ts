import { describe, it, expect } from 'vitest';
import { BASE, setup, getEndpoint, mockEvent, commentRow } from './comments-test-utils';

describe('B2a 前台隐藏设备环境（hideEnv）', () => {
	it('开启 hideEnv 时 /list 投影 os/browser/region 置 null（库里仍存）', async () => {
		const built = await setup(
			[commentRow({ id: 'a', path: '/a', os: 'Windows', browser: 'Chrome 126', region: '广东' })],
			{ hideEnv: true }
		);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=/a` }));
		const body = (await res.json()) as { data: Record<string, unknown>[] };
		expect(body.data[0]).toMatchObject({ os: null, browser: null, region: null });
		// 底层行未被改写（仅投影剥离）
		expect(built.rows.find((r) => r.id === 'a')?.os).toBe('Windows');
	});

	it('未开启时照旧输出环境字段（回归）', async () => {
		const built = await setup([
			commentRow({ id: 'a', path: '/a', os: 'Windows', browser: 'Chrome 126', region: '广东' })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=/a` }));
		const body = (await res.json()) as { data: Record<string, unknown>[] };
		expect(body.data[0]).toMatchObject({ os: 'Windows', browser: 'Chrome 126', region: '广东' });
	});
});

describe('B2b 游客邮箱可留空（guestEmailOptional）', () => {
	it('默认邮箱必填：游客空邮箱 → 400 email required', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: { content: 'hi', path: '/a' } })
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { fieldErrors: Record<string, string> }).fieldErrors.email).toBe(
			'required'
		);
	});

	it('开启 guestEmailOptional：游客空邮箱放行，落库 email 为 null', async () => {
		const built = await setup([], { guestEmailOptional: true });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: { content: 'hi', path: '/a' } })
		);
		expect(res.status).toBe(200);
		const row = built.rows.find((r) => r._collection === 'comments');
		expect(row?.email).toBeNull();
	});

	it('开启 guestEmailOptional 但填了非法邮箱 → 仍 400 email invalid', async () => {
		const built = await setup([], { guestEmailOptional: true });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: { content: 'hi', path: '/a', email: 'not-an-email' }
			})
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { fieldErrors: Record<string, string> }).fieldErrors.email).toBe(
			'invalid'
		);
	});
});

describe('C2 举报理由', () => {
	it('带 reason 上报 → appendReportReason 落 reportReasons（JSON 数组）', async () => {
		const built = await setup([commentRow({ id: 'c1', path: '/a', reports: 0 })]);
		const report = getEndpoint(built, 'POST', '/report');
		await report.handler(
			mockEvent({ method: 'POST', url: `${BASE}/report`, body: { id: 'c1', reason: '广告内容' } })
		);
		await report.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/report`,
				body: { id: 'c1', reason: '  人身攻击  ' }
			})
		);
		const row = built.rows.find((r) => r.id === 'c1');
		expect(JSON.parse(String(row?.reportReasons))).toEqual(['广告内容', '人身攻击']);
	});

	it('不带 reason → 只增计数，不写 reportReasons', async () => {
		const built = await setup([commentRow({ id: 'c1', path: '/a', reports: 0 })]);
		const report = getEndpoint(built, 'POST', '/report');
		const res = await report.handler(
			mockEvent({ method: 'POST', url: `${BASE}/report`, body: { id: 'c1' } })
		);
		expect(res.status).toBe(200);
		expect(built.rows.find((r) => r.id === 'c1')?.reportReasons).toBeUndefined();
	});

	it('appendReportReason 纯函数：折叠空白、限长、只留最近 10 条、非法已有值容错', async () => {
		const { appendReportReason, MAX_REPORT_REASONS, MAX_REPORT_REASON_LENGTH } = await import(
			'./validate'
		);
		expect(JSON.parse(appendReportReason(undefined, '  a  b  '))).toEqual(['a b']);
		// 已有非法 JSON → 视为空重来
		expect(JSON.parse(appendReportReason('not-json', 'x'))).toEqual(['x']);
		// 限长
		const long = appendReportReason('[]', 'x'.repeat(MAX_REPORT_REASON_LENGTH + 50));
		expect(JSON.parse(long)[0].length).toBe(MAX_REPORT_REASON_LENGTH);
		// 上限 10 条（丢最旧）
		let acc = JSON.stringify(Array.from({ length: MAX_REPORT_REASONS }, (_, i) => `r${i}`));
		acc = appendReportReason(acc, 'new');
		const arr = JSON.parse(acc);
		expect(arr.length).toBe(MAX_REPORT_REASONS);
		expect(arr[0]).toBe('r1');
		expect(arr[arr.length - 1]).toBe('new');
	});

	it('C2：matchBlacklist 词形关键词按词边界匹配（ass 不误伤 class），CJK/短语仍子串包含', async () => {
		const { matchBlacklist } = await import('./validate');
		// 英文词形：\b 边界——class/passing 不再被 ass 命中，独立成词才命中
		expect(matchBlacklist('what an ass', ['ass'])).toBe('ass');
		expect(matchBlacklist('this is a classic', ['ass'])).toBeNull();
		expect(matchBlacklist('passing grade', ['ass'])).toBeNull();
		// 大小写不敏感（content 先转小写）
		expect(matchBlacklist('You ASS', ['ass'])).toBe('ass');
		// CJK 关键词：\b 在中文内不存在边界，必须保持子串包含（加边界=中文失效）
		expect(matchBlacklist('这条含违禁词的评论', ['违禁词'])).toBe('违禁词');
		// 短语 / 含标点关键词：子串包含
		expect(matchBlacklist('say fuck you now', ['fuck you'])).toBe('fuck you');
	});
});
