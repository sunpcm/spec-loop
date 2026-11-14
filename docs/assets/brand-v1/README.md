# Spec Loop 品牌资产 v1

**让需求走到交付。**

以用户选定的“折角文档连续转成产品”图形为依据，制作统一的 SVG 母版和配套资产。主 Logo 保留蓝色到薄荷绿的渐变及折角层次；简化 Icon 使用两种纯色，并将细小尖端圆钝化。

[打开完整预览](preview.html) · [查看套图总览](preview/brand-overview.png) · [下载素材包](../spec-loop-brand-kit-v1.zip)

## 资产索引

| 用途 | 文件 | 说明 |
| --- | --- | --- |
| SVG 母版 | [source/logo-master.svg](source/logo-master.svg) | 可缩放的矢量复绘母版；原始选定图另存为 [selected-reference.jpg](source/selected-reference.jpg) |
| 主 Logo | [logo/logo-gradient.svg](logo/logo-gradient.svg)、[PNG](logo/logo-gradient.png) | PNG 为 2000×1360，透明背景 |
| 平面版 | [logo/logo-flat.svg](logo/logo-flat.svg)、[PNG](logo/logo-flat.png) | 两种纯色 |
| 单色版 | [深蓝](logo/logo-mono-navy.svg)、[白色](logo/logo-mono-white.svg) | 透明背景；白色版适用于深色底 |
| 背景适配 | [浅色](logo/logo-on-light.png)、[深色](logo/logo-on-dark.png) | 深色版提高蓝色亮度，便于辨认 |
| 简化 Icon | [icon/icon.svg](icon/icon.svg)、[512px PNG](icon/icon-512.png) | 另含 16、32、48、64、128、180、192、256、1024px 透明 PNG |
| 浏览器图标 | [favicon.svg](icon/favicon.svg)、[favicon.ico](icon/favicon.ico) | SVG 随深浅主题切换；ICO 内含 16/32/48px 单色图标 |
| 触屏图标 | [apple-touch-icon.png](icon/apple-touch-icon.png) | 180×180，实色背景 |
| 头像 | [浅色](icon/avatar-light.png)、[深色](icon/avatar-dark.png) | 1024×1024，保留安全边距 |
| 名称组合 | [横版浅色](lockup/horizontal-light.svg)、[横版深色](lockup/horizontal-dark.svg) | 图形＋Spec Loop＋中文 slogan，另附 PNG |
| 竖版组合 | [浅色](lockup/vertical-light.svg)、[深色](lockup/vertical-dark.svg) | 1000×1000，另附 PNG |
| README 横幅 | [浅色](social/readme-banner-light.png)、[深色](social/readme-banner-dark.png) | 1200×400，另附 SVG |
| 分享封面 | [浅色](social/share-card-light.png)、[深色](social/share-card-dark.png) | 1200×630，适用于链接分享或项目介绍，另附 SVG |
| 主 Logo 动图 | [浅色 GIF](motion/logo-loop-light.gif)、[深色 GIF](motion/logo-loop-dark.gif) | 768×512，20fps，96 帧，4.8 秒无限循环 |
| Icon 动图 | [icon-loop.gif](motion/icon-loop.gif) | 256×256，4.8 秒无限循环 |
| 矢量动效 | [logo-loop.svg](motion/logo-loop.svg) | 透明背景；系统选择减少动态效果时显示静态标志 |
| 动效分镜 | [motion-storyboard.png](preview/motion-storyboard.png) | 文档形成 → 连续转化 → 产品成形 → 完整标志停留 |
| 色板 | [source/palette.json](source/palette.json) | 品牌色与深浅背景色 |
| 生成记录 | [source/prompts.txt](source/prompts.txt) | 内置 imagegen 的 Icon 简化提示词和导出说明 |

## 使用约定

- 小于等于 64px 优先使用简化 Icon。16～32px 的极小场景可以使用 favicon 的单色版。
- 主标志保持原始比例；四周至少保留一个笔画宽度的空白。
- 深色背景使用深色适配版或白色单色版，避免深蓝轮廓融入背景。
- 组合 SVG 中的名称使用 Avenir Next 和无衬线回退字体，中文使用系统无衬线字体；需要固定排版时直接使用配套 PNG。
- 动效表达文档向产品的转化，属于品牌演示素材；它本身不表示任务已完成或产品已部署。
- GIF 为实色背景；需要透明背景与缩放能力时使用矢量动效 SVG，并保留静态 Logo 作为后备。

## 母版与导出

原始选定图、简化 Icon 的 imagegen 参考图和 SVG 母版均保存在 `source/`。SVG 母版是依据定稿图重新绘制的矢量源文件，所有组合图、封面和动效统一从该轮廓导出。

静态位图由 SVG 渲染导出；GIF 使用同一矢量轮廓逐帧显现并经 FFmpeg 编码。品牌资产不改变产品行为、任务状态或部署状态。

资产尺寸、帧数与哈希见 [manifest.json](manifest.json)，实际核验结果见 [verification.json](verification.json)。
