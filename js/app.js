/* ===================================================================
 * 智绘地图 - 纯前端版核心逻辑
 * 功能：省/市/县三级边界(DataV直连) | 6种底图 | AI绘制 | 地图三要素 | 导出
 * 部署：Netlify静态站点 + 1个Function代理千问API
 * =================================================================== */

// ==================== 全局状态 ====================
let map;
let selectedAreas = [];
let currentColor = '#e6194b';
let currentMode = 'manual';
let currentAdminLevel = 'province';
let currentBasemap = null;
let basemaps = {};

// 图层
let adminLayerGroup = null;
let fillLayerGroup = null;
let titleControl, legendControl, scaleControl, northControl, levelBadgeControl;

// 缓存
let adminCache = {};                    // adcode → {geojson, level, units}
let provinceFeatures = [];
let cityFeaturesByProvince = {};
let zoomSwitchTimer = null;

// 缩放阈值
const ZOOM_PROVINCE = 5;   // zoom <= 5: 省
const ZOOM_CITY = 8;       // 6-8: 市, >=9: 县

// DataV GeoAtlas API（公开，支持CORS）
const DATAV_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

// 配色
const COLOR_PALETTE = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
    '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
    '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3'
];

// ==================== 底图定义 ====================
const BASEMAP_CONFIGS = {
    osm: {
        name: '标准地图',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { subdomains: ['a','b','c'], maxZoom: 17, attribution: '© OpenStreetMap' }
    },
    satellite: {
        name: '卫星影像',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: 17, attribution: '© Esri' }
    },
    terrain: {
        name: '地形渲染',
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        options: { subdomains: ['a','b','c'], maxZoom: 15, attribution: '© OpenTopoMap' }
    },
    light: {
        name: '简洁浅色',
        url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        options: { subdomains: ['a','b','c','d'], maxZoom: 17, attribution: '© CARTO' }
    },
    dark: {
        name: '深色主题',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        options: { subdomains: ['a','b','c','d'], maxZoom: 17, attribution: '© CARTO' }
    },
    voyager: {
        name: '经典复古',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        options: { subdomains: ['a','b','c','d'], maxZoom: 17, attribution: '© CARTO' }
    }
};

// ==================== 初始化 ====================
function initApp() {
    map = L.map('map', {
        center: [35.0, 105.0],
        zoom: 4,
        zoomControl: true,
        attributionControl: false,
        fadeAnimation: false,
        zoomAnimation: true
    });

    adminLayerGroup = L.layerGroup().addTo(map);
    fillLayerGroup = L.layerGroup().addTo(map);

    // 初始化底图
    initBasemaps();

    // 加载省级行政边界
    loadProvinceBoundaries();

    // 地图要素控件
    addTitleControl();
    addLegendControl();
    addScaleControl();
    addNorthArrowControl();
    addLevelBadgeControl();

    // 缩放切换
    map.on('zoomend', onZoomChanged);

    bindEvents();
    showToast('智绘地图加载完成，放大可查看市/县边界', 'success');
}

// ==================== 底图管理 ====================
function initBasemaps() {
    // 默认使用标准地图
    switchBasemap('osm');
}

function switchBasemap(key) {
    const config = BASEMAP_CONFIGS[key];
    if (!config) return;

    // 移除当前底图
    if (currentBasemap) {
        map.removeLayer(currentBasemap);
    }

    // 添加新底图
    currentBasemap = L.tileLayer(config.url, config.options);
    currentBasemap.addTo(map);

    // 更新UI
    document.querySelectorAll('.basemap-item').forEach(el => {
        el.classList.toggle('active', el.dataset.map === key);
    });
}

// ==================== 行政边界：本地优先 + DataV回退 ====================
let cityBoundariesData = null;  // 本地市级边界数据缓存

async function loadProvinceBoundaries() {
    showLoading('正在加载省级行政边界...');
    try {
        // 省级：优先用本地数据（已包含完整岛屿）
        const resp = await fetch('data/province_boundaries.json');
        if (!resp.ok) throw new Error('本地边界数据加载失败');
        const geojson = await resp.json();
        provinceFeatures = geojson.features || [];
        adminCache['100000'] = {
            geojson, level: 'province',
            units: provinceFeatures.map(f => ({
                name: f.properties.name || '',
                adcode: String(f.properties.adcode || ''),
                level: 'province'
            })).sort((a, b) => a.name.localeCompare(b.name))
        };
        renderAdminLayer(provinceFeatures, 'province');

        // 后台预加载市级边界数据（不阻塞UI）
        loadCityBoundariesLocal();
    } catch (e) {
        showToast('省界加载失败：' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// 后台加载本地市级边界数据
async function loadCityBoundariesLocal() {
    try {
        const resp = await fetch('data/city_boundaries.json');
        if (resp.ok) {
            cityBoundariesData = await resp.json();
            // 预填充缓存
            for (const provAdcode in cityBoundariesData) {
                const provData = cityBoundariesData[provAdcode];
                const cityFeats = provData.cities || [];
                const cityGeojson = { type: 'FeatureCollection', features: cityFeats };
                adminCache[provAdcode] = {
                    geojson: cityGeojson,
                    level: 'city',
                    units: cityFeats.map(f => ({
                        name: f.properties.name || '',
                        adcode: String(f.properties.adcode || ''),
                        level: f.properties.level || 'city'
                    })).sort((a, b) => a.name.localeCompare(b.name))
                };
                cityFeaturesByProvince[provAdcode] = cityFeats;
            }
            console.log('市级边界本地数据已加载');
        }
    } catch (e) {
        console.log('市级边界本地数据加载失败，将使用DataV API');
    }
}

// 获取某adcode的子级边界（本地优先 → DataV回退）
async function fetchDatavGeojson(adcode) {
    adcode = String(adcode);
    if (adminCache[adcode]) return adminCache[adcode].geojson;

    // 市级：尝试从本地数据获取
    if (adcode.endsWith('0000') && adcode !== '100000') {
        if (cityBoundariesData && cityBoundariesData[adcode]) {
            const cityFeats = cityBoundariesData[adcode].cities || [];
            const geojson = { type: 'FeatureCollection', features: cityFeats };
            adminCache[adcode] = {
                geojson, level: 'city',
                units: cityFeats.map(f => ({
                    name: f.properties.name || '',
                    adcode: String(f.properties.adcode || ''),
                    level: f.properties.level || 'city'
                })).sort((a, b) => a.name.localeCompare(b.name))
            };
            cityFeaturesByProvince[adcode] = cityFeats;
            return geojson;
        }
    }

    // 县级：尝试从本地按省份分块文件加载
    if (!adcode.endsWith('0000')) {
        const localGeojson = await fetchLocalCounties(adcode);
        if (localGeojson) return localGeojson;
    }

    // 回退：DataV API
    try {
        const resp = await fetch(`${DATAV_BASE}/${adcode}_full.json`);
        if (!resp.ok) return null;
        const geojson = await resp.json();
        if (geojson.type !== 'FeatureCollection' || !geojson.features?.length) return null;
        let level;
        if (adcode === '100000') level = 'province';
        else if (adcode.endsWith('0000')) level = 'city';
        else level = 'district';
        const units = geojson.features.map(f => ({
            name: f.properties.name || '',
            adcode: String(f.properties.adcode || ''),
            level: f.properties.level || level
        })).sort((a, b) => a.name.localeCompare(b.name));
        adminCache[adcode] = { geojson, level, units };
        if (level === 'city') cityFeaturesByProvince[adcode] = geojson.features || [];
        return geojson;
    } catch (e) {
        return null;
    }
}

// 从本地按省份分块文件加载县级边界
async function fetchLocalCounties(cityAdcode) {
    cityAdcode = String(cityAdcode);
    // 推断省份adcode
    const provAdcode = cityAdcode.substring(0, 2) + '0000';
    try {
        const resp = await fetch(`data/counties/${provAdcode}.json`);
        if (!resp.ok) return null;
        const data = await resp.json();
        // 找到该市的县级features
        const countyFeats = (data.features || []).filter(f =>
            String(f.properties.adcode || '').startsWith(cityAdcode.substring(0, 4))
        );
        if (!countyFeats.length) return null;
        const geojson = { type: 'FeatureCollection', features: countyFeats };
        adminCache[cityAdcode] = {
            geojson, level: 'district',
            units: countyFeats.map(f => ({
                name: f.properties.name || '',
                adcode: String(f.properties.adcode || ''),
                level: f.properties.level || 'district'
            })).sort((a, b) => a.name.localeCompare(b.name))
        };
        return geojson;
    } catch (e) {
        return null;
    }
}

// ==================== 缩放级别自动切换 ====================
function onZoomChanged() {
    clearTimeout(zoomSwitchTimer);
    zoomSwitchTimer = setTimeout(handleZoomSwitch, 400);
}

async function handleZoomSwitch() {
    const zoom = map.getZoom();
    let newLevel;
    if (zoom <= ZOOM_PROVINCE) newLevel = 'province';
    else if (zoom <= ZOOM_CITY) newLevel = 'city';
    else newLevel = 'district';

    if (newLevel === currentAdminLevel) return;
    currentAdminLevel = newLevel;
    updateLevelBadge();

    if (newLevel === 'province') {
        adminLayerGroup.clearLayers();
        renderAdminLayer(provinceFeatures, 'province');
    } else {
        await loadAndRenderChildren(newLevel);
    }
}

async function loadAndRenderChildren(targetLevel) {
    showLoading(`正在加载${targetLevel === 'city' ? '市' : '区/县'}级边界...`);
    adminLayerGroup.clearLayers();
    const bounds = map.getBounds();
    const allFeatures = [];

    if (targetLevel === 'city') {
        const visibleProvs = provinceFeatures.filter(f => isFeatureInBounds(f, bounds));
        const target = visibleProvs.length > 0 ? visibleProvs : provinceFeatures.slice(0, 8);
        for (const feat of target) {
            const children = await fetchDatavGeojson(feat.properties.adcode);
            if (children) allFeatures.push(...children.features);
        }
        renderAdminLayer(allFeatures, 'city');
    } else {
        // district: 从本地县级数据加载（按省份分块文件）
        const allCities = Object.values(cityFeaturesByProvince).flat();
        const visibleCities = allCities.length > 0
            ? allCities.filter(f => isFeatureInBounds(f, bounds))
            : await loadVisibleCities(bounds);
        // 按省份归组，加载本地县级数据文件
        const provAdcodes = new Set();
        const visibleCityPrefixes = new Set();
        for (const cityFeat of visibleCities.slice(0, 20)) {
            const cityAdcode = String(cityFeat.properties.adcode || '');
            provAdcodes.add(cityAdcode.substring(0, 2) + '0000');
            visibleCityPrefixes.add(cityAdcode.substring(0, 4));
        }
        for (const provAdcode of provAdcodes) {
            try {
                const resp = await fetch(`data/counties/${provAdcode}.json`);
                if (resp.ok) {
                    const data = await resp.json();
                    for (const feat of (data.features || [])) {
                        const featAdcode = String(feat.properties.adcode || '');
                        // 只加载可见城市的县级数据
                        if (visibleCityPrefixes.has(featAdcode.substring(0, 4)) &&
                            isFeatureInBounds(feat, bounds)) {
                            allFeatures.push(feat);
                        }
                    }
                    // 缓存
                    if (!adminCache[provAdcode + '_counties']) {
                        adminCache[provAdcode + '_counties'] = data;
                    }
                }
            } catch (e) { /* 忽略单个省份加载失败 */ }
        }
        // 如果本地没有，回退到逐城市DataV加载
        if (allFeatures.length === 0) {
            for (const cityFeat of visibleCities.slice(0, 15)) {
                const children = await fetchDatavGeojson(cityFeat.properties.adcode);
                if (children) allFeatures.push(...children.features);
            }
        }
        renderAdminLayer(allFeatures, 'district');
    }
    hideLoading();
}

async function loadVisibleCities(bounds) {
    const cities = [];
    const visibleProvs = provinceFeatures.filter(f => isFeatureInBounds(f, bounds));
    for (const feat of visibleProvs.slice(0, 5)) {
        const children = await fetchDatavGeojson(feat.properties.adcode);
        if (children) cities.push(...children.features);
    }
    return cities;
}

function isFeatureInBounds(feature, bounds) {
    try {
        const coords = getCoordsFlat(feature);
        if (!coords.length) return false;
        const minLng = Math.min(...coords.map(c => c[0]));
        const maxLng = Math.max(...coords.map(c => c[0]));
        const minLat = Math.min(...coords.map(c => c[1]));
        const maxLat = Math.max(...coords.map(c => c[1]));
        return !(maxLng < bounds.getWest() || minLng > bounds.getEast() ||
                 maxLat < bounds.getSouth() || minLat > bounds.getNorth());
    } catch (e) { return false; }
}

function getCoordsFlat(feature) {
    const result = [];
    const geom = feature.geometry;
    if (!geom) return result;
    const extract = (arr) => {
        if (typeof arr[0] === 'number') result.push(arr);
        else arr.forEach(sub => extract(sub));
    };
    extract(geom.coordinates);
    return result;
}

// ==================== 渲染行政边界 ====================
function renderAdminLayer(features, level) {
    adminLayerGroup.clearLayers();
    if (!features?.length) return;
    const style = level === 'province'
        ? { color: '#666', weight: 1.2, fillColor: 'transparent', fillOpacity: 0 }
        : level === 'city'
        ? { color: '#4a90d9', weight: 1.0, fillColor: 'transparent', fillOpacity: 0 }
        : { color: '#888', weight: 0.8, fillColor: 'transparent', fillOpacity: 0 };

    L.geoJSON({ type: 'FeatureCollection', features }, {
        style,
        onEachFeature: (feat, layer) => {
            const name = feat.properties.name || '';
            const adcode = String(feat.properties.adcode || '');
            const featLevel = feat.properties.level || level;
            layer._areaName = name;
            layer._areaAdcode = adcode;
            layer._areaLevel = featLevel;
            layer._areaFeature = feat;
            layer.bindTooltip(`${name}（${levelLabel(featLevel)}）`, { sticky: true, direction: 'top' });
            layer.on('click', () => {
                if (currentMode === 'manual') handleAreaClick(name, adcode, featLevel, feat);
            });
        }
    }).addTo(adminLayerGroup);
    redrawFillLayers();
}

function levelLabel(level) {
    return { province: '省级', city: '市级', district: '区/县级' }[level] || level;
}

// ==================== 手动模式：点选 ====================
function handleAreaClick(name, adcode, level, feature) {
    const idx = selectedAreas.findIndex(a => a.adcode === adcode);
    if (idx > -1) {
        selectedAreas[idx].color = currentColor;
        if (feature) selectedAreas[idx].feature = feature;
    } else {
        selectedAreas.push({ name, adcode: String(adcode), color: currentColor, level: level || currentAdminLevel, feature });
    }
    redrawFillLayers();
    renderSelectedList();
    updateLegend();
    showToast(`已选中 ${name}（${levelLabel(level)}）`, 'success');
}

function redrawFillLayers() {
    fillLayerGroup.clearLayers();
    selectedAreas.forEach(area => {
        if (!area.feature) return;
        L.geoJSON(area.feature, {
            style: { color: '#000', weight: 1.5, fillColor: area.color, fillOpacity: 0.75 }
        }).addTo(fillLayerGroup);
    });
}

function renderSelectedList() {
    const box = document.getElementById('selected-list');
    if (!selectedAreas.length) {
        box.innerHTML = '<div class="empty-tip">点击地图区域或搜索添加</div>';
        return;
    }
    box.innerHTML = selectedAreas.map((a, i) => `
        <div class="selected-item">
            <input type="color" value="${a.color}" data-idx="${i}" class="area-color-input">
            <span class="area-name">${a.name}<span class="area-level"> ${levelLabel(a.level)}</span></span>
            <span class="area-delete" data-idx="${i}">✕</span>
        </div>
    `).join('');
    box.querySelectorAll('.area-color-input').forEach(inp => {
        inp.addEventListener('change', e => {
            selectedAreas[+e.target.dataset.idx].color = e.target.value;
            redrawFillLayers(); updateLegend();
        });
    });
    box.querySelectorAll('.area-delete').forEach(el => {
        el.addEventListener('click', e => {
            selectedAreas.splice(+e.target.dataset.idx, 1);
            redrawFillLayers(); renderSelectedList(); updateLegend();
        });
    });
}

// ==================== 搜索 ====================
function setupAreaSearch() {
    const input = document.getElementById('area-search');
    const dropdown = document.getElementById('area-dropdown');
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const kw = input.value.trim();
        if (!kw) { dropdown.classList.remove('show'); return; }
        timer = setTimeout(() => doSearch(kw, dropdown, input), 300);
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-wrap')) dropdown.classList.remove('show');
    });
}

async function doSearch(kw, dropdown, input) {
    let results = [];
    // 在所有已缓存中搜索
    for (const key in adminCache) {
        for (const u of adminCache[key].units) {
            if ((u.name || '').includes(kw)) results.push({ ...u });
        }
    }
    // 缓存不足时从DataV加载全国省级搜索
    if (results.length < 5) {
        const gj = await fetchDatavGeojson('100000');
        if (gj) {
            for (const u of adminCache['100000'].units) {
                if ((u.name || '').includes(kw) && !results.find(r => r.adcode === u.adcode))
                    results.push({ ...u });
            }
        }
    }
    results = results.slice(0, 30);
    if (!results.length) {
        dropdown.innerHTML = '<div class="search-option" style="color:#999;">无匹配结果</div>';
    } else {
        dropdown.innerHTML = results.map(u => `
            <div class="search-option" data-name="${u.name}" data-adcode="${u.adcode}" data-level="${u.level||''}">
                ${u.name}<span class="opt-code">${u.adcode} ${levelLabel(u.level)}</span>
            </div>`).join('');
        dropdown.querySelectorAll('.search-option[data-adcode]').forEach(opt => {
            opt.addEventListener('click', async () => {
                const feature = await fetchFeature(opt.dataset.adcode);
                handleAreaClick(opt.dataset.name, opt.dataset.adcode, opt.dataset.level || 'province', feature);
                input.value = '';
                dropdown.classList.remove('show');
                flyToAdcode(opt.dataset.adcode);
            });
        });
    }
    dropdown.classList.add('show');
}

async function fetchFeature(adcode) {
    adcode = String(adcode);
    for (const key in adminCache) {
        const found = adminCache[key].geojson?.features?.find(f => String(f.properties.adcode) === adcode);
        if (found) return found;
    }
    const provFeat = provinceFeatures.find(f => String(f.properties.adcode) === adcode);
    if (provFeat) return provFeat;
    // 推断父级加载
    let parent;
    if (adcode.endsWith('0000')) parent = '100000';
    else if (adcode.endsWith('00')) parent = adcode.substring(0, 2) + '0000';
    else parent = adcode.substring(0, 4) + '00';
    const gj = await fetchDatavGeojson(parent);
    return gj?.features?.find(f => String(f.properties.adcode) === adcode) || null;
}

function flyToAdcode(adcode) {
    let found = false;
    adminLayerGroup.eachLayer(layer => {
        if (layer.eachLayer) {
            layer.eachLayer(sub => {
                if (String(sub._areaAdcode) === String(adcode) && !found) {
                    try { map.fitBounds(sub.getBounds(), { padding: [40, 40] }); found = true; } catch (e) {}
                }
            });
        }
    });
}

// ==================== 颜色选择 ====================
function initColorPalette() {
    const el = document.getElementById('color-palette');
    el.innerHTML = COLOR_PALETTE.map((c, i) =>
        `<div class="color-item ${i === 0 ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`
    ).join('');
    el.querySelectorAll('.color-item').forEach(item => {
        item.addEventListener('click', () => {
            el.querySelectorAll('.color-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            currentColor = item.dataset.color;
        });
    });
}

// ==================== 地图三要素控件 ====================
function addTitleControl() {
    titleControl = L.control({ position: 'topleft' });
    titleControl.onAdd = () => {
        const div = L.DomUtil.create('div', 'map-title-control');
        div.id = 'map-title-control';
        div.innerHTML = `<div id="map-title-display">中国行政区划图</div>`;
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    titleControl.addTo(map);
}

function addLegendControl() {
    legendControl = L.control({ position: 'bottomright' });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create('div', 'map-legend-control');
        div.id = 'map-legend-control';
        div.innerHTML = `<div class="legend-title">图例</div><div id="legend-list"></div>`;
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    legendControl.addTo(map);
}

function addScaleControl() {
    scaleControl = L.control.scale({ position: 'bottomleft', metric: true, imperial: false });
    scaleControl.addTo(map);
}

function addNorthArrowControl() {
    northControl = L.control({ position: 'topright' });
    northControl.onAdd = () => {
        const div = L.DomUtil.create('div', 'north-arrow-control');
        div.id = 'north-arrow-control';
        div.innerHTML = `<div class="arrow">↑</div><div class="label">N</div>`;
        return div;
    };
    northControl.addTo(map);
}

function addLevelBadgeControl() {
    levelBadgeControl = L.control({ position: 'topright' });
    levelBadgeControl.onAdd = () => {
        const div = L.DomUtil.create('div', 'level-badge-control');
        div.id = 'level-badge';
        div.innerHTML = '当前：省级';
        div.style.marginTop = '50px';
        return div;
    };
    levelBadgeControl.addTo(map);
}

function updateLevelBadge() {
    const badge = document.getElementById('level-badge');
    if (badge) {
        const labels = { province: '省级', city: '市级', district: '区/县级' };
        badge.innerHTML = '当前：' + (labels[currentAdminLevel] || currentAdminLevel);
    }
}

function updateLegend() {
    const box = document.getElementById('legend-list');
    if (!box) return;
    if (!selectedAreas.length) {
        box.innerHTML = '<div style="font-size:12px;color:#999;">暂无图例</div>';
        return;
    }
    const texts = (document.getElementById('map-legend-text').value || '').trim().split(';').filter(Boolean);
    box.innerHTML = selectedAreas.map((a, i) => `
        <div class="legend-item">
            <div class="legend-color" style="background:${a.color}"></div>
            <div>${texts[i] || a.name}</div>
        </div>`).join('');
}

function syncTitle() {
    const disp = document.getElementById('map-title-display');
    if (disp) disp.innerText = document.getElementById('map-title').value || '';
}

function refreshMapElements() {
    const showTitle = document.getElementById('show-title').checked;
    const showLegend = document.getElementById('show-legend').checked;
    const showScale = document.getElementById('show-scale').checked;
    const showNorth = document.getElementById('show-north').checked;
    const tc = document.getElementById('map-title-control');
    const lc = document.getElementById('map-legend-control');
    if (tc) tc.style.display = showTitle ? '' : 'none';
    if (lc) lc.style.display = showLegend ? '' : 'none';
    if (showScale) { if (!scaleControl._map) scaleControl.addTo(map); }
    else { if (scaleControl._map) map.removeControl(scaleControl); }
    const nc = document.getElementById('north-arrow-control');
    if (nc) nc.style.display = showNorth ? '' : 'none';
}

// ==================== AI智能绘制 ====================
async function callAIGenerate() {
    const prompt = document.getElementById('ai-prompt').value.trim();
    if (!prompt) { showToast('请输入绘图指令', 'warning'); return; }
    showLoading('AI正在理解你的需求...');
    try {
        const resp = await fetch('/.netlify/functions/ai-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        const data = await resp.json();
        if (!data.success) { showToast('AI生成失败：' + (data.error || ''), 'error'); return; }
        await applyAIParams(data.params);
        showToast('AI地图生成完成！', 'success');
    } catch (e) {
        // 本地开发回退：直接前端调千问API（Key暴露，仅开发用）
        showToast('AI服务不可用，尝试直连模式...', 'warning');
        await callAIDirect(prompt);
    } finally {
        hideLoading();
    }
}

// 本地开发直连模式（不安全，仅开发环境用）
async function callAIDirect(prompt) {
    const API_KEY = window.__AI_KEY__ || '';
    if (!API_KEY) {
        showToast('未配置AI Key，请在Netlify环境变量设置或联系管理员', 'error');
        return;
    }
    try {
        const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen-plus',
                input: { messages: [
                    { role: 'system', content: buildAIPrompt() },
                    { role: 'user', content: prompt }
                ]},
                parameters: { temperature: 0.3 }
            })
        });
        const result = await resp.json();
        const text = result.output?.text || '';
        const params = extractJSON(text);
        if (!params) { showToast('AI返回解析失败', 'error'); return; }
        await applyAIParams(normalizeParams(params));
        showToast('AI地图生成完成（直连模式）！', 'success');
    } catch (e) {
        showToast('AI直连失败：' + e.message, 'error');
    }
}

function buildAIPrompt() {
    return `你是一个地图绘制参数生成器。用户用自然语言描述想画的地图，你必须输出一个JSON对象。
严格按以下格式输出，不要输出任何其他文字：
{"map_type":"admin","interest_areas":[{"name":"北京市","level":"province","adcode":"110000","color":"#e6194b"}],"styles":{"border_width":2,"show_dem":false,"show_roads":false,"show_rivers":false},"annotations":{"title":"北京市行政区划图","notes":"数据来源：DataV.GeoAtlas","show_scale":true,"show_north":true}}
规则：map_type只能选admin/terrain/roads/rivers；interest_areas每个元素需name,level,adcode,color；地形图设show_dem=true；只输出JSON不要markdown。`;
}

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
    const validTypes = { admin:1, terrain:1, dark:1, roads:1, rivers:1 };
    let mt = params.map_type || 'admin';
    if (!validTypes[mt]) {
        mt = { '地形图':'terrain', '行政区划':'admin', '交通图':'roads', '路网':'roads', '水系图':'rivers' }[mt] || 'admin';
    }
    params.map_type = mt;
    const palette = COLOR_PALETTE;
    params.interest_areas = (params.interest_areas || []).map((a, i) => {
        if (typeof a === 'string') return { name: a, level: 'province', adcode: '', color: palette[i % palette.length] };
        return { name: a.name||'', level: a.level||'province', adcode: String(a.adcode||''), color: a.color || palette[i % palette.length] };
    });
    const styles = params.styles || {};
    styles.border_width = styles.border_width || 2;
    styles.show_dem = mt === 'terrain' || !!styles.show_dem;
    styles.show_roads = mt === 'roads' || !!styles.show_roads;
    styles.show_rivers = mt === 'rivers' || !!styles.show_rivers;
    params.styles = styles;
    const ann = params.annotations || {};
    ann.title = ann.title || '自定义地图';
    ann.notes = ann.notes || '审图号：GS(2024)0650号';
    ann.show_scale = ann.show_scale !== false;
    ann.show_north = ann.show_north !== false;
    params.annotations = ann;
    return params;
}

async function applyAIParams(params) {
    const interest = params.interest_areas || [];
    const ann = params.annotations || {};
    selectedAreas = [];
    for (const a of interest) {
        const feature = await fetchFeature(a.adcode, a.level);
        selectedAreas.push({
            name: a.name, adcode: String(a.adcode || ''), color: a.color || '#4CAF50',
            level: a.level || 'province', feature
        });
    }
    redrawFillLayers();
    renderSelectedList();
    if (selectedAreas.length > 0) flyToAdcode(selectedAreas[0].adcode);
    if (ann.title) { document.getElementById('map-title').value = ann.title; syncTitle(); }
    if (ann.notes) document.getElementById('map-notes').value = ann.notes;
    document.getElementById('show-scale').checked = ann.show_scale !== false;
    document.getElementById('show-north').checked = ann.show_north !== false;
    refreshMapElements();
    updateLegend();
}

// ==================== 导出 ====================
async function exportMap() {
    showLoading('正在生成高清地图...');
    try {
        const target = document.getElementById('map-wrap');
        const canvas = await html2canvas(target, {
            useCORS: true,
            allowTaint: true,
            scale: 2,
            logging: false,
            backgroundColor: '#e8eef5'
        });
        canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `智绘地图_${Date.now()}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast('地图已导出', 'success');
        }, 'image/png');
    } catch (e) {
        showToast('导出失败：' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

function previewMap() {
    syncTitle();
    refreshMapElements();
    updateLegend();
    showToast('已刷新预览', 'info');
}

// ==================== 模式切换 ====================
function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    document.getElementById('panel-manual').style.display = mode === 'manual' ? '' : 'none';
    document.getElementById('panel-ai').style.display = mode === 'ai' ? '' : 'none';
}

// ==================== 事件绑定 ====================
function bindEvents() {
    document.querySelectorAll('.mode-tab').forEach(t => t.addEventListener('click', () => switchMode(t.dataset.mode)));
    document.querySelectorAll('.basemap-item').forEach(el => el.addEventListener('click', () => switchBasemap(el.dataset.map)));
    setupAreaSearch();
    initColorPalette();
    document.getElementById('btn-ai-generate').addEventListener('click', callAIGenerate);
    document.querySelectorAll('.example-chip').forEach(c => c.addEventListener('click', () => document.getElementById('ai-prompt').value = c.textContent));
    document.getElementById('map-title').addEventListener('input', syncTitle);
    document.getElementById('map-legend-text').addEventListener('input', updateLegend);
    ['show-scale', 'show-north', 'show-legend', 'show-title'].forEach(id =>
        document.getElementById(id).addEventListener('change', refreshMapElements));
    document.getElementById('btn-export').addEventListener('click', exportMap);
    document.getElementById('btn-preview').addEventListener('click', previewMap);
}

// ==================== 工具函数 ====================
function showLoading(text) {
    document.getElementById('loading-text').innerText = text || '加载中...';
    document.getElementById('loading-mask').classList.add('show');
}
function hideLoading() { document.getElementById('loading-mask').classList.remove('show'); }
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast ${type} show`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// 启动
document.addEventListener('DOMContentLoaded', initApp);
