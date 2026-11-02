# 参与开发

项目目前以 Windows、Python 3.12+、Node.js 22.12+ 为开发环境。首次运行 `install.cmd` 安装锁定依赖并构建前端。

提交变更前执行：

```powershell
.venv\Scripts\python.exe -m pytest -q
cd frontend
npm run build
```

运行手工测试时使用独立资料库：

```powershell
.venv\Scripts\python.exe run.py --port 8766 --data-dir output\qa-vault
```

测试账号统一使用 `example.invalid` 等示例域名，密码和 TOTP 密钥必须为合成测试值。不得使用真实账号、正式库或真实恢复码编写测试、截图和复现材料。

提交前检查 `git status --short`、`git diff --cached --stat` 及 `git diff --cached --check`，确认暂存区不含运行目录、环境配置、凭据或导出文件。`.gitignore` 无法移除已经被跟踪的文件，也不能过滤 GitHub 网页拖拽上传的内容。

本项目使用 [MIT 许可证](LICENSE)。贡献的代码应具有相应授权，不得加入未经许可的第三方代码或任何真实账号资料。
