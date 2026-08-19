# -*- coding: utf-8 -*-
"""生成初音未来风格应用图标: build/icon.png(512) + build/icon.ico(16/32/48/64/128/256)
Q 版大头: 蓝青色双马尾 + M 形刘海 + 大蓝眼 + 白色上衣
"""
from PIL import Image, ImageDraw
import os

S = 512
IMG = Image.new('RGBA', (S, S), (0, 0, 0, 0))
D = ImageDraw.Draw(IMG)

# 配色
SKIN   = (255, 227, 211, 255)   # 肤色
SKIN_D = (241, 205, 189, 255)   # 阴影
HAIR   = (25, 197, 216, 255)    # 初音发色 teal
HAIR_D = (16, 143, 171, 255)    # 深 teal(发尾/后发)
HAIR_DK= (10, 86, 110, 255)     # 最深(眼线前发间)
EYE_B  = (35, 174, 240, 255)    # 眼蓝
EYE_P  = (30, 63, 150, 255)     # 瞳孔深蓝
WHITE  = (255, 255, 255, 255)
BLUE_L = (70, 130, 255, 255)

def R(cx, cy, rw, rh, fill): D.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=fill)

# ---- 双马尾(先画在身后) 左 ----
D.polygon([(150, 190), (95, 250), (75, 360), (90, 440), (130, 470), (150, 430), (140, 300), (175, 230)], fill=HAIR)
R(100, 420, 42, 46, HAIR_D)                       # 发尾深色段
# 右
D.polygon([(362, 190), (417, 250), (437, 360), (422, 440), (382, 470), (362, 430), (372, 300), (337, 230)], fill=HAIR)
R(412, 420, 42, 46, HAIR_D)

# ---- 脑后后发(包住头的上部) ----
R(256, 168, 165, 150, HAIR)

# ---- 脖子 + 上衣 ----
D.polygon([(242, 350), (270, 350), (278, 405), (234, 405)], fill=SKIN)
D.rounded_rectangle([196, 400, 316, 500], radius=28, fill=WHITE)
D.line([256, 400, 256, 500], fill=BLUE_L, width=6)     # 衣领中线
D.rectangle([222, 424, 236, 472], fill=BLUE_L)         # 领结左
D.rectangle([276, 424, 290, 472], fill=BLUE_L)
D.ellipse([234, 428, 246, 470], fill=BLUE_L)
D.ellipse([266, 428, 278, 470], fill=BLUE_L)

# ---- 头 ----
R(256, 225, 138, 132, SKIN)

# ---- 刘海(M 形, 三段) ----
D.polygon([(118, 205), (168, 120), (196, 178), (160, 212)], fill=HAIR)
D.polygon([(394, 205), (344, 120), (316, 178), (352, 212)], fill=HAIR)
# 中间两缕(向下发的长刘海)
D.polygon([(196, 178), (236, 128), (256, 152), (224, 210)], fill=HAIR)
D.polygon([(316, 178), (276, 128), (256, 152), (288, 210)], fill=HAIR)
# 侧发(垂到脸两侧)
D.polygon([(140, 200), (120, 260), (150, 300), (190, 270), (205, 235)], fill=HAIR)
D.polygon([(372, 200), (392, 260), (362, 300), (322, 270), (307, 235)], fill=HAIR)
# 顶部圆润
D.polygon([(160, 130), (256, 92), (352, 130), (316, 150), (256, 122), (196, 150)], fill=HAIR)
R(256, 118, 120, 40, HAIR)

# ---- 眼(大蓝眼 + 瞳孔 + 高光) ----
def eye(cx):
    R(cx, 268, 22, 30, EYE_B)
    D.ellipse([cx - 10, 272, cx + 10, 292], fill=EYE_P)      # 瞳孔(下)
    R(cx - 7, 258, 6, 9, WHITE)                               # 上高光
    R(cx + 6, 282, 5, 8, WHITE)                               # 下小反光
    # 眼线
    D.arc([cx - 25, 236, cx + 25, 300], 200, 340, fill=HAIR_DK, width=4)
    D.line([cx - 24, 290, cx + 24, 290], fill=HAIR_DK, width=3)
eye(206)
eye(306)

# ---- 眉 + 嘴 + 腮红 ----
D.arc([182, 214, 230, 240], 190, 350, fill=HAIR_DK, width=5)   # 左眉
D.arc([282, 214, 330, 240], 190, 350, fill=HAIR_DK, width=5)   # 右眉
D.arc([232, 308, 280, 330], 20, 160, fill=(200, 110, 130, 235), width=4)  # 嘴微笑
R(178, 320, 14, 8, (250, 170, 170, 140))                       # 腮红
R(334, 320, 14, 8, (250, 170, 170, 140))

# ---- 刘海遮脑门区域后加一层高光 ----
D.arc([196, 108, 316, 168], 180, 360, fill=(140, 240, 250, 110), width=7)

# ==== 输出 ====
os.makedirs('build', exist_ok=True)
IMG.save('build/icon.png')
sizes = [256, 128, 64, 48, 32, 16]
imgs = [IMG.resize((s, s), Image.LANCZOS) for s in sizes]
imgs[0].save('build/icon.ico', format='ICO', sizes=[(s, s) for s in sizes])
print('已生成 build/icon.png (512) 与 build/icon.ico (', ', '.join(map(str, sizes)), ')')
