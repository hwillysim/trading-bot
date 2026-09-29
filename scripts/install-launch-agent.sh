#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/me.askhenry.jev-trading-bot.plist"
runtime_dir="$HOME/Library/Application Support/JEVTradingBot"
node_bin="$(command -v node)"
mkdir -p "$agent_dir" "$runtime_dir/web" "$runtime_dir/data"
cp -R "$project_dir/src" "$runtime_dir/"
cp -R "$project_dir/web/dist" "$runtime_dir/web/"
if [[ -f "$project_dir/.env" ]]; then
  cp "$project_dir/.env" "$runtime_dir/.env"
  chmod 600 "$runtime_dir/.env"
fi
if [[ -f "$project_dir/data/trading-bot.sqlite" && ! -f "$runtime_dir/data/trading-bot.sqlite" ]]; then
  cp "$project_dir/data/trading-bot.sqlite" "$runtime_dir/data/trading-bot.sqlite"
fi
cat > "$agent_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>me.askhenry.jev-trading-bot</string>
  <key>ProgramArguments</key><array><string>$node_bin</string><string>--env-file-if-exists=.env</string><string>--experimental-strip-types</string><string>src/index.ts</string></array>
  <key>WorkingDirectory</key><string>$runtime_dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$runtime_dir/data/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$runtime_dir/data/launchd.err.log</string>
</dict></plist>
PLIST
chmod 600 "$agent_file"
launchctl bootout "gui/$(id -u)" "$agent_file" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_file"
echo "Installed and started $agent_file"
