# Prism · 典藏卡编辑器

Prism 是一款本机制卡工具。创作者可以从模板或空白开始，编辑正反面图层，为指定区域叠加闪光、烫金、白墨或光油效果，再查看成品并导出。

## 界面预览

![Prism 编辑工作台](docs/screenshots/editor.png)

| 成品预览 | 印刷文件导出 |
| --- | --- |
| [查看闪光效果截图](docs/screenshots/preview.png) | [查看印前检查和技术打样文件截图](docs/screenshots/print.png) |

### 走一遍制卡流程

1. 在「我的卡牌」新建项目，选择「潮汐档案」模板。
2. 在工作台更换主图、编辑卡名。进入「效果」，选择闪光样式或给指定区域添加工艺。
3. 打开「成品预览」，移动指针查看反光。用左右方向键切换正反面。
4. 返回工作台，导出 PNG、JPEG、可重新编辑的项目包或技术打样包。

项目保存到本机 SQLite。关闭浏览器后，可以从「我的卡牌」继续编辑。印刷文件目前适合技术打样和印厂核对。

## 历史版本

`main` 用于持续开发。以下版本各自保留当时的源码、截图和运行说明。

- [v0.1.2](https://github.com/mzh2775407121-netizen/prism-card-studio/tree/versions/v0.1.2) · 增加 Mac 启动入口，修复直接打开 HTML 时的空白页。
- [v0.1.1](https://github.com/mzh2775407121-netizen/prism-card-studio/tree/versions/v0.1.1) · 统一 Prism 编辑器命名，迁移源码目录。
- [v0.1.0](https://github.com/mzh2775407121-netizen/prism-card-studio/tree/versions/v0.1.0) · 首次公开版本。

## 本机运行

Mac 上双击仓库根目录的「启动 Prism.command」。服务运行期间请保留终端窗口，编辑器会在浏览器中打开。首次运行需要安装下列依赖。

需要 Node.js 22、pnpm 和 Python 3.12。从仓库根目录执行以下命令。

```sh
cd editor
pnpm install --frozen-lockfile
pnpm build
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py --data-dir .data
```

打开 [http://127.0.0.1:4174/](http://127.0.0.1:4174/)。按上述命令启动时，项目数据库在 `editor/.data/`。更多说明见 [运行和项目数据](editor/README.md)。图片、字体和卡册纹理的来源见 [素材来源](editor/public/assets/assets-sources.txt) 和 [卡册素材来源](editor/public/assets/album/来源.txt)。
