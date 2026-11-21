import { describe, expect, it } from 'vitest';
import { formatRegion, parseRegion } from './region';

describe('formatRegion', () => {
	it('离线库原始记录转为带间隔号的展示文本', () => {
		expect(formatRegion('中国|广东省|广州市|电信|CN')).toBe('中国·广东省·广州市·电信');
		expect(formatRegion('United States|California|0|Google LLC|US')).toBe(
			'United States·California·Google LLC'
		);
	});

	it('丢弃占位符与国家代码，折叠直辖市重复段', () => {
		expect(formatRegion('中国|江苏省|南京市|0|CN')).toBe('中国·江苏省·南京市');
		expect(formatRegion('中国|北京市|北京市|0|CN')).toBe('中国·北京市');
	});

	it('兼容旧版库的区域字段', () => {
		expect(formatRegion('中国|0|广东省|深圳市|电信')).toBe('中国·广东省·深圳市·电信');
	});

	it('内网与未知标签原样保留，空值得到空文本', () => {
		expect(formatRegion('内网')).toBe('内网');
		expect(formatRegion('未知')).toBe('未知');
		expect(formatRegion('')).toBe('');
		expect(formatRegion(null)).toBe('');
	});

	it('重复格式化保持原样', () => {
		for (const sample of [
			'中国|广东省|广州市|电信|CN',
			'中国·广东·深圳',
			'中国|北京市|北京市|0|CN',
			'内网'
		]) {
			const once = formatRegion(sample);
			expect(formatRegion(once)).toBe(once);
		}
	});
});

describe('parseRegion', () => {
	it('按 v4 库字段顺序解析', () => {
		expect(parseRegion('中国|广东省|广州市|电信|CN')).toEqual({
			country: '中国',
			province: '广东省',
			city: '广州市',
			isp: '电信',
			countryCode: 'CN'
		});
	});

	it('空值得到全空字段', () => {
		expect(parseRegion('')).toEqual({
			country: null,
			province: null,
			city: null,
			isp: null,
			countryCode: null
		});
	});
});
