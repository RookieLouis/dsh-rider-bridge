# dsh-rider-bridge

把 Rider 中的工程、文件路径和选中行范围带入 DSH 新会话，准备一份待发送草稿。**只有用户发送后才会请求模型。**

本仓库是 DSH 端，需要配合 [rider-open-in-dsh](https://github.com/RookieLouis/rider-open-in-dsh) 使用。两个插件在各自应用中的显示名称均为 `dsh-rider-bridge`。

- DSH 插件版本：`0.1.1`。
- 已验证的 DSH 桌面版本：`0.2.1-rc.2`；依赖该版本的桌面内部接口，升级 DSH 后应重新验证。
- 安装脚本适用于 Windows PowerShell 5.1 或更高版本。
- 构建和测试需要 Node.js `22.19.0` 或更高版本；安装还需要可用的 `pnpm.cmd`。

## 构建与安装

先安装并启动过 DSH 桌面版，使桌面 profile 已存在。克隆到一个长期保留的目录；安装使用本地链接，安装后请不要移动或删除这个目录。

```powershell
git clone https://github.com/RookieLouis/dsh-rider-bridge.git
cd dsh-rider-bridge
npm.cmd run build
npm.cmd test
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\install.ps1 -WhatIf
```

确认预览中的路径正确后，关闭 DSH，再执行安装并重新启动 DSH：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\install.ps1
```

脚本默认使用环境变量 `DSH_HOME`，未设置时使用 `%USERPROFILE%\.dsh`。需要其他路径时可显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\install.ps1 -DshHome "C:\DSH-Data" -BackupRoot "C:\DSH-Backups"
```

`-CompanionPath` 默认是本仓库根目录，通常无需指定。脚本只安装到所选 DSH 数据目录的 `profiles\desktop`；会检查 profile 和可写文件的实际路径，拒绝越界的符号链接。脚本先备份受影响的配置及包管理文件，并验证 SHA256，再更新依赖和 `dsh.profile.bundles`。默认备份目录为 `<DSH_HOME>\backups\dsh-rider-bridge-install\<安装编号>`，包含恢复说明 `install-info.json`。备份目录必须位于所有 DSH profiles 和插件源码目录之外。

安装会迁移旧名 `dsh-ide-bridge` 的依赖和 bundle 项。已有 Cordis 配置只读取和备份；插件自身的 `cordis.patch.yml` 提供加载入口。包管理器使用离线模式和 `--ignore-scripts`。本包保持 `private: true`，通过本地链接安装，不发布到 npm。

## 使用

安装 Rider 端后，在 Rider 中使用：

- `Alt+Shift+D`：打开当前文件或选中行范围的草稿。
- `Ctrl+Alt+Shift+D`：打开当前工程的草稿。

DSH 会注册工程工作区、创建新会话、填入文件路径和行号并打开该会话。原有会话的草稿与附件会保留。用户在准备期间切换页面时会取消自动跳转。快捷键可在 Rider 的 Keymap 设置中修改。

只读检查正在运行的连接：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\check-running.ps1
```

`HostReady` 和 `ClientReady` 均为 `True` 时，Host 与桌面界面都已就绪。检查不会创建会话，也不会输出令牌。使用自定义数据目录时传入 `-DshHomeDirectory`。

## 验证

`npm.cmd test` 运行真实 HTTP、请求确认和草稿隔离测试；`npm.cmd run build` 从 `src/client.js` 重新生成浏览器入口。

还可使用已安装 DSH 的 Electron Node 模式验证原生包兼容性。把下面的路径替换为本机的 DSH 可执行文件：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
try {
    & "C:\Apps\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals .\tools\native-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Native smoke test failed.' }
} finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE
}
```

该验证检查完整 Host 加载、原生 SRC 调度、Client `$mount`、真实 HTTP 确认，以及工作区、会话、草稿与导航 API；只在新建的系统临时目录中运行，不修改实际 DSH profile。

## 本机连接协议

Host 仅监听 `127.0.0.1`，每次启动随机生成端口和 256 位令牌，写入 `<DSH_HOME>/ide-bridge/desktop.properties`。Rider 只读取该连接文件，不读取 DSH 模型凭据。连接文件包含本机密钥，不应提交或分享。

请求使用 `Authorization: Bearer <token>`，拒绝带 `Origin` 或 `Sec-Fetch-Site` 的浏览器请求：

- `GET /health`：返回协议版本及 `clientReady`；最近 3 秒内界面成功轮询时视为就绪。
- `POST /open`：JSON 字段为 UUID `requestId`、已有绝对目录 `projectPath`、字符串 `prompt`；UTF-8 请求体上限为 8192 字节。
- 界面准备完成后返回会话和工作区 ID；60 秒内未完成返回 504。相同请求 ID 和内容共享结果，不同内容重用 ID 返回 409。

内部接口名 `dshIdeBridge` 和连接目录名 `ide-bridge` 为兼容标识。最近 128 个请求保留幂等记录，最多同时等待 8 个请求；领取锁定到单个界面，避免重复创建会话。界面使用原生工作区、会话与输入框 API，没有调用模型消息提交接口。

## 许可证

[MIT](LICENSE)
