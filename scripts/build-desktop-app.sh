#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
app_dir="$project_dir/dist/JEV Trading Bot.app"
mkdir -p "$app_dir/Contents/MacOS"
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>JEV Trading Bot</string>
  <key>CFBundleDisplayName</key><string>JEV Trading Bot</string>
  <key>CFBundleIdentifier</key><string>me.askhenry.jev-trading-bot.dashboard</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>JEV Trading Bot</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
xcrun clang -O2 -fobjc-arc -framework AppKit -framework WebKit "$project_dir/src/desktop/main.m" -o "$app_dir/Contents/MacOS/JEV Trading Bot"
plutil -lint "$app_dir/Contents/Info.plist"
echo "Built $app_dir"
