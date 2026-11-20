# CodieGameBuddy 源码包 0.1.17

本包包含当前工作区应用源码及配套 codie_host。两个项目目录必须保持同级。
SOURCE-MANIFEST.json 记录基础提交、本地改动、未包含的未跟踪文件和每个文件的 SHA-256。
应用源码含本地尚未提交的改动；它们已包含在此压缩包中，并非仅打包基础提交。
不包含 node_modules、旧构建产物、配对数据或本地私有目录。

## 在 Windows 构建

需要 Node.js 20+ 与 Git。在 PowerShell 中运行：

```powershell
cd codie_host
npm ci
cd ../codie_game_buddy
npm ci
npm test
npx playwright test
npm run dist
```

产物为 codie_game_buddy/dist/CodieGameBuddySetup-0.1.17.exe。
如 Electron 下载失败，可设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/，再运行 node node_modules/electron/install.js。
界面测试使用隔离配置和模拟设备；运行测试前退出真实应用，避免快捷键被占用。
安装包自带 Electron 与 codie_host，用户无需安装 Node.js；当前安装包未签名。
本次只生成本地应用安装包和源码包，未向应用更新源上传。
