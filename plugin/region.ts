/**
 * IP 归属地展示文本。
 *
 * 框架 lookupRegion 返回离线库的原始记录（新版 v4 库为
 * `国家|省份|城市|运营商|国家代码`，旧版 v1 库为 `国家|区域|省份|城市|运营商`），
 * 旧版本直接落库，历史评论里留着竖线分隔符、占位符 0 与国家代码。本函数把
 * 原始记录与展示文本统一成「国家·省份·城市·运营商」：丢弃占位符与国家代码，
 * 折叠相邻重复段（直辖市的省份与城市同名），重复格式化保持原样。
 *
 * 插件自带这份纯函数实现，不依赖宿主版本——写入与读取两端都走它，历史数据
 * 无需迁移即可在前台与新评论一致显示。
 */
export interface RegionFields {
	country: string | null;
	province: string | null;
	city: string | null;
	isp: string | null;
	countryCode: string | null;
}

const SEPARATOR = '·';
const FIELD_SEPARATORS = /[|·]/u;
const PLACEHOLDERS = new Set(['0', '-', '未知', 'unknown', 'null']);
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

function clean(value: string | undefined): string | null {
	const text = (value ?? '').trim();
	if (!text || PLACEHOLDERS.has(text.toLowerCase())) return null;
	return text;
}

/**
 * 字段布局：带两位国家代码的记录按 v4 库（国家·省份·城市·运营商·代码）理解；
 * 五段且末段不是国家代码的记录按 v1 库理解，第二段是区域（通常为占位符），
 * 从省份开始后移一位。其余段数按顺序取用。
 */
function layout(body: (string | null)[], countryCode: string | null): RegionFields {
	const at = (index: number) => (index < body.length ? body[index] : null);
	if (!countryCode && body.length >= 5) {
		return { country: at(0), province: at(2), city: at(3), isp: at(4), countryCode: null };
	}
	return { country: at(0), province: at(1), city: at(2), isp: at(3), countryCode };
}

/** 解析离线库原始记录或展示文本；空值与纯占位符记录得到全空字段 */
export function parseRegion(raw: string | null | undefined): RegionFields {
	const text = (raw ?? '').trim();
	if (!text) {
		return { country: null, province: null, city: null, isp: null, countryCode: null };
	}
	const cells = text.split(FIELD_SEPARATORS).map(clean);
	const last = cells[cells.length - 1];
	const countryCode =
		cells.length >= 3 && last !== null && COUNTRY_CODE_RE.test(last) ? last.toUpperCase() : null;
	return layout(countryCode ? cells.slice(0, -1) : cells, countryCode);
}

/** 展示文本：`国家·省份·城市·运营商`，去掉占位符、国家代码与相邻重复段 */
export function formatRegion(raw: string | null | undefined): string {
	const text = (raw ?? '').trim();
	// 单一标签（「内网」「未知」）或只有国家名的记录没有可归一的字段，原样返回
	if (!text || !FIELD_SEPARATORS.test(text)) return text;
	const { country, province, city, isp } = parseRegion(text);
	const parts: string[] = [];
	for (const part of [country, province, city, isp]) {
		if (part && part !== parts[parts.length - 1]) parts.push(part);
	}
	return parts.join(SEPARATOR);
}
