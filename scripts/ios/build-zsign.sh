#!/bin/sh
# Build a reviewed, fixed upstream revision; never track a moving branch.
set -eu
if [ "$(uname -s)" != Linux ]; then
  echo 'Run this build script on Linux.' >&2
  exit 1
fi
prefix=${1:-"$PWD/.local/zsign"}
revision=9299685bab7ef99827e06e5dfda93af747386590
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
git -C "$work" init -q
git -C "$work" fetch -q --depth 1 https://github.com/zhlynn/zsign.git "$revision"
git -C "$work" checkout -q --detach FETCH_HEAD
test "$(git -C "$work" rev-parse HEAD)" = "$revision"
make -s -j2 -C "$work/build/linux" VERSION=1.1.3
install -d "$prefix/bin"
install -m 0755 "$work/bin/zsign" "$prefix/bin/zsign"
echo "Pinned zsign installed at $prefix/bin/zsign"
