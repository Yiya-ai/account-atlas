# HTTPS 服务器模式

默认启动方式仍仅用于本机。显式传入 `run.py --public-config /etc/account-atlas/public.json` 才启用本模式；后端依然只监听回环地址，不要将 Waitress 端口直接开放公网。

当前模式面向受控的单人服务器部署。使用 Nginx 终止 HTTPS、精确匹配 Origin/Host、覆盖客户端来源头，并通过独立随机代理令牌认证回环代理。不能仅依赖用户提交的 `X-Forwarded-For`，也不能将所有回环请求无条件视为可信代理。

## 必要配置

- 安装普通依赖及 `requirements-server.txt` 中的官方 `py-ip2region` 客户端。
- 使用固定版本的 ip2region IPv4/IPv6 数据文件，附带许可证及包含文件名、SHA-256 和上游 commit 的 `manifest.json`。启动时校验完整性，数据缺失或不兼容时拒绝启动。
- 用独立的高强度随机值分别生成代理令牌与首次初始化口令。文件仅允许 root 和运行服务的账号读取，禁止提交到 Git。
- 以非 root 账号运行应用，代码和配置只读，资料目录独立且权限为 0700；数据库备份保存在站点根目录之外。

配置字段：`origin`、`proxyTokenFile`、`bootstrapTokenFile`、`geoipDirectory`、`country`、`province`、`city`。Origin 必须是无路径的完整 HTTPS IPv4 地址，可包含端口。该模式不启用 IP 地址上的 WebAuthn；需要通行密钥时应另行实现域名 RP 的部署配置。

Nginx 必须固定 Host 和 HTTPS 标记，并覆盖 `X-Atlas-Client-IP` 为实际 TCP 来源 `$remote_addr`；代理令牌使用服务器端生成的固定值。清空客户端传入的 Forwarded / X-Forwarded 系列头。应用只接受来自 127.0.0.1 且携带正确代理令牌的请求。

前端以 `VITE_ATLAS_DEPLOYMENT=https npm run build` 构建，使用与服务器存储相符的提示。该构建参数仅影响界面，权限由后端强制执行。

## 门禁规则

1. 每个请求先通过来源地域校验；归属未知、区域不符或查询异常均拒绝。查询在内存中的离线数据库完成，不向外部查询服务发送访客 IP。
2. 用户配置的 IP/CIDR 白名单可进一步缩小范围，不能覆盖地域限制。
3. 首次创建或恢复资料库需要初始化口令，避免网站开放后被他人抢先创建；初始化后不可再次创建覆盖。
4. 主密码验证后，未绑定 TOTP 的会话只能读取门禁设置、绑定验证器或锁定，不能读取、导入、导出、备份或修改账号资料。完成绑定后方可进入。
5. 后续解锁需要主密码及 TOTP / 未使用过的恢复码。公网模式禁止关闭 TOTP。恢复备份不会关闭门禁。
6. 会话使用 Secure、HttpOnly、SameSite=Strict Cookie，并绑定解锁时的来源 IP；网络变化后需要重新登录。修改操作要求精确匹配的 Origin 及自定义请求头。

地域门禁依赖数据快照的准确性，并不证明使用者所在地或身份。数据可能过期；更新时固定新上游版本、核验文件哈希、测试允许及拒绝样本，再原子替换并重启。不要在归属错误时临时放行全部来源。共享同一个 IP 主机名的其他站点也应视为受信任服务，Cookie 不提供端口隔离。

## 证书和维护

可使用包含 IP SAN 的受信任证书。Let's Encrypt 的 IP 证书有效期较短，必须验证自动续期计划及续期后 Nginx reload；仅设置初次签发不能算部署完成。

部署前对加密 SQLite 资料库做一致性备份，保留上一版代码及服务配置。先跑回归测试，再切换代码和代理；失败时回退到仅回环访问。保留管理 SSH 作为运维通道，但日常浏览器访问不需要 SSH 隧道。

服务器管理员仍可读取运行中的内存或修改程序。该模式不提供浏览器端端到端加密；请信任并维护服务器，定期下载加密备份到独立位置。

参考：[IP 证书与自动续期](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、[ip2region 官方项目](https://github.com/lionsoul2014/ip2region)。
