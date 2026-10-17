#!/bin/bash
# usage: cap.sh name url
n=$1; u=$2; out=/workspace/domain-trading/system/lander-examples
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --user-agent="$UA" --virtual-time-budget=15000 --window-size=1366,2200 --screenshot="$out/$n.png" "$u" >/dev/null 2>&1
timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --user-agent="$UA" --virtual-time-budget=15000 --dump-dom "$u" > "$out/$n.html" 2>/dev/null
echo "$n $(stat -c %s $out/$n.png 2>/dev/null) $(stat -c %s $out/$n.html)"
