# 本地截图识别

[返回首页](../README.md) · [使用指南](USER-GUIDE.md#截图识别填写)

在添加或编辑账号时，点击“截图识别填写”，选择或粘贴截图，识别后逐项确认。它是录入辅助，不会替你登录平台、验证账号状态或自动保存账号。

## 录入与确认

- 支持 PNG、JPEG、WebP；最大 10 MB、1600 万像素，单边不超过 8000 像素。在浏览器内对小字截图最多放大两倍，处理尺寸限制在单边 3200 像素。
- 默认同时使用繁体、简体和英文模型；也可手动选择单种中文加英文或纯英文。标签和值均需可见；模糊或打码内容无法恢复。
- 候选字段全部默认不勾选。可编辑候选值，再勾选需要的字段并确认填入；已有值会提示替换，未选择的字段保持不变。无效值会提示修正并保留预览。
- 确认填入后仍需点击“保存账号”。取消、关闭面板/编辑窗口、切换平台或锁定会终止任务并清除临时截图与识别结果。

匹配范围包括账号标识（邮箱或电话）、姓名、性别、出生日期、国家或地区、语言、联系邮箱、恢复邮箱、绑定/受信任电话、登录电话号码及 Google/Apple 双重认证。Apple 还支持明确的密码更新日期和 iCloud 分析状态。英文生日支持带四位年份的月份名称；缺少年份的日期不猜测年份。

Google 只有同时看到两步验证已开启及身份验证器已添加，才建议记录为 TOTP 方式，不会生成密钥。“恢复邮箱待验证”会保留提示；“尽可能跳过密码”不会被误认作通行密钥配置。Apple 电话号码数量不会被当作电话号码，付款、家庭和设备说明也不会被当作实际资料。

候选项可展开查看对应识别原文。邮箱标点疑似误读时保留可编辑候选及警告，修正后才能填入；多邮箱未注明主次时不会任意选作登录账号。匹配遵守平台字段范围，并利用坐标区分卡片；歧义或冲突结果不自动选定。密码、密钥、恢复码、付款资料和自定义字段不作为候选。

## 隐私边界

OCR 在当前浏览器的独立 Worker 中运行。应用不把截图上传到账号簿服务器或第三方，不保存原图、完整 OCR 文本或识别日志，也不将它们写入浏览器持久化存储。语言模型的 IndexedDB 缓存被关闭。

网络请求只用于从当前站点加载识别程序与语言文件；中文加英文模型约 6 MB，另需加载 WASM 引擎。确认后的字段先进入当前表单，只有点击“保存账号”时，才按正常账号保存流程提交并加密保存。原始图片文件、系统剪贴板及浏览器自身的系统级缓存行为不由应用管理。

本机版在依赖安装并构建完成后，可以不连接外部网络使用 OCR；服务器版仍需连接你自己的站点。没有第三方 OCR API、CDN 运行时依赖或远程识别回退。

## 构建与部署

```powershell
cd frontend
npm ci
npm run build
```

构建前的 `scripts/prepare-ocr.mjs` 校验 `public/ocr/models/manifest.json` 中的 SHA-256，并从锁定依赖生成 `public/ocr/runtime/`。Vite 将模型、Worker、WASM 和许可证复制到 `dist/ocr/`。不要省略这些文件，也不要把真实截图放进公开资源目录。

后端通过只读 `/ocr/<path>` 路由提供构建资源，没有截图上传接口。资源地址按页面所在路径解析；现有 `/account-atlas/` 通用代理会将 `/account-atlas/ocr/` 转发到后端 `/ocr/`，无需额外开放端口。部署时应验证根入口与子路径入口都能加载语言文件和 Worker。

页面与 Worker 响应均限制为同源连接、同源 Worker，并只额外允许 WebAssembly 编译（`'wasm-unsafe-eval'`），不启用 JavaScript 的 `'unsafe-eval'`。应用从构造开始持有原生 Worker 句柄，取消、超时或锁定可立即终止初始化和识别；消息协议固定到 Tesseract.js 7.0.0，升级依赖时应重新验证。

## 资源来源与许可证

| 资源 | 固定来源 | 许可证位置 |
| --- | --- | --- |
| Tesseract.js / core | 7.0.0，版本及完整性由 `package-lock.json` 锁定 | 构建生成的 `public/ocr/runtime/TESSERACT-JS-LICENSE.txt`、`TESSERACT-CORE-LICENSE.txt` |
| 英文、简体、繁体模型 | 官方 `tessdata_fast` 提交 `65727574dfcd264acbb0c3e07860e4e9e9b22185` | `public/ocr/models/LICENSE` 与 `manifest.json` |

Tesseract.js、core 和语言模型采用 Apache-2.0。Worker 内还包含 MIT / BSD 许可的组件，其版权通知保留在 `runtime/worker.min.js.LICENSE.txt`，发布时一并提供。模型来自 [Tesseract 官方 tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185)，引擎来自 [Tesseract.js](https://github.com/naptha/tesseract.js/tree/v7.0.0) 和 [Tesseract.js-core](https://github.com/naptha/tesseract.js-core/tree/v7.0.0)。这些链接用于维护参考，识别时不会访问它们。

## 验证

在 `frontend` 目录运行：

```powershell
node scripts/check-ocr-fields.mjs
node scripts/check-google-ocr.mjs
node scripts/check-apple-ocr.mjs
node scripts/check-local-ocr.mjs
node scripts/check-apple-form.mjs
node scripts/check-dates.mjs
node scripts/check-idle-timer.mjs
```

另外运行项目后端测试。浏览器验收使用虚构截图，检查简体、繁体和英文识别，确认前不回填、已有值不自动覆盖、保存与编辑回显，以及无效值、资源失败、取消和锁定。阻断第三方网络并检查请求体，确认没有图片或临时 OCR 文本上传；不要将真实截图加入测试或发布包。
