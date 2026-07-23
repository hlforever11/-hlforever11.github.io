# 文证·参考文献核验微信小程序

原生微信小程序版本，用户无需登录。支持：

- 粘贴最多 20 条中英文参考文献；
- 从连续文本中自动拆分多条文献；
- 从 TXT、DOCX、文字版 PDF 中提取参考文献；
- 核验中文期刊、英文论文、灰色文献和 `[EB/OL]` 网络文献；
- 标出著录差异并生成 GB/T 7714 风格的建议著录；
- 复制原始记录及人工复核链接。

## 目录

```text
reference-checker-miniprogram/
├── miniprogram/                    小程序前端
├── cloudfunctions/
│   ├── verifyReference/            单条文献核验
│   └── extractDocument/            DOCX/PDF/TXT 提取
├── tests/                           自动测试
└── project.config.json             微信开发者工具项目配置
```

## 架构说明

没有使用 `web-view` 套壳。小程序前端只负责输入、文档选择和结果展示；跨域网页读取、开放数据库查询和 DOCX/PDF 解析均由微信云函数完成。

用户选择 DOCX 或 PDF 后，小程序将其上传到 `temporary/` 云存储目录，取得临时地址并调用解析函数；函数返回后，小程序立即请求删除该临时文件。TXT 文件直接在用户设备读取。

## 首次配置

1. 在微信公众平台注册小程序并取得 AppID。
2. 将 `project.config.json` 中的 `touristappid` 替换为正式 AppID。
3. 用微信开发者工具导入本目录。
4. 在开发者工具中开通云开发环境。
5. 分别上传并部署两个云函数，选择“云端安装依赖”：
   - `verifyReference`
   - `extractDocument`
6. 两个函数均选择 Node.js 18 或更高运行时。
7. 建议为 `verifyReference` 设置 60 秒超时、512 MB 内存；为 `extractDocument` 设置 30 秒超时、512 MB 内存。

云函数使用的第三方接口包括 Crossref、OpenAlex、Semantic Scholar、DOI Citation Formatter，以及用户提交的原始网页。无需在小程序后台增加这些域名，因为请求由云函数发出，而不是由小程序客户端直接发出。

## 测试

先在两个云函数目录安装依赖：

```bash
cd cloudfunctions/verifyReference && npm install
cd ../extractDocument && npm install
```

回到项目根目录运行：

```bash
npm run check
```

测试覆盖：

- 三条中文连续粘贴与中英文混合六条文献的拆分；
- 文档参考文献的多行合并；
- OpenAI Blog 灰色文献的字段解析及 Semantic Scholar 后备核验；
- 上海科技大学网页文献的题名、作者、日期比对；
- 私网地址和非腾讯云临时文件地址拦截；
- 临时 TXT 文档提取。

## 审核前检查

- 在微信公众平台完成小程序名称、头像、简介和服务类目设置；
- 根据实际主体完成小程序备案或认证要求；
- 在“小程序用户隐私保护指引”中如实声明文件选择、云端临时处理和剪贴板用途；
- 设置体验版，分别在 iOS、Android 和微信电脑版测试；
- 确认云函数从所选地域能够稳定访问各核验数据源；
- 提交审核，通过后再发布。

