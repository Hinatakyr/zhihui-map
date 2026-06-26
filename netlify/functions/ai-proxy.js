/**
 * Netlify Function: 千问AI API代理
 * 隐藏API Key，前端通过 /.netlify/functions/ai-proxy 调用
 * Key存储在Netlify环境变量 QWEN_API_KEY 中
 */

const API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

const SYSTEM_PROMPT = `你是一个地图绘制参数生成器。用户用自然语言描述想画的地图，你必须输出一个JSON对象。
严格按以下格式输出，不要输出任何其他文字：

{
  "map_type": "admin",
  "interest_areas": [
    {"name": "北京市", "level": "province", "adcode": "110000", "color": "#e6194b"}
  ],
  "styles": {"border_width": 2, "show_dem": false, "show_roads": false, "show_rivers": false},
  "annotations": {"title": "北京市行政区划图", "notes": "审图号：GS(2024)0650号", "show_scale": true, "show_north": true}
}

规则：
- map_type只能选: admin(行政区划), terrain(地形图), roads(交通路网), rivers(水系图)
- interest_areas中每个元素必须有name(行政区全称), level(province/city/district), adcode(6位代码,不确定填空字符串), color(十六进制颜色)
- 若用户要"地形图"：map_type="terrain", styles.show_dem=true
- 若用户要"交通图/路网"：map_type="roads", styles.show_roads=true
- 若用户要"水系图/河流"：map_type="rivers", styles.show_rivers=true
- annotations.title根据用户需求生成合适的地图标题
- 多个区域用不同颜色，颜色从以下选: #e6194b,#3cb44b,#ffe119,#4363d8,#f58231,#911eb4,#46f0f0
- 只输出JSON，不要markdown，不要解释`;

function extractJSON(text) {
    text = text.trim();
    if (text.startsWith('```')) {
        const lines = text.split('\n');
        if (lines[0].startsWith('```')) lines.shift();
        if (lines[lines.length - 1].trim() === '```') lines.pop();
        text = lines.join('\n');
    }
    try { return JSON.parse(text); } catch (e) {}
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch (e2) {} }
    return null;
}

function normalizeParams(params) {
    const validTypes = { admin: 1, terrain: 1, dark: 1, roads: 1, rivers: 1 };
    let mt = params.map_type || 'admin';
    if (!validTypes[mt]) {
        const cnMap = { '地形图': 'terrain', '行政区划': 'admin', '交通图': 'roads', '路网': 'roads', '水系图': 'rivers', '河流': 'rivers' };
        mt = cnMap[mt] || 'admin';
    }
    params.map_type = mt;

    const palette = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0'];
    const rawAreas = Array.isArray(params.interest_areas) ? params.interest_areas : [];
    params.interest_areas = rawAreas.map((a, i) => {
        if (typeof a === 'string') return { name: a, level: 'province', adcode: '', color: palette[i % palette.length] };
        return {
            name: a.name || '', level: a.level || 'province',
            adcode: String(a.adcode || ''), color: a.color || palette[i % palette.length]
        };
    });

    const styles = params.styles && typeof params.styles === 'object' ? params.styles : {};
    styles.border_width = styles.border_width || 2;
    styles.show_dem = mt === 'terrain' || !!styles.show_dem;
    styles.show_roads = mt === 'roads' || !!styles.show_roads;
    styles.show_rivers = mt === 'rivers' || !!styles.show_rivers;
    params.styles = styles;

    const ann = params.annotations && typeof params.annotations === 'object' ? params.annotations : {};
    ann.title = ann.title || '自定义地图';
    ann.notes = ann.notes || '审图号：GS(2024)0650号';
    ann.show_scale = ann.show_scale !== false;
    ann.show_north = ann.show_north !== false;
    params.annotations = ann;

    return params;
}

exports.handler = async (event) => {
    // CORS头
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: '仅支持POST' }) };
    }

    const apiKey = process.env.QWEN_API_KEY;
    if (!apiKey) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: '服务器未配置QWEN_API_KEY环境变量' })
        };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const prompt = body.prompt || '';
        if (!prompt) {
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '请输入绘图指令' }) };
        }

        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'qwen-plus',
                input: {
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: prompt }
                    ]
                },
                parameters: { temperature: 0.3, top_p: 0.9 }
            })
        });

        if (!resp.ok) {
            const errText = await resp.text();
            return {
                statusCode: resp.status,
                headers,
                body: JSON.stringify({ success: false, error: `AI服务返回${resp.status}: ${errText.substring(0, 200)}` })
            };
        }

        const result = await resp.json();
        const text = result.output?.text || result.choices?.[0]?.message?.content || '';

        const params = extractJSON(text);
        if (!params) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'AI返回内容无法解析为JSON，请重试' }) };
        }

        const normalized = normalizeParams(params);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, params: normalized })
        };
    } catch (e) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: `服务器错误: ${e.message}` })
        };
    }
};
