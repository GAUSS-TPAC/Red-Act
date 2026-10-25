#!/usr/bin/env bash
# Test de charge complet, sur l'instance de la LoadTestStack (eu-north-1) :
#   1. prépare un lien de COPIES exemplaires qui ouvre dans OPENS_IN minutes ;
#   2. lance les 300 rédacteurs, qui écrivent avant, pendant et après le pic ;
#   3. à l'heure d'ouverture, lance le pic de 15 000 visiteurs (k6) ;
#   4. dépose les résultats bruts dans le bucket de résultats.
#   sudo -u ec2-user /opt/charge/run.sh https://xxx.cloudfront.net [COPIES] [OPENS_IN]
set -euo pipefail
# RESULTS_BUCKET, posé par le user data de la LoadTestStack.
[ -f /etc/charge.env ] && . /etc/charge.env
# Des milliers de connexions simultanées (la session SSM ne lit pas limits.d).
ulimit -n 200000 2>/dev/null || ulimit -n "$(ulimit -Hn)"
URL="${1:?usage: run.sh https://xxx.cloudfront.net [copies] [ouverture en minutes]}"
COPIES="${2:-5000}"
OPENS_IN="${3:-12}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$HOME/resultats/$STAMP"
mkdir -p "$OUT"
cd /opt/charge

node prepare.cjs --base-url "$URL" --copies "$COPIES" --opens-in "$OPENS_IN" | tee "$OUT/lien.json"
LINK_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).linkId)' "$OUT/lien.json")"
OPENS_AT="$(node -e 'console.log(Date.parse(JSON.parse(require("fs").readFileSync(process.argv[1])).opensAt))' "$OUT/lien.json")"

# Les rédacteurs écrivent jusqu'à 7 min après l'ouverture (fin du pic + marge).
WRITE_S=$(( (OPENS_AT - $(date +%s%3N)) / 1000 + 420 ))
node writers.cjs --base-url "$URL" --writers 300 --docs 30 --rate 2 --duration "$WRITE_S" --out "$OUT/redacteurs.json" \
  > "$OUT/redacteurs.log" 2>&1 &
WRITERS=$!

WAIT_S=$(( (OPENS_AT - $(date +%s%3N)) / 1000 ))
echo "ouverture dans ${WAIT_S} s (lien $LINK_ID)"
if [ "$WAIT_S" -gt 0 ]; then sleep "$WAIT_S"; fi
k6 run -e BASE_URL="$URL" -e LINK_ID="$LINK_ID" -e OUT="$OUT/pic.json" pic.js | tee "$OUT/pic.txt" || true

wait "$WRITERS" || true
aws s3 cp "$OUT" "s3://$RESULTS_BUCKET/$STAMP/" --recursive --only-show-errors
echo "résultats : s3://$RESULTS_BUCKET/$STAMP/"
