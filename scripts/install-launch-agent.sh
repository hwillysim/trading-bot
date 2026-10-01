#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/me.askhenry.jev-trading-bot.plist"
runtime_dir="$HOME/Library/Application Support/JEVTradingBot"
node_bin="$(command -v node)"
install_stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$runtime_dir/rollback-$install_stamp"
[[ -f "$project_dir/web/dist/index.html" ]] || { echo 'Build the dashboard before installing.' >&2; exit 1; }
mkdir -p "$agent_dir" "$runtime_dir/web" "$runtime_dir/data" "$backup_dir"
[[ ! -d "$runtime_dir/src" ]] || ditto "$runtime_dir/src" "$backup_dir/src"
[[ ! -d "$runtime_dir/web/dist" ]] || ditto "$runtime_dir/web/dist" "$backup_dir/web/dist"
[[ ! -f "$agent_file" ]] || cp "$agent_file" "$backup_dir/agent.plist"
launchctl bootout "gui/$(id -u)" "$agent_file" 2>/dev/null || true
if [[ -f "$runtime_dir/data/trading-bot.sqlite" ]]; then
  "$node_bin" --input-type=module - "$runtime_dir/data/trading-bot.sqlite" "$runtime_dir/data/trading-bot-before-$install_stamp.sqlite" <<'JS'
import { DatabaseSync, backup } from 'node:sqlite';
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try {await backup(db,process.argv[3]);} finally {db.close();}
JS
fi
ditto "$project_dir/src" "$runtime_dir/src"
ditto "$project_dir/web/dist" "$runtime_dir/web/dist"
# The running app's credentials may be newer than the checkout's copy.
if [[ -f "$project_dir/.env" && ! -f "$runtime_dir/.env" ]]; then
  cp "$project_dir/.env" "$runtime_dir/.env"
fi
[[ ! -f "$runtime_dir/.env" ]] || chmod 600 "$runtime_dir/.env"
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
launchctl bootstrap "gui/$(id -u)" "$agent_file"
echo "Installed and started $agent_file"
echo "Previous runtime saved in $backup_dir"
