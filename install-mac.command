#!/bin/bash
# PAL Data Sorter — macOS installer.
# Double-click this file. It checks for Python 3, then puts a
# "PAL Data Sorter" launcher on your Desktop that starts the app and opens it
# in your browser. Nothing to install if Python 3 is already present (it ships
# with macOS developer tools and most Macs already have it).

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "======================================================"
echo "  PAL Data Sorter — setup"
echo "======================================================"
echo

# --- find Python 3 -----------------------------------------------------
PYBIN=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import sys; exit(0 if sys.version_info[0]==3 else 1)' 2>/dev/null; then
      PYBIN="$(command -v "$c")"; break
    fi
  fi
done

if [ -z "$PYBIN" ]; then
  echo "Python 3 was not found on this Mac."
  echo
  echo "The quickest fix is to run this in Terminal (it triggers Apple's"
  echo "developer tools install, which includes Python 3):"
  echo
  echo "    xcode-select --install"
  echo
  echo "…or download it from https://www.python.org/downloads/macos/"
  echo "Then double-click this installer again."
  echo
  read -n 1 -s -r -p "Press any key to open the Python download page and close…"
  open "https://www.python.org/downloads/macos/" || true
  exit 1
fi
echo "Found Python: $PYBIN"

# --- create the Desktop launcher --------------------------------------
LAUNCHER="$HOME/Desktop/PAL Data Sorter.command"
cat > "$LAUNCHER" <<LAUNCH
#!/bin/bash
# Launches PAL Data Sorter. You can double-click this any time.
cd "$APP_DIR"
echo "Starting PAL Data Sorter — a browser tab will open shortly."
echo "Keep this window open while you use the app; close it or press Ctrl+C to quit."
exec "$PYBIN" serve.py --open
LAUNCH
chmod +x "$LAUNCHER"

echo
echo "Done. A 'PAL Data Sorter' launcher is on your Desktop."
echo "Double-click it whenever you want to open the app."
echo
read -n 1 -s -r -p "Press any key to launch it now…"
echo
open "$LAUNCHER"
