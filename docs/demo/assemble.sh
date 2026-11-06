#!/bin/sh
# Builds public/demo/slides/demo.mp4 and demo.gif from docs/demo/frame-NN.png (run from repo root)
set -e
D=docs/demo; P=public/demo/slides
ffmpeg -y -loglevel error -framerate 1/2.5 -i $D/frame-%02d.png -vf "tpad=stop_mode=clone:stop_duration=1.5,fps=15,format=yuv420p" -c:v libx264 -crf 26 -preset slow -movflags +faststart -an $P/demo.mp4
ffmpeg -y -loglevel error -framerate 1/2.5 -i $D/frame-%02d.png -vf "tpad=stop_mode=clone:stop_duration=1.5,fps=4,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" -loop 0 $P/demo.gif
