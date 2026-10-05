# -*- coding: utf-8 -*-
"""
成步堂立绘抠图
==============
输入：官方彩色立绘（白底 + 右下角「异议！」气泡 + 底部木栏）
输出：透明背景 PNG，只保留人物主体

策略：
  1. 算「非白程度」dist，取 dist >= 阈值 的像素作为前景候选
  2. 从人物躯干种子点做 8 邻域洪水填充 → 只保留人物主体连通块
     （右下角「异议！」气泡与人物物理分离，自动排除）
  3. 逐列检测底部木栏（棕色区域）的上边界，生成斜线遮罩切掉木栏
  4. 边缘 alpha 羽化 + dist 修正，消除白边
  5. 裁掉四周透明留白
"""
import sys
from collections import deque
from PIL import Image, ImageFilter
import numpy as np

SRC = sys.argv[1]
DST = sys.argv[2]
ERODE_BORDER = int(sys.argv[3]) if len(sys.argv) > 3 else 6   # 强制清空的边缘像素数

img = Image.open(SRC).convert("RGB")
W, H = img.size
a = np.asarray(img).astype(np.float32)
print(f"输入尺寸: {W} x {H}")

# ---------- 1. 非白程度 ----------
dist = np.sqrt(((255.0 - a) ** 2).sum(axis=2))
print(f"距离统计: p50={np.percentile(dist, 50):.1f} p90={np.percentile(dist, 90):.1f}")

FG_TOL = 34          # 提高阈值，避免 JPEG 灰白噪点被判成前景
cand = dist >= FG_TOL
print(f"前景候选占比: {cand.sum() / (W * H) * 100:.1f}%")

# ---------- 2. 种子点洪水填充 ----------
seed_x, seed_y = int(W * 0.35), int(H * 0.55)
if not cand[seed_y, seed_x]:
    done = False
    for r in range(1, 150):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                ny, nx = seed_y + dy, seed_x + dx
                if 0 <= ny < H and 0 <= nx < W and cand[ny, nx]:
                    seed_y, seed_x, done = ny, nx, True
                    break
            if done:
                break
        if done:
            break
print(f"种子点: ({seed_x}, {seed_y})")

main = np.zeros((H, W), dtype=bool)
q = deque([(seed_y, seed_x)])
main[seed_y, seed_x] = True
while q:
    y, x = q.popleft()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and not main[ny, nx] and cand[ny, nx]:
                main[ny, nx] = True
                q.append((ny, nx))
print(f"人物连通块占比: {main.sum() / (W * H) * 100:.1f}%")

# ---------- 3. 逐列检测木栏上边界（木栏是斜的） ----------
rgb = np.asarray(img).astype(np.int16)
is_brown = (
    (rgb[:, :, 0] > rgb[:, :, 2] + 30)
    & (rgb[:, :, 0] > 80)
    & (rgb[:, :, 0] < 215)
)

rail_top = np.full(W, H, dtype=np.int32)     # 每列木栏上边界，默认无木栏
# 只在底部 25% 区域内搜索（木栏一定在这一带），避免被画面最底部的阴影干扰
SEARCH_TOP = int(H * 0.75)
for x in range(W):
    seg = is_brown[SEARCH_TOP:, x]
    idx = np.nonzero(seg)[0]
    if len(idx) > 0:
        rail_top[x] = SEARCH_TOP + int(idx[0]) - 6   # 上抬 6px，吃掉木栏顶边的深红描边

# 对木栏上边界做中值平滑，避免噪声
valid = rail_top < H
if valid.sum() > 0:
    med = int(np.median(rail_top[valid]))
    print(f"木栏上边界中位数 y={med}（{med/H*100:.1f}%），有效列 {valid.sum()}/{W}")

# 生成木栏遮罩：y >= rail_top[x] 的像素算木栏
yy = np.arange(H).reshape(-1, 1)
rail_mask = yy >= rail_top.reshape(1, -1)

# 木栏只可能在画面底部，加个高度保护
rail_mask[:int(H * 0.72), :] = False

removed = (main & rail_mask).sum()
main = main & ~rail_mask
print(f"已切除木栏像素: {removed}")

# ---------- 3b. 收尾清理 ----------
# 3b-1. 逐列：把底部的「孤悬细线」切掉。
#       人物下摆是有厚度的实心块，若某列底部只剩很窄的一条，说明是残留描边。
for x in range(W):
    col = np.nonzero(main[:, x])[0]
    if len(col) == 0:
        continue
    # 从底部往上，统计连续前景厚度
    y_end = col[-1]
    y = y_end
    while y >= 0 and main[y, x]:
        y -= 1
    thickness = y_end - y
    if thickness <= 3:
        main[y + 1: y_end + 1, x] = False

# 3b-2. 去掉极小的孤立连通块（噪点）
#       用简单的面积过滤：标记所有连通块，只保留最大的那个
lab = np.zeros((H, W), dtype=np.int32)
cur = 0
for sy in range(0, H, 3):
    for sx in range(0, W, 3):
        if main[sy, sx] and lab[sy, sx] == 0:
            cur += 1
            q2 = deque([(sy, sx)])
            lab[sy, sx] = cur
            size = 0
            while q2:
                y, x = q2.popleft()
                size += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < H and 0 <= nx < W and main[ny, nx] and lab[ny, nx] == 0:
                            lab[ny, nx] = cur
                            q2.append((ny, nx))
            if size < 400:                 # 小于 400 像素的碎块视为噪点
                main[lab == cur] = False
print(f"清理后人物占比: {main.sum() / (W * H) * 100:.1f}%")

# 3b-3. 强制清空图像四周的边缘杂点。
#       抠图后四边若残留像素，贴到版面上会形成一圈「灰框」。
if ERODE_BORDER > 0:
    b = ERODE_BORDER
    main[:b, :] = False
    main[-b:, :] = False
    main[:, :b] = False
    main[:, -b:] = False
    print(f"已清空四周 {b}px 边缘")

# ---------- 4. alpha 羽化 + 强效压白边 ----------
alpha = np.where(main, 255, 0).astype(np.uint8)

# 4a. 先向内收缩 1px（MinFilter = 腐蚀），切掉最外圈「半人半白」的过渡像素。
#     这一步是消除白边的关键：原图抗锯齿像素是人物色与白色的混合，
#     直接保留就会在白底看正常、在深底看发白。
a_img = Image.fromarray(alpha, mode="L")
a_img = a_img.filter(ImageFilter.MinFilter(3))

# 4b. 轻微模糊，让锯齿边缘平滑（收缩后再模糊，边缘才不会发白）
a_img = a_img.filter(ImageFilter.GaussianBlur(0.8))
alpha2 = np.asarray(a_img).astype(np.float32)

# 4c. 对半透明过渡区用 dist 修正：越接近白越透明
transition = (alpha2 > 8) & (alpha2 < 248)
t = np.clip((dist - 30.0) / 40.0, 0, 1) * 255.0   # 减去 30 的基底，更激进地压白
alpha2[transition] = np.minimum(alpha2[transition], t[transition])

alpha2[alpha2 < 16] = 0
alpha2 = np.clip(alpha2, 0, 255).astype(np.uint8)

# 4d. 边缘颜色去白：对剩余半透明像素，把偏白的颜色往邻近前景色拉，
#     从根上消除「白雾」。做法：对 RGB 做一次「去白」——
#     把接近白的颜色按 alpha 反推回原色。
rgb_f = np.asarray(img).astype(np.float32)
af = alpha2.astype(np.float32) / 255.0
edge = (af > 0) & (af < 0.98)
if edge.any():
    # 观测色 = 真色*a + 白*(1-a)  =>  真色 = (观测色 - 255*(1-a)) / a
    a_e = af[edge][:, None]
    obs = rgb_f[edge]
    true = (obs - 255.0 * (1.0 - a_e)) / np.maximum(a_e, 0.05)
    rgb_f[edge] = np.clip(true, 0, 255)
rgb_out = rgb_f.astype(np.uint8)

# ---------- 5. 合成 + 裁剪 ----------
out_img = Image.fromarray(np.dstack([rgb_out, alpha2]), mode="RGBA")

# 用「较高 alpha」区域算 bbox，忽略边缘残留的低 alpha 杂点，
# 否则 bbox 会退化成整幅图，贴到版面上就是一整块带白雾的方块。
solid = (alpha2 >= 128).astype(np.uint8) * 255
ys, xs = np.nonzero(solid)
if len(xs) > 0:
    pad = 2
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(W, int(xs.max()) + 1 + pad)
    y1 = min(H, int(ys.max()) + 1 + pad)
    out_img = out_img.crop((x0, y0, x1, y1))
    print(f"裁剪: ({x0},{y0}) -> ({x1},{y1})")

print(f"最终尺寸: {out_img.size[0]} x {out_img.size[1]}")

out_img.save(DST)
print(f"已保存: {DST}")
