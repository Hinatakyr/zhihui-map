# 智绘地图 · AI地图绘制平台

基于 AI 的中国行政地图绘制工具，支持省/市/县三级行政边界、自然语言智能绘图、地图三要素与高清导出。

## ✨ 功能特性

- **省/市/县三级行政边界**：放大地图自动切换层级，数据来自 DataV.GeoAtlas
- **AI 智能绘制**：输入自然语言（如"绘制北京市的地形图"），AI 自动生成地图
- **6 种底图样式**：标准地图、卫星影像、地形渲染、简洁浅色、深色主题、经典复古
- **地图三要素**：标题、比例尺、指北针、图例，可独立开关
- **自定义上色**：15 色调色板，点选/搜索行政区上色
- **高清导出**：一键导出 PNG 图片

## 🚀 本地运行

```bash
# 方式1：用任意静态服务器
npx serve .

# 方式2：用 Python
python -m http.server 8080
```

浏览器打开 `http://localhost:8080`

## 📦 部署到 Netlify

1. 将本项目推送到 GitHub
2. 在 Netlify 中连接该仓库
3. 设置环境变量 `QWEN_API_KEY`（阿里云百炼千问API Key）
4. 部署，Netlify 会自动识别 `netlify.toml` 配置

### 环境变量

| 变量名 | 说明 |
|--------|------|
| `QWEN_API_KEY` | 阿里云百炼千问 API Key（用于AI绘制功能）|

## 🏗️ 技术栈

- **前端**：HTML + CSS + JavaScript（原生，无框架）
- **地图**：Leaflet.js
- **边界数据**：DataV.GeoAtlas（阿里云公开数据）
- **AI**：通义千问（通过 Netlify Functions 代理）
- **导出**：html2canvas
- **部署**：Netlify 静态站点 + Serverless Functions

## 📁 项目结构

```
web/
├── index.html              # 主页面
├── css/style.css           # 样式
├── js/app.js               # 核心逻辑
├── netlify/
│   └── functions/
│       └── ai-proxy.js     # 千问API代理（隐藏Key）
├── netlify.toml            # Netlify配置
└── package.json
```

## ⚠️ 地图合规

本平台展示的中国行政边界数据来自 DataV.GeoAtlas，审图号 GS(2024)0650号。
公开使用时请在页面注明审图号，遵守《地图管理条例》相关规定。

## 📄 License

MIT
