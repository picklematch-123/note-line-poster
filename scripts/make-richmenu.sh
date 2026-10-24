#!/bin/sh
# リッチメニュー画像を HTML から書き出す（macOS + Google Chrome）。
# 文字は HTML で描くので崩れず、画像生成の費用もかからない。
# 使い方: sh scripts/make-richmenu.sh
#
# ★書き出し先は版付きの名前（-v2）。旧名の assets/richmenu.png / richmenu-setup.png は
#   古いコードのまま動いている環境が Public から取りに来るので、旧デザインのまま残す（上書きしない）。
#   デザインを変えるときは v3 を足し、src/core/line/richmenu.ts の MENU_IMAGE_FILES と
#   scripts/build-template.mjs の REQUIRED_FILES も合わせる（2026-10 P4-2 源蔵レビュー必須1）
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC="$PWD/scripts/richmenu-src"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=2500,1686 --screenshot="$PWD/assets/richmenu-v2.png" "file://$SRC/menu.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=2500,843 --screenshot="$PWD/assets/richmenu-setup-v2.png" "file://$SRC/setup.html"
# LINE の上限（1MB）に収めるため、色数を絞る（グラデーションは誤差拡散で滑らかに保つ）
python3 - <<'PY'
from PIL import Image
for f in ('assets/richmenu-v2.png', 'assets/richmenu-setup-v2.png'):
    im = Image.open(f).convert('RGB')
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(f, optimize=True)
PY
ls -l assets/richmenu*.png
