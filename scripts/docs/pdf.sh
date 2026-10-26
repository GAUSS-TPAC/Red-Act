#!/usr/bin/env bash
# Génère les versions PDF des livrables dans docs/pdf/ à partir des Markdown de docs/.
#
#   scripts/docs/pdf.sh                    # HTML puis PDF (pandoc + Google Chrome sans interface)
#   scripts/docs/pdf.sh --html-seulement D # s'arrête aux pages HTML, écrites dans le dossier D
#   AUTEUR="Prénom Nom" scripts/docs/pdf.sh
#
# Outils de documentation seulement (rien n'est ajouté au projet) : pandoc ≥ 2.9,
# python3 + PyYAML (API HTTP tirée de docs/openapi.yaml), Google Chrome ou Chromium.
# Les images des diagrammes (docs/diagrammes/*.png) sont rendues depuis les sources
# Mermaid *.mmd, par exemple : npx -y @mermaid-js/mermaid-cli@10.9.1 -i 01-architecture.mmd -o 01-architecture.png -s 2
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
HTML_ONLY=""
if [ "${1:-}" = "--html-seulement" ]; then HTML_ONLY="${2:?dossier attendu}"; mkdir -p "$HTML_ONLY"; fi
BUILD="${HTML_ONLY:-$(mktemp -d)}"
DATE="${DATE:-$(LC_ALL=fr_FR.UTF-8 date '+%-d %B %Y' 2>/dev/null || date '+%Y-%m-%d')}"
mkdir -p docs/pdf

# Prépare un Markdown : retire le titre de niveau 1 (il va sur la page de garde) et
# ajoute la ligne vide que pandoc exige avant une liste collée à un paragraphe
# (GitHub s'en passe, les sources sont écrites ainsi).
prepare() {
  python3 - "$1" "$2" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
text = re.sub(r"\A# .*\n", "", text, count=1)
item = re.compile(r"^(\s*)([-*]|\d+\.)\s")
out, fence = [], False
for line in text.split("\n"):
    if line.startswith("```"):
        fence = not fence
    prev = out[-1] if out else ""
    if (not fence and item.match(line) and prev.strip() and not item.match(prev)
            and not prev.startswith((" ", "|", ">"))):
        out.append("")
    out.append(line)
open(dst, "w", encoding="utf-8").write("\n".join(out))
PY
}

# Page de garde (logo de l'ENSPY) et en-tête/pied de page propres à un document.
# couverture <titre> <sous-titre> <fichier de sortie>
couverture() {
  TITRE="$1" SOUS_TITRE="$2" DATE="$DATE" AUTEUR="${AUTEUR:-}" python3 - "$3" <<'PY'
import base64, html, os, sys
logo = base64.b64encode(open("docs/assets/logo-enspy.png", "rb").read()).decode()
e = lambda k: html.escape(os.environ.get(k, ""))
auteur = f"<strong>{e('AUTEUR')}</strong><br/>" if os.environ.get("AUTEUR") else ""
titre_css = os.environ["TITRE"].replace("\\", "\\\\").replace('"', '\\"')
open(sys.argv[1], "w", encoding="utf-8").write(f"""<style>
@page {{
  @top-left {{ content: ""; background: url(data:image/png;base64,{logo}) left center / auto 12mm no-repeat; width: 60mm; }}
  @top-right {{ content: "{titre_css}"; font: 8.5pt Helvetica, Arial, sans-serif; color: #b85c00; vertical-align: bottom; padding-bottom: 3mm; }}
  @bottom-left {{ content: "ENSPY — Éditeur de documents partagé"; font: 8pt Helvetica, Arial, sans-serif; color: #888; }}
  @bottom-right {{ content: "Page " counter(page) " / " counter(pages); font: 8pt Helvetica, Arial, sans-serif; color: #888; }}
}}
@page :first {{
  @top-left {{ content: none; background: none; }} @top-right {{ content: none; }}
  @bottom-left {{ content: none; }} @bottom-right {{ content: none; }}
}}
</style>
<section class="couverture">
  <img class="logo" src="data:image/png;base64,{logo}" alt="ENSPY"/>
  <div class="ecole">École Nationale Supérieure Polytechnique de Yaoundé<span>Université de Yaoundé I</span></div>
  <div class="bandeau">
    <div class="projet">Projet évalué — application déployée sur AWS</div>
    <h1 class="titre">{e('TITRE')}</h1>
    <p class="sous-titre">{e('SOUS_TITRE')}</p>
  </div>
  <div class="meta">{auteur}Éditeur de documents partagé pour le journal d'une association étudiante<br/>{e('DATE')}</div>
</section>
""")
PY
}

# html <nom> <titre> <sous-titre> <fichier.md>…
html() {
  local name="$1" title="$2" subtitle="$3"; shift 3
  local parts=()
  for f in "$@"; do
    local tmp="$BUILD/$name-$(basename "$f")"
    prepare "$f" "$tmp"
    parts+=("$tmp")
  done
  couverture "$title" "$subtitle" "$BUILD/$name-couverture.html"
  pandoc "${parts[@]}" -f markdown -t html5 -s --toc --toc-depth=2 \
    --self-contained --resource-path="docs:$ROOT" \
    --css="scripts/docs/pdf.css" --include-before-body="$BUILD/$name-couverture.html" \
    --metadata pagetitle="$title" --metadata lang=fr -o "$BUILD/$name.html"
  echo "  $BUILD/$name.html"
}

python3 scripts/docs/openapi_vers_md.py docs/openapi.yaml > "$BUILD/api-http.md"

echo "Pages HTML :"
html dossier-conception "Dossier de conception" "Architecture, choix et justifications, limites assumées" docs/dossier-conception.md
html rapport-test "Rapport de test" "Méthode, objectifs, résultats bruts, analyse et preuve des deux exigences éliminatoires" docs/rapport-test.md
html api "Description de l'API" "API HTTP (OpenAPI) et protocole temps réel (WebSocket /collab)" "$BUILD/api-http.md" docs/api-temps-reel.md
html cout "Preuve de coût" "Choix, estimation et relevé de facturation AWS" docs/cout.md
html readme "Déployer, tester, supprimer" "Guide du dépôt (README)" README.md

[ -n "$HTML_ONLY" ] && exit 0

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROME" ] || { echo "Chrome/Chromium introuvable : ouvrez les pages HTML et imprimez-les en PDF." >&2; exit 1; }
echo "PDF :"
for name in dossier-conception rapport-test api cout readme; do
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$ROOT/docs/pdf/$name.pdf" "file://$BUILD/$name.html" 2>/dev/null
  echo "  docs/pdf/$name.pdf"
done
