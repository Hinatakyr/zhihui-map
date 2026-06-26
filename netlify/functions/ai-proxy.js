/**
 * Netlify Function: AI API代理（双引擎自动切换）
 * 优先使用 DeepSeek（国际可访问），失败自动回退千问
 * 环境变量：DEEPSEEK_API_KEY 和/或 QWEN_API_KEY
 */

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

// ========== DeepSeek API（OpenAI兼容接口，国际可访问）==========
async function callDeepSeek(prompt, apiKey) {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2000
        })
    });
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`DeepSeek返回${resp.status}: ${errText.substring(0, 150)}`);
    }
    const result = await resp.json();
    return result.choices?.[0]?.message?.content || '';
}

// ========== 千问 API（DashScope接口）==========
async function callQwen(prompt, apiKey) {
    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
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
        throw new Error(`千问返回${resp.status}: ${errText.substring(0, 150)}`);
    }
    const result = await resp.json();
    return result.output?.text || result.choices?.[0]?.message?.content || '';
}

// ========== JSON提取与参数归一化 ==========
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

// ========== 主处理函数 ==========
exports.handler = async (event) => {
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

    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const qwenKey = process.env.QWEN_API_KEY;

    if (!deepseekKey && !qwenKey) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: '未配置AI API Key，请在Netlify设置 DEEPSEEK_API_KEY 或 QWEN_API_KEY' })
        };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const prompt = body.prompt || '';
        if (!prompt) {
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '请输入绘图指令' }) };
        }

        let text = '';
        let apiUsed = '';
        const errors = [];

        // 策略1：优先用 DeepSeek（国际可访问性最好）
        if (deepseekKey) {
            try {
                text = await callDeepSeek(prompt, deepseekKey);
                apiUsed = 'deepseek';
            } catch (e) {
                errors.push(`DeepSeek: ${e.message}`);
            }
        }

        // 策略2：DeepSeek失败，回退千问
        if (!text && qwenKey) {
            try {
                text = await callQwen(prompt, qwenKey);
                apiUsed = 'qwen';
            } catch (e) {
                errors.push(`千问: ${e.message}`);
            }
        }

        if (!text) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ success: false, error: `所有AI服务均失败: ${errors.join('; ')}` })
            };
        }

        const params = extractJSON(text);
        if (!params) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'AI返回内容无法解析为JSON，请重试' }) };
        }

        const normalized = normalizeParams(params);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, params: normalized, api: apiUsed })
        };
    } catch (e) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: `服务器错误: ${e.message}` })
        };
    }
};
